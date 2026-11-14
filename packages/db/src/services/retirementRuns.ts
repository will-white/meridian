import { and, asc, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  decodeI16le,
  decodeI64le,
  effectiveInputsView,
  encodeI16le,
  encodeI64le,
  FanSeries,
  NEVER_DEPLETED,
  rankIndex,
  rankPaths,
  sanitizeText,
  SimInput,
  SimSummary,
  STORED_PERCENTILES,
  YearTable,
  type BaselineChange,
  type PlannerEnv,
  type RunPathResponse,
  type RunRequestResponse,
  type ScenarioInputResponse,
  type SimRunDetail,
  type SimRunSeriesKind,
  type SimRunView,
} from "@meridian/shared";
import type { DbOrTx } from "../index.js";
import { simRun, simRunPath, simRunSeries } from "../schema/index.js";
import { PlanError, writeAudit, type AuditContext } from "./audit.js";
import { enqueueJob } from "./jobs.js";
import { decodeCursor, encodeCursor } from "./queryText.js";
import { errorIssues, storeFreshBaseline } from "./retirementProfile.js";
import {
  checkToday,
  currentHashes,
  DEFAULT_KEEP_RUNS,
  freezeScenario,
  isCurrentRun,
  isUniqueViolation,
  KEEP_FAILED_RUNS,
  loadRunView,
  loadScenario,
  MAX_PINNED_RUNS,
  requireProfile,
  RUN_VIEW_COLUMNS,
  toSimRunView,
  type PlannerQuery,
  type RunViewRow,
} from "./retirementStore.js";

/**
 * Simulation runs (docs/design/phase-4/inputs-and-data.md §6.2, decisions 21 to 25 and 28; seams
 * C8, C13, C46, F9): freezing a scenario's input, requesting a run, the run's lifecycle as the
 * `retirement.simulate` job drives it, retention, and the run views.
 *
 * - `requestRun`: one transaction. Refresh the baseline by default (decision 4) and return what
 *   changed; resolve (an error issue, the engine's `validateInput` issues and the 35-day staleness
 *   refusal included, is `409 plan_incomplete` and rolls the refresh back, C13); hash; return the
 *   active run when its hash is the same (`409 run_in_progress` otherwise), or the newest finished
 *   run with the same hash under this engine version unless `force`; else insert a `queued` run and
 *   enqueue its job with a per-run key.
 * - The job's side: `beginSimRun` (claim; a run whose cancellation was asked is cancelled
 *   instead), `reportSimProgress` (the heartbeat; answers whether to stop), `completeSimRun`
 *   (summary, fan, the four series and the seven stored tables, written with the status flip),
 *   `failSimRun`, `cancelSimRun`. Each is conditional on the run still being active, so a second
 *   delivery or a late result writes nothing; each finishing transaction prunes (`pruneSimRuns`).
 * - The API's side: `requestCancel`, `listRuns`, `getRun`, `getRunInput`, `getRunPath` (a stored
 *   percentile, or one path re-simulated by the injected engine and checked against the stored
 *   series), `setRunFlags`, `deleteRun`.
 */

const ACTIVE = ["queued", "running"] as const;
/** A stored year table's JSON is at most this many bytes (C48's guard). */
export const MAX_YEAR_TABLE_BYTES = 2 * 1024 * 1024;

/** The input a scenario would freeze now (route 13), and a run it could reuse. */
export async function freezeScenarioInput(db: DbOrTx, scenarioId: string, q: PlannerQuery): Promise<ScenarioInputResponse> {
  checkToday(q.today);
  const sc = await loadScenario(db, scenarioId);
  const profile = await requireProfile(db);
  const frozen = await freezeScenario(q, profile, sc);
  const effective = frozen.effective === undefined ? null : effectiveInputsView(frozen.effective);
  const reusable = frozen.inputHash === undefined ? undefined : await reusableRun(db, sc.id, frozen.inputHash, q.env, { includeDone: true });
  return { input: frozen.input ?? null, inputHash: frozen.inputHash ?? null, issues: frozen.issues, effective, reusableRunId: reusable?.id ?? null };
}

