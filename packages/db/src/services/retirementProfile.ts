import { eq, sql } from "drizzle-orm";
import {
  baselineHash,
  BASELINE_STALE_DAYS,
  dayDiff,
  defaultRunSettings,
  diffBaselines,
  effectiveInputsView,
  isPlainObject,
  jsonEqual,
  resolvePlan,
  RetirementProfileDoc,
  upgradeProfileDoc,
  type BaselineChange,
  type BaselinePreviewResponse,
  type BaselineRefreshResponse,
  type IsoDate,
  type PlanIssue,
  type ProfileResponse,
  type RetirementBaseline,
  type RetirementProfileDocInput,
} from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { auditLog, planProfile, scenario } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { baselineAuditJson, computeBaseline } from "./retirementBaseline.js";
import {
  checkToday,
  DEFAULT_SCENARIO_NAME,
  freezeScenario,
  loadDefaultScenario,
  loadProfile,
  resolveContext,
  scenarioAuditJson,
  scenarioSettings,
  type PlannerQuery,
  type ScenarioRow,
  type StoredProfile,
} from "./retirementStore.js";

/**
 * The household profile and its stored baseline (docs/design/phase-4/inputs-and-data.md §6.2,
 * decisions 1, 4, 29, 30, 32): one singleton row (`plan_profile`) holding the versioned profile
 * document and the baseline last computed from live data.
 *
 * - `getProfile`: the stored document, or `exists: false` with a live baseline before a profile
 *   exists; the plan resolved with no overrides and the default scenario's settings; the issues
 *   of every scenario whose plan no longer runs.
 * - `putProfile`: saving is lenient (decision 32): the document is checked for shape only and its
 *   issues are returned. The first save (`expectedRevision: 0`) stores the baseline and creates
 *   the default scenario "Base plan"; later saves bump `revision` only when the document changed.
 * - `revertProfile`: re-applies an audit row's `before`.
 * - `previewBaseline` / `refreshBaseline`: what a refresh from live data would change, and the
 *   refresh itself (stored only when its hash differs; the profile's `revision` is untouched).
 *
 * Every write is one transaction that locks the row `FOR UPDATE` and writes one audit batch, never
 * when nothing changed.
 */

function revisionConflict(expected: number, stored: number): PlanError {
  return new PlanError(409, "revision_conflict", `The profile changed since it was loaded (revision ${stored}, expected ${expected}); reload it`);
}

function parseDoc(doc: RetirementProfileDocInput): RetirementProfileDoc {
  const parsed = RetirementProfileDoc.safeParse(doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PlanError(400, "validation", `The profile document is not valid${issue ? ` at ${issue.path.join(".")}: ${issue.message}` : ""}`);
  }
  return parsed.data;
}

/** The days from the baseline's as-of date to the household's date. */
export function baselineAgeDays(baseline: Pick<RetirementBaseline, "asOf">, today: IsoDate): number {
  return dayDiff(baseline.asOf, today);
}

/** The profile's own plan: the document with no overrides, under the default scenario's settings (§4.8 `ProfileResponse`). */
function resolveProfilePlan(q: PlannerQuery, profile: StoredProfile, baseline: RetirementBaseline, sc: ScenarioRow) {
  return resolvePlan({ doc: profile.doc, baseline, overrides: {}, settings: scenarioSettings(sc) }, resolveContext(q, profile, sc));
}

/**
 * The scenarios that are not archived and whose plan no longer runs, each with the error issues
 * that block it (a profile edit can break a scenario's overrides: inputs case 23).
 */
async function scenarioIssues(db: DbOrTx, q: PlannerQuery, profile: StoredProfile): Promise<ProfileResponse["scenarioIssues"]> {
  const rows = await db.select().from(scenario).where(eq(scenario.archived, false)).orderBy(scenario.position, sql`lower(${scenario.name})`, scenario.id);
  const out: ProfileResponse["scenarioIssues"] = [];
  for (const row of rows) {
    const errors = (await freezeScenario(q, profile, row)).issues.filter((i) => i.severity === "error");
    if (errors.length > 0) out.push({ scenarioId: row.id, name: row.name, issues: errors });
  }
  return out;
}

