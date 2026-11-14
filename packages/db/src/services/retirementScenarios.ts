import { and, count, eq, max, ne, sql } from "drizzle-orm";
import {
  defaultRunSettings,
  diffPatch,
  isPlainObject,
  RetirementProfileDoc,
  RunSettings,
  upgradeRunSettings,
  type RetirementProfileDocInput,
  type RunSettingsInput,
  type ScenarioSummary,
  type ScenarioView,
} from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { scenario } from "../schema/index.js";
import { auditJsonEqual, PlanError, toAuditJson, writeAudit, type AuditContext } from "./audit.js";
import { auditBefore } from "./retirementProfile.js";
import {
  checkToday,
  freezeScenario,
  isUniqueViolation,
  loadProfile,
  loadScenario,
  MAX_SCENARIOS,
  requireProfile,
  scenarioAuditJson,
  scenarioChanges,
  scenarioOverrides,
  scenarioRunViews,
  scenarioSettings,
  scenarioSummary,
  type PlannerQuery,
  type ScenarioRow,
  type StoredProfile,
} from "./retirementStore.js";

/**
 * Scenarios (docs/design/phase-4/inputs-and-data.md §6.2, decisions 3, 29, 30): a what-if is a
 * minimal RFC 7396 merge patch over the profile document plus its own run settings. The editor
 * sends the full edited document with the profile revision it loaded; the server stores
 * `diffPatch(profile.doc, doc)`, so a value edited back to the profile's leaves the patch and a
 * profile change made meanwhile is never frozen into the scenario (`409 revision_conflict`).
 *
 * Names are unique ignoring case (`409 name_taken`); at most 50 scenarios are not archived
 * (`409 too_many_scenarios`); exactly one is the default, which cannot be archived or deleted
 * (`409 default_scenario`). Every write locks the profile row (which serializes them) and the
 * scenario row, checks `expectedRevision`, bumps `revision` only when something changed and audits
 * entity `scenario` with `{ name, notes, isDefault, archived, position, overrides, settings }`.
 */

function nameTaken(name: string): PlanError {
  return new PlanError(409, "name_taken", `There is already a scenario named "${name}"`);
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80) throw new PlanError(400, "validation", "A scenario's name is 1 to 80 characters");
  return trimmed;
}

function cleanNotes(notes: string | null | undefined): string | null {
  if (notes === undefined || notes === null) return null;
  const trimmed = notes.trim();
  return trimmed === "" ? null : trimmed;
}

function parseSettings(settings: RunSettingsInput): RunSettings {
  const parsed = RunSettings.safeParse(settings);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PlanError(400, "validation", `The run settings are not valid${issue ? ` at ${issue.path.join(".")}: ${issue.message}` : ""}`);
  }
  return parsed.data;
}

/** The patch from the profile's document to `doc` (the full effective document as edited), under the revision check. */
function overridesFrom(profile: StoredProfile, doc: RetirementProfileDocInput, profileRevision: number | undefined): Record<string, unknown> {
  if (profileRevision !== profile.row.revision) {
    throw new PlanError(409, "revision_conflict", `The profile changed since this scenario was loaded (revision ${profile.row.revision}); reload it`);
  }
  const parsed = RetirementProfileDoc.safeParse(doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PlanError(400, "validation", `The scenario's document is not valid${issue ? ` at ${issue.path.join(".")}: ${issue.message}` : ""}`);
  }
  return diffPatch(profile.doc, parsed.data);
}

async function assertNameFree(tx: DbOrTx, name: string, exceptId?: string): Promise<void> {
  const [clash] = await tx
    .select({ id: scenario.id })
    .from(scenario)
    .where(and(sql`lower(${scenario.name}) = lower(${name})`, exceptId === undefined ? undefined : ne(scenario.id, exceptId)))
    .limit(1);
  if (clash) throw nameTaken(name);
}

