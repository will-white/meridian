import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  freezeInput,
  isIsoDate,
  isPlainObject,
  overrideChanges,
  RetirementBaseline,
  successBp,
  truncDiv,
  upgradeProfileDoc,
  upgradeRunSettings,
  type FrozenInput,
  type IsoDate,
  type PlannerEnv,
  type ResolveContext,
  type RetirementProfileDoc,
  type RunSettings,
  type ScenarioSummary,
  type SimRunView,
} from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { planProfile, scenario, simRun } from "../schema/index.js";
import { PlanError } from "./audit.js";
import { driverError } from "./driverError.js";

/**
 * What the planner's services share (docs/design/phase-4/inputs-and-data.md §6.1, §6.2): reading
 * and parsing the stored documents, the resolver's context built from the injected `PlannerEnv`
 * (packages/db never imports the engine, decision 8), and the run view (`SimRunView`). Not
 * exported from the services index; `retirementProfile.ts`, `retirementScenarios.ts`,
 * `retirementRuns.ts` and `retirementCard.ts` import it. This module imports neither the baseline
 * nor the dashboard, so the dashboard's card can use it without an import cycle.
 */

/** At most this many scenarios that are not archived (§2.2). */
export const MAX_SCENARIOS = 50;
/** At most this many pinned runs per scenario (decision 28). */
export const MAX_PINNED_RUNS = 20;
/** `RETIREMENT_KEEP_RUNS`' default: finished unpinned runs kept per scenario (decision 28). */
export const DEFAULT_KEEP_RUNS = 20;
/** Failed or cancelled unpinned runs kept per scenario (decision 28). */
export const KEEP_FAILED_RUNS = 5;
/** A running run with no progress write for this long is stalled: the worker stopped (§4.8, §6.2). */
export const RUN_STALL_SECONDS = 120;
/** The scenario `PUT /profile` creates with the profile (§4.7 route 3). */
export const DEFAULT_SCENARIO_NAME = "Base plan";

/** The household's date and the server clock, and the engine's facts (§6.1). */
export interface PlannerQuery {
  /** The household's date (`resolveToday`): the baseline's age is counted to it. */
  today: IsoDate;
  /** The server clock: the baseline's as-of date, the frozen input's `meta.createdAt`. */
  now: Date;
  env: PlannerEnv;
}

export type ProfileRow = typeof planProfile.$inferSelect;
export type ScenarioRow = typeof scenario.$inferSelect;

/** The profile row with its two documents parsed. */
export interface StoredProfile {
  row: ProfileRow;
  doc: RetirementProfileDoc;
  baseline: RetirementBaseline;
}

export function checkToday(today: IsoDate): void {
  if (!isIsoDate(today)) throw new PlanError(400, "validation", "today must be YYYY-MM-DD");
}

export function parseProfileRow(row: ProfileRow): StoredProfile {
  return { row, doc: upgradeProfileDoc(row.doc), baseline: RetirementBaseline.parse(row.baseline) };
}

/** The profile row, locked `FOR UPDATE` when asked (inside a transaction), or undefined before one exists. */
export async function loadProfile(db: DbOrTx, options: { lock?: boolean } = {}): Promise<StoredProfile | undefined> {
  const q = db.select().from(planProfile).where(eq(planProfile.id, 1));
  const [row] = options.lock ? await q.for("update") : await q;
  return row === undefined ? undefined : parseProfileRow(row);
}

/**
 * The profile, or `409 profile_missing` (§4.8: a scenario or run write before a profile exists).
 * Every planner write locks it, which also serializes the scenario writes (names unique ignoring
 * case, one default, the 50-scenario limit) and the run requests.
 */
export async function requireProfile(db: DbOrTx, options: { lock?: boolean } = {}): Promise<StoredProfile> {
  const profile = await loadProfile(db, options);
  if (profile === undefined) throw new PlanError(409, "profile_missing", "Set up the retirement profile first");
  return profile;
}

export async function loadScenario(db: DbOrTx, id: string, options: { lock?: boolean } = {}): Promise<ScenarioRow> {
  const q = db.select().from(scenario).where(eq(scenario.id, id));
  const [row] = options.lock ? await q.for("update") : await q;
  if (row === undefined) throw new PlanError(404, "not_found", "That scenario does not exist");
  return row;
}

/** The default scenario (the dashboard card's); the profile's creation inserts it and nothing removes it. */
export async function loadDefaultScenario(db: DbOrTx): Promise<ScenarioRow> {
  const [row] = await db.select().from(scenario).where(eq(scenario.isDefault, true));
  if (row === undefined) throw new Error("the default scenario is missing");
  return row;
}

export function scenarioSettings(row: Pick<ScenarioRow, "settings">): RunSettings {
  return upgradeRunSettings(row.settings);
}

export function scenarioOverrides(row: Pick<ScenarioRow, "overrides">): Record<string, unknown> {
  return isPlainObject(row.overrides) ? row.overrides : {};
}