/** The profile response for the stored row (or the live preview before one exists). */
async function profileResponse(db: DbOrTx, q: PlannerQuery): Promise<ProfileResponse> {
  const profile = await loadProfile(db);
  if (profile === undefined) {
    const baseline = await computeBaseline(db, { today: q.today, now: q.now });
    const ageDays = baselineAgeDays(baseline, q.today);
    return {
      exists: false,
      revision: 0,
      doc: null,
      updatedAt: null,
      baseline,
      baselineStored: false,
      baselineHash: await baselineHash(baseline),
      baselineAgeDays: ageDays,
      baselineStale: ageDays > BASELINE_STALE_DAYS,
      effective: null,
      issues: [],
      scenarioIssues: [],
      defaultScenarioId: null,
    };
  }
  const sc = await loadDefaultScenario(db);
  const resolved = resolveProfilePlan(q, profile, profile.baseline, sc);
  const ageDays = baselineAgeDays(profile.baseline, q.today);
  return {
    exists: true,
    revision: profile.row.revision,
    doc: profile.doc,
    updatedAt: profile.row.updatedAt.toISOString(),
    baseline: profile.baseline,
    baselineStored: true,
    baselineHash: profile.row.baselineHash,
    baselineAgeDays: ageDays,
    baselineStale: ageDays > BASELINE_STALE_DAYS,
    effective: resolved.effective === undefined ? null : effectiveInputsView(resolved.effective),
    issues: resolved.issues,
    scenarioIssues: await scenarioIssues(db, q, profile),
    defaultScenarioId: sc.id,
  };
}

/** Route 2: the profile, or `exists: false` with a live baseline (computed, not stored). Writes nothing. */
export async function getProfile(db: DbOrTx, q: PlannerQuery): Promise<ProfileResponse> {
  checkToday(q.today);
  return profileResponse(db, q);
}

export interface PutProfileQuery extends PlannerQuery {
  doc: RetirementProfileDocInput;
  /** 0 creates the profile. */
  expectedRevision: number;
}

async function createProfile(tx: DbOrTx, q: PlannerQuery, doc: RetirementProfileDoc, audit: AuditContext): Promise<void> {
  const baseline = await computeBaseline(tx, { today: q.today, now: q.now });
  const hash = await baselineHash(baseline);
  // A concurrent first save waits on the primary key here, then inserts nothing.
  const inserted = await tx
    .insert(planProfile)
    .values({ id: 1, schemaVersion: doc.schemaVersion, doc, revision: 1, baseline, baselineAsOf: baseline.asOf, baselineHash: hash })
    .onConflictDoNothing()
    .returning({ id: planProfile.id });
  if (inserted.length === 0) throw revisionConflict(0, 1);
  const [sc] = await tx.insert(scenario).values({ name: DEFAULT_SCENARIO_NAME, isDefault: true, position: 0, overrides: {}, settings: defaultRunSettings() }).returning();
  await writeAudit(tx, { ...audit, entity: "plan_profile", entityId: "1", action: "create", before: null, after: { doc } });
  await writeAudit(tx, { ...audit, entity: "plan_baseline", entityId: "1", action: "create", before: null, after: baselineAuditJson(baseline) });
  await writeAudit(tx, { ...audit, entity: "scenario", entityId: sc!.id, action: "create", before: null, after: scenarioAuditJson(sc!) });
}

/** Store `doc` over the locked profile when it differs: `revision + 1` and one `update` audit row. */
async function writeDoc(tx: DbOrTx, current: StoredProfile, doc: RetirementProfileDoc, audit: AuditContext): Promise<void> {
  if (jsonEqual(current.doc, doc)) return;
  await tx
    .update(planProfile)
    .set({ doc, schemaVersion: doc.schemaVersion, revision: current.row.revision + 1, updatedAt: sql`now()` })
    .where(eq(planProfile.id, 1));
  await writeAudit(tx, { ...audit, entity: "plan_profile", entityId: "1", action: "update", before: { doc: current.doc }, after: { doc } });
}

/**
 * Route 3. One transaction: lock the row; check the revision (`409 revision_conflict`); the first
 * write (`expectedRevision: 0`) computes and stores the baseline and inserts the default scenario
 * "Base plan" (default settings, no overrides), auditing `plan_profile`, `plan_baseline` and
 * `scenario` in one batch; a later write bumps `revision` only when the document changed.
 */
export async function putProfile(db: DbOrTx, q: PutProfileQuery, audit: AuditContext): Promise<ProfileResponse> {
  checkToday(q.today);
  const doc = parseDoc(q.doc);
  return db.transaction(async (tx) => {
    const current = await loadProfile(tx, { lock: true });
    if (current === undefined) {
      if (q.expectedRevision !== 0) throw revisionConflict(q.expectedRevision, 0);
      await createProfile(tx, q, doc, audit);
    } else {
      if (q.expectedRevision !== current.row.revision) throw revisionConflict(q.expectedRevision, current.row.revision);
      await writeDoc(tx, current, doc, audit);
    }
    return profileResponse(tx, q);
  });
}

export interface RevertProfileQuery extends PlannerQuery {
  auditId: string;
  expectedRevision: number;
}

/** An audit row's `before`, which a revert re-applies; `404` when the row does not exist. */
export async function auditBefore(db: DbOrTx, auditId: string): Promise<{ entity: string; entityId: string; before: unknown }> {
  const [row] = await db.select({ entity: auditLog.entity, entityId: auditLog.entityId, before: auditLog.before }).from(auditLog).where(eq(auditLog.id, auditId));
  if (row === undefined) throw new PlanError(404, "not_found", "That history entry does not exist");
  return row;
}