async function assertRoomForOneMore(tx: DbOrTx): Promise<void> {
  const [row] = await tx.select({ n: count() }).from(scenario).where(eq(scenario.archived, false));
  if ((row?.n ?? 0) >= MAX_SCENARIOS) throw new PlanError(409, "too_many_scenarios", `At most ${MAX_SCENARIOS} scenarios can be open at once; archive one first`);
}

/** `ScenarioView` (§4.8): the scenario resolved now against the stored documents. */
async function scenarioView(db: DbOrTx, q: PlannerQuery, profile: StoredProfile, sc: ScenarioRow): Promise<ScenarioView> {
  const frozen = await freezeScenario(q, profile, sc);
  const changes = scenarioChanges(profile, sc);
  const runs = await scenarioRunViews(db, [sc.id]);
  return {
    ...scenarioSummary(sc, changes.length, runs.get(sc.id), frozen.inputHash ?? null, q.env),
    overrides: scenarioOverrides(sc),
    doc: frozen.doc ?? null,
    changes,
    settings: scenarioSettings(sc),
    issues: frozen.issues,
    inputHash: frozen.inputHash ?? null,
    profileRevision: profile.row.revision,
  };
}

export interface ListScenariosQuery extends PlannerQuery {
  includeArchived?: boolean | undefined;
}

/** Route 7: in list order (position, then name); archived ones only when asked. Empty before a profile exists. */
export async function listScenarios(db: DbOrTx, q: ListScenariosQuery): Promise<ScenarioSummary[]> {
  checkToday(q.today);
  const profile = await loadProfile(db);
  if (profile === undefined) return [];
  const rows = await db
    .select()
    .from(scenario)
    .where(q.includeArchived ? undefined : eq(scenario.archived, false))
    .orderBy(scenario.position, sql`lower(${scenario.name})`, scenario.id);
  const runs = await scenarioRunViews(
    db,
    rows.map((r) => r.id),
  );
  const out: ScenarioSummary[] = [];
  for (const row of rows) {
    const frozen = await freezeScenario(q, profile, row);
    out.push(scenarioSummary(row, scenarioChanges(profile, row).length, runs.get(row.id), frozen.inputHash ?? null, q.env));
  }
  return out;
}

/** Route 9. */
export async function getScenario(db: DbOrTx, id: string, q: PlannerQuery): Promise<ScenarioView> {
  checkToday(q.today);
  const sc = await loadScenario(db, id);
  const profile = await requireProfile(db);
  return scenarioView(db, q, profile, sc);
}

export interface CreateScenarioInput {
  name: string;
  notes?: string | undefined;
  /** Copies that scenario's overrides and settings. */
  copyFromId?: string | undefined;
  /** The full effective document as edited; stored as the patch over the profile's. */
  doc?: RetirementProfileDocInput | undefined;
  /** The profile revision the editor loaded; required with `doc`. */
  profileRevision?: number | undefined;
  settings?: RunSettingsInput | undefined;
}

/**
 * Route 8. `doc` wins over `copyFromId`'s overrides and `settings` over its settings; without
 * either the scenario starts with no overrides and the default settings. A new scenario goes last.
 */
export async function createScenario(db: DbOrTx, input: CreateScenarioInput, q: PlannerQuery, audit: AuditContext): Promise<ScenarioView> {
  checkToday(q.today);
  const name = cleanName(input.name);
  try {
    return await db.transaction(async (tx) => {
      const profile = await requireProfile(tx, { lock: true });
      await assertRoomForOneMore(tx);
      await assertNameFree(tx, name);
      let overrides: Record<string, unknown> = {};
      let settings: RunSettings = defaultRunSettings();
      if (input.copyFromId !== undefined) {
        const source = await loadScenario(tx, input.copyFromId);
        overrides = scenarioOverrides(source);
        settings = upgradeRunSettings(source.settings);
      }
      if (input.doc !== undefined) overrides = overridesFrom(profile, input.doc, input.profileRevision);
      if (input.settings !== undefined) settings = parseSettings(input.settings);
      const [last] = await tx.select({ position: max(scenario.position) }).from(scenario);
      const position = Math.min(10000, (last?.position ?? -1) + 1);
      const [row] = await tx.insert(scenario).values({ name, notes: cleanNotes(input.notes), position, overrides, settings }).returning();
      await writeAudit(tx, { ...audit, entity: "scenario", entityId: row!.id, action: "create", before: null, after: scenarioAuditJson(row!) });
      return scenarioView(tx, q, profile, row!);
    });
  } catch (error) {
    throw isUniqueViolation(error, "scenario_name_idx") ? nameTaken(name) : error;
  }
}