/** The scenario's active run when it has the same hash, else (when asked) its newest finished run with that hash under this engine version. */
async function reusableRun(db: DbOrTx, scenarioId: string, inputHash: string, env: PlannerEnv, o: { includeDone: boolean }): Promise<RunViewRow | undefined> {
  const [active] = await db
    .select(RUN_VIEW_COLUMNS)
    .from(simRun)
    .where(and(eq(simRun.scenarioId, scenarioId), inArray(simRun.status, ACTIVE)))
    .limit(1);
  if (active !== undefined) return active.inputHash === inputHash ? (active as RunViewRow) : undefined;
  if (!o.includeDone) return undefined;
  const [done] = await db
    .select(RUN_VIEW_COLUMNS)
    .from(simRun)
    .where(and(eq(simRun.scenarioId, scenarioId), eq(simRun.status, "done"), eq(simRun.inputHash, inputHash), eq(simRun.engineVersion, env.engineVersion)))
    .orderBy(desc(simRun.finishedAt), desc(simRun.id))
    .limit(1);
  return done as RunViewRow | undefined;
}

export interface RequestRunQuery extends PlannerQuery {
  scenarioId: string;
  /** Recompute the baseline first (default true, decision 4); false runs on the stored one, which must be at most 35 days old. */
  refresh?: boolean | undefined;
  /** Start a run even when a finished run has the same input (default false). */
  force?: boolean | undefined;
}

/** Route 14 (§6.2 steps 1 to 7). `created` is false when an existing run is returned. */
export async function requestRun(db: DbOrTx, q: RequestRunQuery, audit: AuditContext): Promise<RunRequestResponse> {
  checkToday(q.today);
  const refresh = q.refresh ?? true;
  const force = q.force ?? false;
  try {
    return await db.transaction(async (tx) => {
      // 1. The profile and the scenario, locked.
      let profile = await requireProfile(tx, { lock: true });
      const sc = await loadScenario(tx, q.scenarioId, { lock: true });
      // 2. The baseline, refreshed from live data and audited when its hash moved.
      let baselineChanges: BaselineChange[] = [];
      if (refresh) ({ profile, changes: baselineChanges } = await storeFreshBaseline(tx, q, profile, audit));
      // 3, 4. Resolve (with the engine's own checks, C13) and hash.
      const frozen = await freezeScenario(q, profile, sc);
      if (frozen.input === undefined || frozen.inputHash === undefined) {
        const first = errorIssues(frozen.issues)[0];
        throw new PlanError(409, "plan_incomplete", first?.message ?? "The plan cannot run yet");
      }
      const { input, inputHash } = frozen;
      // 5. One active run per scenario.
      const [active] = await tx
        .select(RUN_VIEW_COLUMNS)
        .from(simRun)
        .where(and(eq(simRun.scenarioId, sc.id), inArray(simRun.status, ACTIVE)))
        .limit(1);
      if (active !== undefined) {
        if (active.inputHash !== inputHash) {
          throw new PlanError(409, "run_in_progress", `Run ${active.id} of this scenario is still ${active.status} with other inputs; cancel it or wait for it`);
        }
        return { run: toSimRunView(active as RunViewRow, isCurrentRun(active, inputHash, q.env)), created: false, reused: true, baselineChanges };
      }
      // 6. The newest finished run with the same input under this engine (the data version is inside the hash).
      if (!force) {
        const done = await reusableRun(tx, sc.id, inputHash, q.env, { includeDone: true });
        if (done !== undefined) return { run: toSimRunView(done, true), created: false, reused: true, baselineChanges };
      }
      // 7. A new run and its job, keyed per run.
      const settings = input.settings;
      const [row] = await tx
        .insert(simRun)
        .values({
          scenarioId: sc.id,
          scenarioName: sc.name,
          status: "queued",
          input,
          inputSchemaVersion: input.schemaVersion,
          inputHash,
          seed: settings.seed,
          paths: settings.paths,
          returnModel: settings.returnModel.kind,
          strategy: settings.strategy.kind,
          taxRuleSet: settings.taxRuleSet,
          dataVersion: input.data.version,
          baselineAsOf: input.meta.asOf,
          profileRevision: profile.row.revision,
          scenarioRevision: sc.revision,
          createdBy: audit.userId,
        })
        .returning({ id: simRun.id });
      const runId = row!.id;
      const queued = await enqueueJob(tx, "retirement.simulate", { runId, dedupeKey: `retirement.simulate:${runId}` }, { dedupe: true, maxAttempts: 2 });
      await tx.update(simRun).set({ jobId: queued.id }).where(eq(simRun.id, runId));
      const view = await loadRunView(tx, runId);
      return { run: toSimRunView(view, true), created: true, reused: false, baselineChanges };
    });
  } catch (error) {
    if (isUniqueViolation(error, "sim_run_active_idx")) throw new PlanError(409, "run_in_progress", "Another run of this scenario started meanwhile; reload");
    throw error;
  }
}

