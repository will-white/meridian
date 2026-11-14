import type { EngineIssue, FanSeries, PlannerEnv, SimInput, SimSummary, YearTable } from "@meridian/shared";
import { exampleFanSeries, exampleSimSummary, exampleYearRow } from "@meridian/shared/src/retirement/testFixtures.js";
import type { Db } from "../index.js";
import { claimNextJob, completeJob } from "../services/jobs.js";
import { beginSimRun, completeSimRun, reportSimProgress, storedPercentilePaths, type PlannerPathEngine, type SimRunResult } from "../services/retirementRuns.js";

/**
 * The fake engine of the planner's lifecycle cases (docs/design/phase-4/inputs-and-data.md §7.0):
 * whatever is requested, a run is the ten-path result of §3.8 (10 paths, 8 successes, the two
 * series and F9's two, a summary whose ending-wealth percentiles are the series' own, a fan), and
 * `simulatePath` returns a two-row table carrying the series values of the asked path. The
 * services take it through `PlannerEnv` and `PlannerPathEngine`, so packages/db never imports the
 * engine (decision 8).
 */

export const FAKE_ENGINE_VERSION = "fake-1.0.0";
/** The shared fixture's data version, so the stored input compares with `fixtureSimInput()`. */
export const FAKE_DATA_VERSION = "2026.11.1";
/** The one seed the fake engine refuses (its `validateInput`, seams C13). */
export const FAKE_REFUSED_SEED = 4294967295;

/** §3.8's ending wealth per path, in today's cents. */
export const FAKE_ENDINGS: readonly bigint[] = [0n, 500n, 0n, 300n, 1200n, 150n, 700n, 400n, 900n, 200n];
/** §3.8's depletion years: paths 0 and 2 ran out, in 2051 and 2047; −1 = never. */
export const FAKE_DEPLETIONS: readonly number[] = [2051, -1, 2047, -1, -1, -1, -1, -1, -1, -1];

/** The fake engine's own check: it refuses `FAKE_REFUSED_SEED` (an issue the resolver itself does not raise). */
export function fakeValidateInput(input: SimInput): EngineIssue[] {
  return input.settings.seed === FAKE_REFUSED_SEED ? [{ code: "seed_invalid", message: `The engine refuses seed ${FAKE_REFUSED_SEED}.` }] : [];
}

export function fakePlannerEnv(o: Partial<PlannerEnv> = {}): PlannerEnv {
  return { engineVersion: FAKE_ENGINE_VERSION, dataVersion: FAKE_DATA_VERSION, ruleSets: ["current_law"], minStartYear: 2026, validateInput: fakeValidateInput, ...o };
}

/** A two-row year table of path `k` whose last row ends at the path's series value. */
export function fakeYearTable(k: number, endingRealCents: bigint = FAKE_ENDINGS[k]!, depletionYear: number = FAKE_DEPLETIONS[k]!): YearTable {
  const first = { ...exampleYearRow(), year: 2026 };
  const second = exampleYearRow();
  return {
    schemaVersion: 1,
    pathIndex: k,
    deathYears: [2070],
    accounts: [{ id: "roth", name: "Roth IRA", bucket: "roth", owner: "p1" }],
    startingTotal: "100000000",
    rows: [first, { ...second, ending: { ...second.ending, totalReal: endingRealCents.toString() }, failed: depletionYear !== -1 }],
  };
}

export interface FakePlannerEngine extends PlannerPathEngine {
  /** The path indexes `simulatePath` was called with, in order. */
  readonly calls: number[];
}

/** The fake `simulatePath`; `endingOffset` makes it disagree with the stored series (`not_reproducible`). */
export function fakePlannerEngine(o: { endingOffset?: bigint } = {}): FakePlannerEngine {
  const calls: number[] = [];
  return {
    calls,
    simulatePath(_input: SimInput, k: number) {
      calls.push(k);
      const endingRealCents = FAKE_ENDINGS[k]! + (o.endingOffset ?? 0n);
      return { pathIndex: k, endingRealCents, depletionYear: FAKE_DEPLETIONS[k]!, table: fakeYearTable(k, endingRealCents) };
    },
  };
}