/** The resolver's context: the engine's facts, the household's date and the frozen input's `meta` (§4.6). */
export function resolveContext(q: PlannerQuery, profile: StoredProfile, sc: Pick<ScenarioRow, "id" | "revision" | "name">): ResolveContext {
  const { engineVersion: _engineVersion, ...facts } = q.env;
  return {
    ...facts,
    today: q.today,
    meta: {
      createdAt: q.now.toISOString(),
      profileRevision: profile.row.revision,
      baselineHash: profile.row.baselineHash,
      scenarioId: sc.id,
      scenarioRevision: sc.revision,
      scenarioName: sc.name,
    },
  };
}

/** A scenario resolved and frozen now: the stored documents, its overrides and settings (§3.4, §3.7). */
export function freezeScenario(q: PlannerQuery, profile: StoredProfile, sc: ScenarioRow): Promise<FrozenInput> {
  return freezeInput({ doc: profile.doc, baseline: profile.baseline, overrides: scenarioOverrides(sc), settings: scenarioSettings(sc) }, resolveContext(q, profile, sc));
}

/** The leaves of a scenario's patch against the profile (`changeCount`, `ScenarioView.changes`). */
export function scenarioChanges(profile: StoredProfile, sc: Pick<ScenarioRow, "overrides">) {
  return overrideChanges(profile.doc, scenarioOverrides(sc));
}

/** The scenario's columns as `writeAudit` records them (§6.2). */
export function scenarioAuditJson(r: ScenarioRow): Record<string, unknown> {
  return { name: r.name, notes: r.notes, isDefault: r.isDefault, archived: r.archived, position: r.position, overrides: r.overrides, settings: r.settings };
}

/** True when the database refused a write with a unique violation, on `constraint` when given. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = driverError(error) as { code?: unknown; constraint_name?: unknown } | null;
  return typeof e === "object" && e !== null && e.code === "23505" && (constraint === undefined || e.constraint_name === constraint);
}

// ---- The run view (§4.8 `SimRunView`) ----

/**
 * The columns a run view reads: never `input` or `fan` (§2.3), the two summary figures by JSON
 * path, and `stalled` on the database's clock, the clock that writes `progress_at`.
 */
export const RUN_VIEW_COLUMNS = {
  id: simRun.id,
  scenarioId: simRun.scenarioId,
  scenarioName: simRun.scenarioName,
  status: simRun.status,
  cancelRequested: simRun.cancelRequested,
  paths: simRun.paths,
  pathsDone: simRun.pathsDone,
  seed: simRun.seed,
  returnModel: simRun.returnModel,
  strategy: simRun.strategy,
  taxRuleSet: simRun.taxRuleSet,
  baselineAsOf: simRun.baselineAsOf,
  dataVersion: simRun.dataVersion,
  engineVersion: simRun.engineVersion,
  threads: simRun.threads,
  inputHash: simRun.inputHash,
  successPaths: simRun.successPaths,
  medianEndingRealCents: sql<string | null>`${simRun.summary} -> 'endingWealthReal' ->> 'p50'`,
  p10EndingRealCents: sql<string | null>`${simRun.summary} -> 'endingWealthReal' ->> 'p10'`,
  errorCode: simRun.errorCode,
  errorMessage: simRun.errorMessage,
  pinned: simRun.pinned,
  note: simRun.note,
  createdAt: simRun.createdAt,
  startedAt: simRun.startedAt,
  finishedAt: simRun.finishedAt,
  durationMs: simRun.durationMs,
  stalled: sql<boolean>`(${simRun.status} = 'running' and (${simRun.progressAt} is null or ${simRun.progressAt} < now() - ${sql.raw(`interval '${RUN_STALL_SECONDS} seconds'`)}))`,
};

export interface RunViewRow {
  id: string;
  scenarioId: string;
  scenarioName: string;
  status: SimRunView["status"];
  cancelRequested: boolean;
  paths: number;
  pathsDone: number;
  seed: number;
  returnModel: string;
  strategy: string;
  taxRuleSet: string;
  baselineAsOf: string;
  dataVersion: string;
  engineVersion: string | null;
  threads: number | null;
  inputHash: string;
  successPaths: number | null;
  medianEndingRealCents: string | null;
  p10EndingRealCents: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  pinned: boolean;
  note: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  stalled: boolean;
}

/** `truncDiv(done × 10000, paths)`, at most 10000 (C44). */
export function progressBp(pathsDone: number, paths: number): number {
  if (paths <= 0) return 0;
  return Math.min(10000, Number(truncDiv(BigInt(Math.max(0, pathsDone)) * 10000n, BigInt(paths))));
}

/**
 * `current` (§4.8): the run's input hash is what the scenario would freeze now (`currentHash`,
 * undefined or null when the plan no longer resolves), under the same engine version (a run the
 * worker has not stamped yet will run under the current one).
 */