// ---- The job's side of the lifecycle ----

export interface BeginSimRunOptions {
  /** `ENGINE_VERSION` of the worker running it. */
  engineVersion: string;
  /** Worker threads (0 = inline). */
  threads: number;
}

export type BeginSimRunResult = { skipped: true } | { skipped: false; input: unknown; dataVersion: string };

/**
 * Claim a run (§6.3 step 2): `queued` (or `running` from an attempt that died, which restarts at
 * path 0) becomes `running` with the engine version and threads, unless its cancellation was
 * asked. No row: a run whose cancellation was asked becomes `cancelled`, and the job skips.
 */
export async function beginSimRun(db: DbOrTx, runId: string, o: BeginSimRunOptions, options: { keep?: number } = {}): Promise<BeginSimRunResult> {
  if (!Number.isSafeInteger(o.threads) || o.threads < 0 || o.threads > 64) throw new RangeError(`threads must be 0 to 64, got ${o.threads}`);
  const [row] = await db
    .update(simRun)
    .set({ status: "running", startedAt: sql`now()`, pathsDone: 0, progressAt: sql`now()`, engineVersion: o.engineVersion, threads: o.threads })
    .where(and(eq(simRun.id, runId), inArray(simRun.status, ACTIVE), eq(simRun.cancelRequested, false)))
    .returning({ input: simRun.input, dataVersion: simRun.dataVersion });
  if (row !== undefined) return { skipped: false, input: row.input, dataVersion: row.dataVersion };
  await finishRun(db, runId, { status: "cancelled", onlyIfCancelRequested: true }, options.keep);
  return { skipped: true };
}

/**
 * The heartbeat (§6.3 step 4): the engine's own path count and progress, and whether to stop
 * (true when cancellation was asked or the run is no longer running).
 */
export async function reportSimProgress(db: DbOrTx, runId: string, pathsDone: number, paths: number): Promise<boolean> {
  if (!Number.isSafeInteger(pathsDone) || pathsDone < 0 || !Number.isSafeInteger(paths) || paths < 1) throw new RangeError(`progress ${pathsDone} of ${paths}`);
  const [row] = await db
    .update(simRun)
    .set({ pathsDone, paths, progressAt: sql`now()` })
    .where(and(eq(simRun.id, runId), eq(simRun.status, "running")))
    .returning({ cancelRequested: simRun.cancelRequested });
  return row === undefined || row.cancelRequested;
}

/** The engine's result as the job hands it over: its `SimOutput` plus the stored percentiles' year tables. */
export interface SimRunResult {
  /** The engine's effective path count. */
  paths: number;
  successPaths: number;
  endingRealCents: BigInt64Array;
  /** −1 = never depleted. */
  depletionYear: Int16Array;
  /** F9's two series, stored when given. */
  lifetimeTaxRealCents?: BigInt64Array | undefined;
  lifetimeSpendingRealCents?: BigInt64Array | undefined;
  summary: SimSummary;
  fan: FanSeries;
  warnings: ReadonlyArray<{ code: string; message: string }>;
  timing: { elapsedMs: number };
  /** One year table per path `storedPercentilePaths` names (re-simulated by the job, which checked each against the series). */
  tables: readonly YearTable[];
}