/**
 * Route 4: re-applies the document an audit row of entity `plan_profile` recorded before its
 * change (`409 revert_invalid` for a row of another entity, a creation, or a document that no
 * longer parses), as an ordinary save with its revision check.
 */
export async function revertProfile(db: DbOrTx, q: RevertProfileQuery, audit: AuditContext): Promise<ProfileResponse> {
  checkToday(q.today);
  return db.transaction(async (tx) => {
    const entry = await auditBefore(tx, q.auditId);
    if (entry.entity !== "plan_profile" || !isPlainObject(entry.before) || !Object.hasOwn(entry.before, "doc")) {
      throw new PlanError(409, "revert_invalid", "That history entry is not a change of the profile");
    }
    let doc: RetirementProfileDoc;
    try {
      doc = upgradeProfileDoc(entry.before["doc"]);
    } catch {
      throw new PlanError(409, "revert_invalid", "The profile recorded in that history entry can no longer be read");
    }
    const current = await loadProfile(tx, { lock: true });
    if (current === undefined) throw new PlanError(409, "profile_missing", "Set up the retirement profile first");
    if (q.expectedRevision !== current.row.revision) throw revisionConflict(q.expectedRevision, current.row.revision);
    await writeDoc(tx, current, doc, audit);
    return profileResponse(tx, q);
  });
}

/** Route 5: what a refresh from live data would change; computes, writes nothing. */
export async function previewBaseline(db: DbOrTx, q: PlannerQuery): Promise<BaselinePreviewResponse> {
  checkToday(q.today);
  const proposed = await computeBaseline(db, { today: q.today, now: q.now });
  const proposedHash = await baselineHash(proposed);
  const profile = await loadProfile(db);
  if (profile === undefined) {
    return { current: null, proposed, proposedHash, changes: diffBaselines(null, proposed), effectiveBefore: null, effectiveAfter: null };
  }
  const sc = await loadDefaultScenario(db);
  const before = resolveProfilePlan(q, profile, profile.baseline, sc).effective;
  const after = resolveProfilePlan(q, profile, proposed, sc).effective;
  return {
    current: profile.baseline,
    proposed,
    proposedHash,
    changes: diffBaselines(profile.baseline, proposed),
    effectiveBefore: before === undefined ? null : effectiveInputsView(before),
    effectiveAfter: after === undefined ? null : effectiveInputsView(after),
  };
}

/**
 * Recompute the baseline over the locked profile and store it when its hash differs from the
 * stored one (`baseline`, `baseline_as_of`, `baseline_hash`, `baseline_at`), with one
 * `plan_baseline` audit row of `baselineAuditJson` before and after (none when only dates moved).
 * Returns the diff and the profile as it now stands. `refreshBaseline` and `requestRun` call it.
 */
export async function storeFreshBaseline(
  tx: DbOrTx,
  q: PlannerQuery,
  current: StoredProfile,
  audit: AuditContext,
  options: { expectedHash?: string | undefined } = {},
): Promise<{ profile: StoredProfile; changes: BaselineChange[] }> {
  const fresh = await computeBaseline(tx, { today: q.today, now: q.now });
  const hash = await baselineHash(fresh);
  if (options.expectedHash !== undefined && options.expectedHash !== hash) {
    throw new PlanError(409, "baseline_changed", "Live data changed since the preview; review the changes again");
  }
  if (hash === current.row.baselineHash) return { profile: current, changes: [] };
  const [row] = await tx
    .update(planProfile)
    .set({ baseline: fresh, baselineAsOf: fresh.asOf, baselineHash: hash, baselineAt: sql`now()` })
    .where(eq(planProfile.id, 1))
    .returning();
  await writeAudit(tx, { ...audit, entity: "plan_baseline", entityId: "1", action: "update", before: baselineAuditJson(current.baseline), after: baselineAuditJson(fresh) });
  return { profile: { row: row!, doc: current.doc, baseline: fresh }, changes: diffBaselines(current.baseline, fresh) };
}

export interface RefreshBaselineQuery extends PlannerQuery {
  /** The preview's `proposedHash`: `409 baseline_changed` when the fresh baseline differs from it. */
  expectedHash?: string | undefined;
}

/** Route 6: refresh the stored baseline from live data (the profile's `revision` is untouched). */
export async function refreshBaseline(db: DbOrTx, q: RefreshBaselineQuery, audit: AuditContext): Promise<BaselineRefreshResponse> {
  checkToday(q.today);
  return db.transaction(async (tx) => {
    const current = await loadProfile(tx, { lock: true });
    if (current === undefined) throw new PlanError(409, "profile_missing", "Set up the retirement profile first");
    const { changes } = await storeFreshBaseline(tx, q, current, audit, { expectedHash: q.expectedHash });
    return { profile: await profileResponse(tx, q), changes };
  });
}

/** The error issues of a resolved plan, for the run refusal's message. */
export function errorIssues(issues: readonly PlanIssue[]): PlanIssue[] {
  return issues.filter((i) => i.severity === "error");
}