export interface UpdateScenarioInput {
  expectedRevision: number;
  name?: string | undefined;
  notes?: string | null | undefined;
  doc?: RetirementProfileDocInput | undefined;
  profileRevision?: number | undefined;
  settings?: RunSettingsInput | undefined;
  isDefault?: boolean | undefined;
  archived?: boolean | undefined;
  position?: number | undefined;
}

/**
 * Route 10. `isDefault: true` clears the previous default in the same transaction (both rows in
 * the one audit batch); the default cannot be archived, nor stop being the default except by
 * another becoming it, and an archived scenario cannot become it (`409 default_scenario`).
 * Unarchiving counts toward the 50.
 */
export async function updateScenario(db: DbOrTx, id: string, input: UpdateScenarioInput, q: PlannerQuery, audit: AuditContext): Promise<ScenarioView> {
  checkToday(q.today);
  const name = input.name === undefined ? undefined : cleanName(input.name);
  try {
    return await db.transaction(async (tx) => {
      const profile = await requireProfile(tx, { lock: true });
      const sc = await loadScenario(tx, id, { lock: true });
      if (input.expectedRevision !== sc.revision) {
        throw new PlanError(409, "revision_conflict", `The scenario changed since it was loaded (revision ${sc.revision}); reload it`);
      }
      const next = {
        name: name ?? sc.name,
        notes: input.notes === undefined ? sc.notes : cleanNotes(input.notes),
        overrides: input.doc === undefined ? scenarioOverrides(sc) : overridesFrom(profile, input.doc, input.profileRevision),
        settings: input.settings === undefined ? sc.settings : parseSettings(input.settings),
        isDefault: input.isDefault ?? sc.isDefault,
        archived: input.archived ?? sc.archived,
        position: input.position ?? sc.position,
      };
      if (sc.isDefault && !next.isDefault) throw new PlanError(409, "default_scenario", "Make another scenario the default instead");
      if (next.isDefault && next.archived) throw new PlanError(409, "default_scenario", "The default scenario cannot be archived");
      if (name !== undefined && name.toLowerCase() !== sc.name.toLowerCase()) await assertNameFree(tx, name, sc.id);
      if (sc.archived && !next.archived) await assertRoomForOneMore(tx);

      const before = scenarioAuditJson(sc);
      const after = scenarioAuditJson({ ...sc, ...next });
      if (sameAuditView(before, after)) return scenarioView(tx, q, profile, sc);

      if (next.isDefault && !sc.isDefault) {
        const [previous] = await tx.select().from(scenario).where(eq(scenario.isDefault, true)).for("update");
        if (previous !== undefined) {
          const [cleared] = await tx
            .update(scenario)
            .set({ isDefault: false, revision: previous.revision + 1, updatedAt: sql`now()` })
            .where(eq(scenario.id, previous.id))
            .returning();
          await writeAudit(tx, { ...audit, entity: "scenario", entityId: previous.id, action: "update", before: scenarioAuditJson(previous), after: scenarioAuditJson(cleared!) });
        }
      }
      const [row] = await tx
        .update(scenario)
        .set({ ...next, revision: sc.revision + 1, updatedAt: sql`now()` })
        .where(eq(scenario.id, sc.id))
        .returning();
      await writeAudit(tx, { ...audit, entity: "scenario", entityId: sc.id, action: "update", before, after: scenarioAuditJson(row!) });
      return scenarioView(tx, q, profile, row!);
    });
  } catch (error) {
    throw name !== undefined && isUniqueViolation(error, "scenario_name_idx") ? nameTaken(name) : error;
  }
}