/** A result that cannot be stored (a guard of `completeSimRun`); the job fails the run with its code. */
export class SimRunResultError extends Error {
  readonly code = "result_invalid";
  constructor(message: string) {
    super(message);
    this.name = "SimRunResultError";
  }
}

/** The stored percentiles' paths of a run (§3.8): the path at each percentile's rank, in `STORED_PERCENTILES` order. */
export function storedPercentilePaths(endingRealCents: BigInt64Array, depletionYear: Int16Array): Array<{ percentile: number; pathIndex: number; rank: number }> {
  const order = rankPaths(endingRealCents, depletionYear);
  return STORED_PERCENTILES.map((percentile) => {
    const rank = rankIndex(percentile, order.length);
    return { percentile, pathIndex: order[rank]!, rank };
  });
}

function checkSeries(name: string, values: { length: number } | undefined, paths: number): void {
  if (values !== undefined && values.length !== paths) throw new SimRunResultError(`${name} has ${values.length} values for ${paths} paths`);
}

/** The guards of §6.2 before anything is written; the rows to write. */
function resultRows(runId: string, result: SimRunResult) {
  const { paths } = result;
  if (!Number.isSafeInteger(paths) || paths < 1) throw new SimRunResultError(`not a path count: ${paths}`);
  if (!Number.isSafeInteger(result.successPaths) || result.successPaths < 0 || result.successPaths > paths) {
    throw new SimRunResultError(`successPaths ${result.successPaths} of ${paths}`);
  }
  checkSeries("endingRealCents", result.endingRealCents, paths);
  checkSeries("depletionYear", result.depletionYear, paths);
  checkSeries("lifetimeTaxRealCents", result.lifetimeTaxRealCents, paths);
  checkSeries("lifetimeSpendingRealCents", result.lifetimeSpendingRealCents, paths);
  const summary = SimSummary.safeParse(result.summary);
  if (!summary.success) throw new SimRunResultError(`the summary does not parse: ${summary.error.issues[0]?.message ?? ""}`);
  if (summary.data.paths !== paths || summary.data.successPaths !== result.successPaths) {
    throw new SimRunResultError(`the summary counts ${summary.data.successPaths} of ${summary.data.paths}, the run ${result.successPaths} of ${paths}`);
  }
  const fan = FanSeries.safeParse(result.fan);
  if (!fan.success) throw new SimRunResultError(`the fan does not parse: ${fan.error.issues[0]?.message ?? ""}`);

  const series: Array<typeof simRunSeries.$inferInsert> = [
    { runId, kind: "ending_real_cents", encoding: "i64le", count: paths, data: encodeI64le(result.endingRealCents) },
    { runId, kind: "depletion_year", encoding: "i16le", count: paths, data: encodeI16le(result.depletionYear) },
  ];
  const lifetime: Array<[SimRunSeriesKind, BigInt64Array | undefined]> = [
    ["lifetime_tax_real_cents", result.lifetimeTaxRealCents],
    ["lifetime_spending_real_cents", result.lifetimeSpendingRealCents],
  ];
  for (const [kind, values] of lifetime) if (values !== undefined) series.push({ runId, kind, encoding: "i64le", count: paths, data: encodeI64le(values) });

  const tables = new Map<number, YearTable>();
  for (const t of result.tables) {
    const parsed = YearTable.safeParse(t);
    if (!parsed.success) throw new SimRunResultError(`the year table of path ${t.pathIndex} does not parse: ${parsed.error.issues[0]?.message ?? ""}`);
    const bytes = Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
    if (bytes > MAX_YEAR_TABLE_BYTES) throw new SimRunResultError(`the year table of path ${t.pathIndex} is ${bytes} bytes (at most ${MAX_YEAR_TABLE_BYTES})`);
    tables.set(parsed.data.pathIndex, parsed.data);
  }
  const pathRows: Array<typeof simRunPath.$inferInsert> = storedPercentilePaths(result.endingRealCents, result.depletionYear).map(({ percentile, pathIndex, rank }) => {
    const table = tables.get(pathIndex);
    if (table === undefined) throw new SimRunResultError(`no year table for path ${pathIndex} (percentile ${percentile})`);
    const depletion = result.depletionYear[pathIndex]!;
    return {
      runId,
      percentile,
      pathIndex,
      rank,
      endingRealCents: result.endingRealCents[pathIndex]!,
      depletionYear: depletion === NEVER_DEPLETED ? null : depletion,
      yearTable: table,
    };
  });
  return { summary: summary.data, fan: fan.data, series, pathRows };
}