export function isCurrentRun(r: Pick<RunViewRow, "inputHash" | "engineVersion">, currentHash: string | null | undefined, env: Pick<PlannerEnv, "engineVersion">): boolean {
  return currentHash !== undefined && currentHash !== null && r.inputHash === currentHash && (r.engineVersion === null || r.engineVersion === env.engineVersion);
}

export function toSimRunView(r: RunViewRow, current: boolean): SimRunView {
  return {
    id: r.id,
    scenarioId: r.scenarioId,
    scenarioName: r.scenarioName,
    status: r.status,
    cancelRequested: r.cancelRequested,
    stalled: r.stalled === true,
    paths: r.paths,
    pathsDone: r.pathsDone,
    progressBp: r.status === "done" ? 10000 : progressBp(r.pathsDone, r.paths),
    seed: r.seed,
    returnModel: r.returnModel,
    strategy: r.strategy,
    taxRuleSet: r.taxRuleSet,
    baselineAsOf: r.baselineAsOf,
    dataVersion: r.dataVersion,
    engineVersion: r.engineVersion,
    threads: r.threads,
    inputHash: r.inputHash,
    successPaths: r.successPaths,
    successBp: r.successPaths === null ? null : successBp(r.successPaths, r.paths),
    medianEndingRealCents: r.medianEndingRealCents,
    p10EndingRealCents: r.p10EndingRealCents,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    pinned: r.pinned,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt === null ? null : r.startedAt.toISOString(),
    finishedAt: r.finishedAt === null ? null : r.finishedAt.toISOString(),
    durationMs: r.durationMs,
    current,
  };
}

/** One run's view row, or `404 not_found`; locked `FOR UPDATE` when asked. */
export async function loadRunView(db: DbOrTx, runId: string, options: { lock?: boolean } = {}): Promise<RunViewRow> {
  const q = db.select(RUN_VIEW_COLUMNS).from(simRun).where(eq(simRun.id, runId));
  const [row] = options.lock ? await q.for("update", { of: simRun }) : await q;
  if (row === undefined) throw new PlanError(404, "not_found", "That run does not exist");
  return row as RunViewRow;
}

/**
 * The input hash each scenario would freeze now (null when its plan does not resolve), for the
 * runs' `current` flags. One resolve per scenario; nothing is written.
 */
export async function currentHashes(db: DbOrTx, q: PlannerQuery, scenarioIds: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(scenarioIds)];
  if (ids.length === 0) return out;
  const profile = await loadProfile(db);
  if (profile === undefined) {
    for (const id of ids) out.set(id, null);
    return out;
  }
  const rows = await db.select().from(scenario).where(inArray(scenario.id, ids));
  for (const id of ids) out.set(id, null);
  for (const row of rows) out.set(row.id, (await freezeScenario(q, profile, row)).inputHash ?? null);
  return out;
}

/** A scenario's newest run and its active run (queued or running), for `ScenarioSummary`. */
export async function scenarioRunViews(db: DbOrTx, scenarioIds: readonly string[]): Promise<Map<string, { latest?: RunViewRow; activeRunId: string | null }>> {
  const out = new Map<string, { latest?: RunViewRow; activeRunId: string | null }>();
  for (const id of scenarioIds) out.set(id, { activeRunId: null });
  if (scenarioIds.length === 0) return out;
  const latest = await db
    .selectDistinctOn([simRun.scenarioId], RUN_VIEW_COLUMNS)
    .from(simRun)
    .where(inArray(simRun.scenarioId, [...scenarioIds]))
    .orderBy(asc(simRun.scenarioId), desc(simRun.createdAt), desc(simRun.id));
  for (const r of latest) out.get(r.scenarioId)!.latest = r as RunViewRow;
  const active = await db
    .select({ id: simRun.id, scenarioId: simRun.scenarioId })
    .from(simRun)
    .where(and(inArray(simRun.scenarioId, [...scenarioIds]), inArray(simRun.status, ["queued", "running"])));
  for (const r of active) out.get(r.scenarioId)!.activeRunId = r.id;
  return out;
}

/** `ScenarioSummary` of one scenario (§4.8), its plan frozen now for the latest run's `current` flag. */
export function scenarioSummary(
  sc: ScenarioRow,
  changeCount: number,
  runs: { latest?: RunViewRow; activeRunId: string | null } | undefined,
  currentHash: string | null | undefined,
  env: Pick<PlannerEnv, "engineVersion">,
): ScenarioSummary {
  const latest = runs?.latest;
  return {
    id: sc.id,
    name: sc.name,
    notes: sc.notes,
    isDefault: sc.isDefault,
    archived: sc.archived,
    position: sc.position,
    revision: sc.revision,
    updatedAt: sc.updatedAt.toISOString(),
    changeCount,
    latestRun: latest === undefined ? null : toSimRunView(latest, isCurrentRun(latest, currentHash, env)),
    activeRunId: runs?.activeRunId ?? null,
  };
}