/** Two audit views are the same change (key order free: jsonb does not keep it). */
function sameAuditView(a: unknown, b: unknown): boolean {
  return auditJsonEqual(toAuditJson(a), toAuditJson(b));
}

/** Route 11: its runs, series and stored paths cascade; the default is `409 default_scenario`. */
export async function deleteScenario(db: DbOrTx, id: string, audit: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    await requireProfile(tx, { lock: true });
    const sc = await loadScenario(tx, id, { lock: true });
    if (sc.isDefault) throw new PlanError(409, "default_scenario", "The default scenario cannot be deleted; make another the default first");
    await tx.delete(scenario).where(eq(scenario.id, sc.id));
    await writeAudit(tx, { ...audit, entity: "scenario", entityId: sc.id, action: "delete", before: scenarioAuditJson(sc), after: null });
  });
}

export interface RevertScenarioInput {
  auditId: string;
  expectedRevision: number;
}

/**
 * Route 12: re-applies what an audit row of this scenario recorded before its change: the name,
 * the notes, the overrides and the settings (`409 revert_invalid` for a row of another entity or
 * scenario, a creation, or settings that no longer parse). The default flag, the archive flag and
 * the position are list state and stay as they are. Saving is lenient: overrides that no longer
 * apply to the profile are kept and show as `override_invalid`.
 */
export async function revertScenario(db: DbOrTx, id: string, input: RevertScenarioInput, q: PlannerQuery, audit: AuditContext): Promise<ScenarioView> {
  checkToday(q.today);
  const entry = await auditBefore(db, input.auditId);
  const before = entry.before;
  if (entry.entity !== "scenario" || entry.entityId !== id || !isPlainObject(before) || !isPlainObject(before["overrides"]) || typeof before["name"] !== "string") {
    throw new PlanError(409, "revert_invalid", "That history entry is not a change of this scenario");
  }
  let settings: RunSettings;
  try {
    settings = upgradeRunSettings(before["settings"]);
  } catch {
    throw new PlanError(409, "revert_invalid", "The settings recorded in that history entry can no longer be read");
  }
  const notes = typeof before["notes"] === "string" ? before["notes"] : null;
  const name = before["name"];
  try {
    return await db.transaction(async (tx) => {
      const profile = await requireProfile(tx, { lock: true });
      const sc = await loadScenario(tx, id, { lock: true });
      if (input.expectedRevision !== sc.revision) {
        throw new PlanError(409, "revision_conflict", `The scenario changed since it was loaded (revision ${sc.revision}); reload it`);
      }
      if (name.toLowerCase() !== sc.name.toLowerCase()) await assertNameFree(tx, name, sc.id);
      const next = { name, notes, overrides: before["overrides"] as Record<string, unknown>, settings };
      const beforeView = scenarioAuditJson(sc);
      if (sameAuditView(beforeView, scenarioAuditJson({ ...sc, ...next }))) return scenarioView(tx, q, profile, sc);
      const [row] = await tx
        .update(scenario)
        .set({ ...next, revision: sc.revision + 1, updatedAt: sql`now()` })
        .where(eq(scenario.id, sc.id))
        .returning();
      await writeAudit(tx, { ...audit, entity: "scenario", entityId: sc.id, action: "update", before: beforeView, after: scenarioAuditJson(row!) });
      return scenarioView(tx, q, profile, row!);
    });
  } catch (error) {
    throw isUniqueViolation(error, "scenario_name_idx") ? nameTaken(name) : error;
  }
}