/**
 * Finish a run (§6.2): `done` with the engine's path count, the success count, summary, fan,
 * warnings and duration; the series and the seven stored path rows replaced; retention applied.
 * Only a `running` run is written (none: it was cancelled or failed meanwhile, and nothing is
 * written); returns whether it was. Throws `SimRunResultError` before writing when a guard fails.
 */
export async function completeSimRun(db: DbOrTx, runId: string, result: SimRunResult, options: { keep?: number } = {}): Promise<boolean> {
  const rows = resultRows(runId, result);
  const durationMs = Math.min(2_147_483_647, Math.max(0, Math.round(result.timing.elapsedMs)));
  return db.transaction(async (tx) => {
    const [run] = await tx
      .update(simRun)
      .set({
        status: "done",
        paths: result.paths,
        pathsDone: result.paths,
        successPaths: result.successPaths,
        summary: rows.summary,
        fan: rows.fan,
        warnings: result.warnings.map((w) => ({ code: w.code, message: w.message })),
        durationMs,
        progressAt: sql`now()`,
        finishedAt: sql`now()`,
      })
      .where(and(eq(simRun.id, runId), eq(simRun.status, "running")))
      .returning({ scenarioId: simRun.scenarioId });
    if (run === undefined) return false;
    await tx.delete(simRunSeries).where(eq(simRunSeries.runId, runId));
    await tx.delete(simRunPath).where(eq(simRunPath.runId, runId));
    await tx.insert(simRunSeries).values(rows.series);
    await tx.insert(simRunPath).values(rows.pathRows);
    await pruneSimRuns(tx, run.scenarioId, options.keep);
    return true;
  });
}

/** Move an active run to `failed` or `cancelled` with its finish time, and prune; whether a row moved. */
async function finishRun(
  db: DbOrTx,
  runId: string,
  o: { status: "failed" | "cancelled"; errorCode?: string; errorMessage?: string | null; onlyIfCancelRequested?: boolean },
  keep: number | undefined,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .update(simRun)
      .set({
        status: o.status,
        ...(o.status === "failed" ? { errorCode: o.errorCode, errorMessage: o.errorMessage ?? null } : {}),
        finishedAt: sql`now()`,
        durationMs: sql`case when ${simRun.startedAt} is null then null else least(2147483647, round(extract(epoch from (now() - ${simRun.startedAt})) * 1000))::integer end`,
      })
      .where(and(eq(simRun.id, runId), inArray(simRun.status, ACTIVE), o.onlyIfCancelRequested ? eq(simRun.cancelRequested, true) : undefined))
      .returning({ scenarioId: simRun.scenarioId });
    if (run === undefined) return false;
    await pruneSimRuns(tx, run.scenarioId, keep);
    return true;
  });
}

/**
 * Fail an active run with an error code (an engine code such as `bad_allocation`, or the job's
 * `engine_error`, `timeout`, `worker_crashed`, `worker_error`, `bad_input`, `data_version_changed`,
 * `not_reproducible`) and a message, both sanitized (the message to 500 characters); prunes.
 * Returns whether the run was still active.
 */
export async function failSimRun(db: DbOrTx, runId: string, code: string, message?: string | null, options: { keep?: number } = {}): Promise<boolean> {
  const errorCode = sanitizeText(code, 64) || "engine_error";
  const errorMessage = message === undefined || message === null ? null : sanitizeText(message, 500) || null;
  return finishRun(db, runId, { status: "failed", errorCode, errorMessage }, options.keep);
}

/** Cancel an active run (the job saw the cancellation); prunes. Returns whether the run was still active. */
export async function cancelSimRun(db: DbOrTx, runId: string, options: { keep?: number } = {}): Promise<boolean> {
  return finishRun(db, runId, { status: "cancelled" }, options.keep);
}