/**
 * The summary of the fake run. Ranked by ending wealth, then depletion year, then index (§3.8):
 * paths 2, 0, 5, 9, 3, 7, 1, 6, 8, 4 with endings 0, 0, 150, 200, 300, 400, 500, 700, 900, 1200; the
 * nearest-rank p10, p25, p50, p75, p90 are ranks 0, 2, 4, 7, 8: 0, 150, 300, 700, 900; the mean
 * 4,350 ÷ 10 = 435. Failures in 2047 and 2051 (plan years 21 and 25 of a 2026 start, 47 years); the
 * running count first reaches ceil(2 ÷ 2) = 1 in 2047.
 */
export function fakeSimSummary(): SimSummary {
  const byYear = Array.from({ length: 47 }, (_, t) => (t === 21 || t === 25 ? 1 : 0));
  return {
    ...exampleSimSummary(),
    endingWealthReal: { p10: "0", p25: "150", p50: "300", p75: "700", p90: "900", mean: "435" },
    failure: { paths: 2, firstDepletionYear: 2047, medianDepletionYear: 2047, byYear },
  };
}

export function fakeFanSeries(): FanSeries {
  return exampleFanSeries();
}

/** The fake engine's whole run (`SimOutput` plus the stored percentiles' tables from `engine`). */
export function fakeRunResult(engine: PlannerPathEngine = fakePlannerEngine(), input?: SimInput): SimRunResult {
  const endingRealCents = BigInt64Array.from(FAKE_ENDINGS);
  const depletionYear = Int16Array.from(FAKE_DEPLETIONS);
  const tables = new Map<number, YearTable>();
  for (const { pathIndex } of storedPercentilePaths(endingRealCents, depletionYear)) {
    if (!tables.has(pathIndex)) tables.set(pathIndex, engine.simulatePath(input as SimInput, pathIndex).table);
  }
  return {
    paths: 10,
    successPaths: 8,
    endingRealCents,
    depletionYear,
    lifetimeTaxRealCents: BigInt64Array.from(FAKE_ENDINGS, (e) => e / 10n),
    lifetimeSpendingRealCents: BigInt64Array.from(FAKE_ENDINGS, (e) => e * 2n),
    summary: fakeSimSummary(),
    fan: fakeFanSeries(),
    warnings: [{ code: "historical_wrapped", message: "An illustrative warning." }],
    timing: { elapsedMs: 1234 },
    tables: [...tables.values()],
  };
}

/**
 * Drain the job queue as the worker would, with the fake engine: each `retirement.simulate` job
 * claims its run (a cancelled one is skipped), reports progress and completes it. Returns what
 * each job did, in claim order. A job of another type is marked done without running (the planner
 * tests enqueue none).
 */
export async function drainFakeRuns(db: Db, o: { keep?: number } = {}): Promise<Array<{ runId: string; outcome: "skipped" | "done" | "lost" }>> {
  const out: Array<{ runId: string; outcome: "skipped" | "done" | "lost" }> = [];
  for (;;) {
    const job = await claimNextJob(db, "fake-worker");
    if (job === undefined) return out;
    const runId = typeof job.payload["runId"] === "string" ? job.payload["runId"] : "";
    if (job.type === "retirement.simulate") {
      const begun = await beginSimRun(db, runId, { engineVersion: FAKE_ENGINE_VERSION, threads: 0 }, o);
      if (begun.skipped) out.push({ runId, outcome: "skipped" });
      else {
        await reportSimProgress(db, runId, 10, 10);
        const written = await completeSimRun(db, runId, fakeRunResult(), o);
        out.push({ runId, outcome: written ? "done" : "lost" });
      }
    }
    await completeJob(db, job.id);
  }
}
