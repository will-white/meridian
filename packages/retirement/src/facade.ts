/**
 * The engine's public facade (seams §2.4 and C7; inputs-and-data's "From engine-and-returns"
 * contract): one path of a frozen input re-simulated with its year table, and the mapping of an
 * aggregated run to the `SimOutput` the worker's job stores. `runSimulation`, which runs every path
 * (inline or in the thread pool), is in `@meridian/retirement/node` and builds its output here, so
 * the inline mode, the pool and the API's single path share one mapping.
 *
 * Inside: `prepare` → `simulatePathDetail` → `toYearTable` for a path, and `aggregate` →
 * `toSimSummary` / `toFanSeries` for a run. The harness stores no year tables (C8): the job
 * re-simulates its stored percentiles with `simulatePath` and checks each against the series.
 *
 * Every number is a function of the input alone (L5): `simulatePath(input, k)` reproduces path k
 * of `runSimulation(input, …)` bit for bit, whatever the thread count or chunk size.
 */

import type { FanSeries, SimInput, SimSummary, YearTable } from "@meridian/shared";
import { NEVER_DEPLETED } from "@meridian/shared";
import type { EngineResult } from "./aggregate.js";
import { prepare } from "./prepare.js";
import type { PreparedRun } from "./prepare.js";
import { toFanSeries, toSimSummary } from "./results/summary.js";
import { toYearTable } from "./results/yearTable.js";
import { selfTest } from "./selftest.js";
import { createProductionState, simulatePathDetail } from "./simulate.js";
import { dollarsToCentsBigInt } from "./units.js";

/** One path re-simulated (seams §2.4): its series values and its year table. */
export interface PathResult {
  readonly pathIndex: number;
  /** Ending wealth in today's cents: the `ending_real_cents` series value of the path. */
  readonly endingRealCents: bigint;
  /** The calendar year of the first drawdown year whose floor was not funded; −1 = never (C46). */
  readonly depletionYear: number;
  readonly table: YearTable;
}

/**
 * A whole run (seams §2.4 with F9's two series): the effective path count, the per-path series in
 * path order, the stored summary and fan, the run's warnings (C41's order) and the wall-clock
 * timing, which is not part of any stored document (two identical runs differ only there).
 */
export interface SimOutput {
  readonly paths: number;
  readonly successPaths: number;
  readonly endingRealCents: BigInt64Array;
  /** −1 = never depleted. */
  readonly depletionYear: Int16Array;
  /** F9: lifetime federal tax and lifetime funded spending per path, today's cents. */
  readonly lifetimeTaxRealCents: BigInt64Array;
  readonly lifetimeSpendingRealCents: BigInt64Array;
  readonly summary: SimSummary;
  readonly fan: FanSeries;
  readonly warnings: Array<{ code: string; message: string }>;
  readonly timing: { readonly elapsedMs: number; readonly threads: number };
}

let selfTested = false;

/**
 * The start-up self-test, once per thread (engine-and-returns §3.13): the engine refuses to run on a
 * machine whose arithmetic disagrees with the pinned bit patterns. A failure is not remembered, so
 * every later call throws again.
 */
export function ensureSelfTest(): void {
  if (selfTested) return;
  selfTest();
  selfTested = true;
}

/** The output of an aggregated run (`aggregate(run, summary)`), as `runSimulation` resolves it. */
export function toSimOutput(run: PreparedRun, result: EngineResult, timing: { elapsedMs: number; threads: number }): SimOutput {
  return {
    paths: result.paths,
    successPaths: result.successCount,
    endingRealCents: result.endingRealCents,
    depletionYear: result.depletionYear,
    lifetimeTaxRealCents: result.lifetimeTaxRealCents,
    lifetimeSpendingRealCents: result.lifetimeSpendingRealCents,
    summary: toSimSummary(result, run.input),
    fan: toFanSeries(result),
    warnings: result.warnings.map((w) => ({ code: w.code, message: w.message })),
    timing: { elapsedMs: timing.elapsedMs, threads: timing.threads },
  };
}

/** Path `pathIndex` of a prepared run with its year table (the facade's `simulatePath` on a run already prepared). */
export function simulatePreparedPath(run: PreparedRun, pathIndex: number): PathResult {
  ensureSelfTest();
  const ps = createProductionState(run);
  const table = toYearTable(simulatePathDetail(run, pathIndex, ps), run);
  return {
    pathIndex,
    endingRealCents: dollarsToCentsBigInt(ps.endReal),
    depletionYear: ps.failIdx >= 0 ? run.startYear + ps.failIdx : NEVER_DEPLETED,
    table,
  };
}

/**
 * Re-simulates path `pathIndex` of `input` with the production hooks and tax functions (seams
 * §2.4): `toYearTable(simulatePathDetail(prepare(input), k))`. Throws `EngineInputError` for an
 * input that cannot run and `RangeError` for a path index outside the effective path count.
 */
export function simulatePath(input: SimInput, pathIndex: number): PathResult {
  return simulatePreparedPath(prepare(input), pathIndex);
}