/**
 * Retention (§3.11, decision 28), in the transaction that finishes a run: the scenario's unpinned
 * `done` runs beyond the newest `keep` by `finished_at`, and its unpinned `failed` or `cancelled`
 * runs beyond the newest 5, are deleted with their series and paths. Pinned runs are kept (at most
 * 20 by `setRunFlags`). Returns the deleted ids.
 */
export async function pruneSimRuns(tx: DbOrTx, scenarioId: string, keep: number = DEFAULT_KEEP_RUNS): Promise<string[]> {
  const kept = Math.max(0, Math.trunc(keep));
  const done = await tx.execute<{ id: string }>(sql`
    delete from ${simRun} where id in (
      select id from ${simRun}
      where scenario_id = ${scenarioId} and status = 'done' and not pinned
      order by finished_at desc nulls last, id desc
      offset ${kept}
    )
    returning id`);
  const failed = await tx.execute<{ id: string }>(sql`
    delete from ${simRun} where id in (
      select id from ${simRun}
      where scenario_id = ${scenarioId} and status in ('failed', 'cancelled') and not pinned
      order by finished_at desc nulls last, id desc
      offset ${KEEP_FAILED_RUNS}
    )
    returning id`);
  return [...Array.from(done, (r) => r.id), ...Array.from(failed, (r) => r.id)];
}

// ---- The API's side ----

async function runView(db: DbOrTx, runId: string, q: PlannerQuery): Promise<SimRunView> {
  const row = await loadRunView(db, runId);
  const hashes = await currentHashes(db, q, [row.scenarioId]);
  return toSimRunView(row, isCurrentRun(row, hashes.get(row.scenarioId), q.env));
}

/**
 * Route 19: a `queued` run is cancelled at once (its job later finds no active row and skips); a
 * `running` run gets `cancel_requested` and the worker stops it within about a second; a running
 * run with no progress for 120 s (the worker is gone) is cancelled at once; a finished run is
 * `409 run_not_active`.
 */
export async function requestCancel(db: DbOrTx, runId: string, q: PlannerQuery, options: { keep?: number } = {}): Promise<SimRunView> {
  checkToday(q.today);
  await db.transaction(async (tx) => {
    await requireProfile(tx);
    const run = await loadRunView(tx, runId, { lock: true });
    if (run.status === "queued" || (run.status === "running" && run.stalled)) {
      await finishRun(tx, runId, { status: "cancelled" }, options.keep);
    } else if (run.status === "running") {
      await tx.update(simRun).set({ cancelRequested: true }).where(eq(simRun.id, runId));
    } else {
      throw new PlanError(409, "run_not_active", `That run is already ${run.status}`);
    }
  });
  return runView(db, runId, q);
}

export interface ListRunsQuery extends PlannerQuery {
  scenarioId?: string | undefined;
  /** 1 to 100, default 20. */
  limit?: number | undefined;
  cursor?: string | undefined;
}

/** Route 15: newest first, keyset-paginated on (created_at, id). */
export async function listRuns(db: DbOrTx, q: ListRunsQuery): Promise<{ items: SimRunView[]; nextCursor: string | null }> {
  checkToday(q.today);
  const limit = Math.max(1, Math.min(100, Math.trunc(q.limit ?? 20)));
  let cursor: { at: string; id: string } | undefined;
  if (q.cursor !== undefined) {
    const fields = decodeCursor(q.cursor, ["timestamp", "uuid"]);
    if (!fields) throw new PlanError(400, "invalid_cursor", "That page marker is not valid; reload the list");
    cursor = { at: fields[0]!, id: fields[1]! };
  }
  const rows = await db
    .select({ ...RUN_VIEW_COLUMNS, createdAtText: sql<string>`${simRun.createdAt}::text` })
    .from(simRun)
    .where(
      and(
        q.scenarioId === undefined ? undefined : eq(simRun.scenarioId, q.scenarioId),
        cursor === undefined
          ? undefined
          : or(sql`${simRun.createdAt} < ${cursor.at}::timestamptz`, and(sql`${simRun.createdAt} = ${cursor.at}::timestamptz`, sql`${simRun.id} < ${cursor.id}::uuid`)),
      ),
    )
    .orderBy(desc(simRun.createdAt), desc(simRun.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const hashes = await currentHashes(
    db,
    q,
    page.map((r) => r.scenarioId),
  );
  const last = page[page.length - 1];
  return {
    items: page.map(({ createdAtText: _text, ...r }) => toSimRunView(r as RunViewRow, isCurrentRun(r, hashes.get(r.scenarioId), q.env))),
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor([last.createdAtText, last.id]) : null,
  };
}

/** Route 16: the view with the summary, fan, warnings and the stored percentiles. */
export async function getRun(db: DbOrTx, runId: string, q: PlannerQuery): Promise<SimRunDetail> {
  checkToday(q.today);
  const view = await runView(db, runId, q);
  const [stored] = await db.select({ summary: simRun.summary, fan: simRun.fan, warnings: simRun.warnings }).from(simRun).where(eq(simRun.id, runId));
  const percentiles = await db.select({ percentile: simRunPath.percentile }).from(simRunPath).where(eq(simRunPath.runId, runId)).orderBy(asc(simRunPath.percentile));
  return {
    ...view,
    summary: stored?.summary == null ? null : SimSummary.parse(stored.summary),
    fan: stored?.fan == null ? null : FanSeries.parse(stored.fan),
    warnings: (stored?.warnings ?? []).map((w) => ({ code: w.code, message: w.message })),
    storedPercentiles: percentiles.map((p) => p.percentile),
  };
}

/** Route 17: the frozen input as stored. */
export async function getRunInput(db: DbOrTx, runId: string): Promise<SimInput> {
  const [row] = await db.select({ input: simRun.input }).from(simRun).where(eq(simRun.id, runId));
  if (row === undefined) throw new PlanError(404, "not_found", "That run does not exist");
  return SimInput.parse(row.input);
}

/** One path simulated alone (the engine's `simulatePath`, L5): what `getRunPath` needs of the engine. */
export interface PlannerPathEngine {
  simulatePath(input: SimInput, pathIndex: number): { pathIndex: number; endingRealCents: bigint; depletionYear: number; table: YearTable };
}

export interface RunPathQuery {
  env: PlannerEnv;
  engine: PlannerPathEngine;
}

/**
 * Route 18. A stored percentile answers from its row (`source: "stored"`). Any other percentile
 * 1 to 99 is re-simulated alone while the run's engine and data versions are the current ones
 * (`409 engine_changed` otherwise): the path at its rank in the stored series, whose ending wealth
 * and depletion year must equal the series' (`409 not_reproducible`). Nothing is written.
 */
export async function getRunPath(db: DbOrTx, runId: string, percentile: number, q: RunPathQuery): Promise<RunPathResponse> {
  if (!Number.isSafeInteger(percentile) || percentile < 1 || percentile > 99) throw new PlanError(400, "validation", "percentile must be a whole number from 1 to 99");
  const [run] = await db
    .select({ status: simRun.status, paths: simRun.paths, engineVersion: simRun.engineVersion, dataVersion: simRun.dataVersion })
    .from(simRun)
    .where(eq(simRun.id, runId));
  if (run === undefined) throw new PlanError(404, "not_found", "That run does not exist");
  if (run.status !== "done") throw new PlanError(409, "run_not_done", `That run is ${run.status}; its paths exist once it is done`);

  const [stored] = await db
    .select()
    .from(simRunPath)
    .where(and(eq(simRunPath.runId, runId), eq(simRunPath.percentile, percentile)));
  if (stored !== undefined) {
    return {
      percentile,
      pathIndex: stored.pathIndex,
      rank: stored.rank,
      source: "stored",
      endingRealCents: stored.endingRealCents.toString(),
      depletionYear: stored.depletionYear,
      table: YearTable.parse(stored.yearTable),
    };
  }

  if (run.engineVersion !== q.env.engineVersion || run.dataVersion !== q.env.dataVersion) {
    throw new PlanError(409, "engine_changed", "The engine or its data changed since this run; only its stored percentiles can be shown. Run it again for others");
  }
  const series = await db
    .select({ kind: simRunSeries.kind, data: simRunSeries.data })
    .from(simRunSeries)
    .where(and(eq(simRunSeries.runId, runId), inArray(simRunSeries.kind, ["ending_real_cents", "depletion_year"])));
  const endingBytes = series.find((s) => s.kind === "ending_real_cents")?.data;
  const depletionBytes = series.find((s) => s.kind === "depletion_year")?.data;
  if (endingBytes === undefined || depletionBytes === undefined) throw new Error(`run ${runId} has no stored series`);
  const ending = decodeI64le(endingBytes);
  const depletion = decodeI16le(depletionBytes);
  if (ending.length !== run.paths || depletion.length !== run.paths) throw new Error(`run ${runId}'s series do not hold ${run.paths} values`);
  const order = rankPaths(ending, depletion);
  const rank = rankIndex(percentile, order.length);
  const k = order[rank]!;

  const [row] = await db.select({ input: simRun.input }).from(simRun).where(eq(simRun.id, runId));
  const result = q.engine.simulatePath(SimInput.parse(row!.input), k);
  if (result.pathIndex !== k || result.endingRealCents !== ending[k] || result.depletionYear !== depletion[k]) {
    throw new PlanError(409, "not_reproducible", `Path ${k} re-simulated does not match the stored run; run the scenario again`);
  }
  return {
    percentile,
    pathIndex: k,
    rank,
    source: "resimulated",
    endingRealCents: ending[k]!.toString(),
    depletionYear: depletion[k] === NEVER_DEPLETED ? null : depletion[k]!,
    table: YearTable.parse(result.table),
  };
}

export interface RunFlagsInput {
  pinned?: boolean | undefined;
  /** Null or empty clears it. */
  note?: string | null | undefined;
}

function runAuditJson(r: Pick<RunViewRow, "pinned" | "note">): Record<string, unknown> {
  return { pinned: r.pinned, note: r.note };
}

/** Route 20: pin (at most 20 a scenario, `409 pin_limit`) and note; audited as `sim_run` with `{ pinned, note }`. */
export async function setRunFlags(db: DbOrTx, runId: string, input: RunFlagsInput, q: PlannerQuery, audit: AuditContext): Promise<SimRunView> {
  checkToday(q.today);
  await db.transaction(async (tx) => {
    await requireProfile(tx, { lock: true });
    const run = await loadRunView(tx, runId, { lock: true });
    const note = input.note === undefined ? run.note : input.note === null || input.note.trim() === "" ? null : input.note.trim().slice(0, 500);
    const pinned = input.pinned ?? run.pinned;
    if (pinned && !run.pinned) {
      const [row] = await tx
        .select({ n: count() })
        .from(simRun)
        .where(and(eq(simRun.scenarioId, run.scenarioId), eq(simRun.pinned, true)));
      if ((row?.n ?? 0) >= MAX_PINNED_RUNS) throw new PlanError(409, "pin_limit", `At most ${MAX_PINNED_RUNS} runs of a scenario can be pinned; unpin one first`);
    }
    if (pinned === run.pinned && note === run.note) return;
    await tx.update(simRun).set({ pinned, note }).where(eq(simRun.id, runId));
    await writeAudit(tx, { ...audit, entity: "sim_run", entityId: runId, action: "update", before: runAuditJson(run), after: { pinned, note } });
  });
  return runView(db, runId, q);
}

/** Route 21: a finished run and its series and paths; `409 run_active` while queued or running. Audited. */
export async function deleteRun(db: DbOrTx, runId: string, audit: AuditContext): Promise<void> {
  await db.transaction(async (tx) => {
    await requireProfile(tx, { lock: true });
    const run = await loadRunView(tx, runId, { lock: true });
    if (run.status === "queued" || run.status === "running") throw new PlanError(409, "run_active", "Cancel the run before deleting it");
    await tx.delete(simRun).where(eq(simRun.id, runId));
    await writeAudit(tx, {
      ...audit,
      entity: "sim_run",
      entityId: runId,
      action: "delete",
      before: { scenarioId: run.scenarioId, status: run.status, inputHash: run.inputHash, ...runAuditJson(run) },
      after: null,
    });
  });
}
