/**
 * Aggregation of a run's paths (engine-and-returns §2.5, §3.11 and §3.12, with seams C9, C40,
 * C41 and F9).
 *
 * A chunk of paths is summarized in typed arrays (`ChunkSummary`); the run's summary
 * (`RunSummary`) is the same arrays for every path, each chunk copied to its `pathStart` offset, so
 * the result never depends on how the paths were split between threads (L5). `aggregate` reduces
 * the run summary to the run's `EngineResult`; every reduction walks the paths in path-index order
 * or sorts with the path index as the last key.
 *
 * - **Rank (C9).** The only rank rule is the shared `rankPaths` on cents: ending wealth in today's
 *   cents ascending, then the earlier depletion year (−1, never, last), then the path index.
 *   `percentilePathIndex[p] = order[percentileIndex(100 p, N)]`, so the year table of percentile p
 *   ends at the reported ending wealth of percentile p.
 * - **Percentiles** are nearest-rank order statistics (`percentileIndex`, integer arithmetic).
 *   Values are selected in float64 and rounded to cents afterwards; the rounding is monotone, so
 *   the selected cents equal the percentile of the rounded series.
 * - **Fan.** For each plan year t, the non-NaN values of the paths with `endIdx ≥ t`; `aliveCount[t]`
 *   is their number. The fan shows the leading years with `aliveCount ≥ min(100, paths)`
 *   (`fanYearsShown`); a cut is reported as `few_alive_paths`.
 * - **Success** is no failing drawdown year; the full-plan count (C40) is no below-plan year.
 *   Wilson's 95% interval (bootstrap and parametric models only) measures simulation noise.
 * - **Digest.** FNV-1a, 32 bits, over the little-endian bytes of `endNominal` (float64) then of
 *   `failIdx` (int16).
 * - **Warnings (C41).** The engine's warnings (`prepare`'s, then `few_alive_paths`,
 *   `grossup_not_converged` and `conversion_after_death`), followed by the tax area's
 *   `warningMessages` of the compile warnings and the merged path-warning totals (a maximum and a
 *   sum per slot, independent of chunk order).
 *
 * Money is float64 dollars in the summaries and integer cents (bigint) in the result: each value
 * crosses `units.ts` once.
 */

import { type MortalityTableId, NEVER_DEPLETED, type SimSummary, rankPaths } from "@meridian/shared";
import { EngineInputError } from "./errors.js";
import type { PreparedRun } from "./prepare.js";
import { PATH_FLAG, type PathState } from "./state.js";
import { WN_REC } from "./tax/layout.js";
import { type WarningTotals, addPathWarnings, createWarningTotals, mergeWarningTotals, warningMessages } from "./tax/warnings.js";
import { dollarsToCentsBigInt } from "./units.js";
import type { EngineWarning } from "./warning.js";

// ---------------------------------------------------------------------------------------------
// Primitives

/**
 * Nearest rank (engine-and-returns §3.12): `max(0, floor((pBp × n + 9999) / 10000) − 1)`, the
 * index of the smallest value with at least p percent of the n values at or below it, in a sorted
 * array. `pBp` is the percentile in basis points (5000 = median); integer arithmetic. For a whole
 * percentile p it equals the shared `rankIndex(p, n)`.
 */
export function percentileIndex(pBp: number, n: number): number {
  if (!Number.isInteger(pBp) || pBp < 0 || pBp > 10_000) throw new RangeError(`percentileIndex: not a percentile in basis points: ${pBp}`);
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`percentileIndex: not a count: ${n}`);
  const x = pBp * n + 9999;
  const rank = (x - (x % 10_000)) / 10_000;
  return rank > 0 ? rank - 1 : 0;
}

/** z for a two-sided 95% interval: `invNorm(0.975)`. */
export const WILSON_Z = 1.959963984540054;

/**
 * Wilson's 95% score interval for `successes` of `n` (engine-and-returns §3.12), clamped to
 * [0, 1]: `center = (p̂ + z²/2n) / (1 + z²/n)`, `half = z √(p̂(1 − p̂)/n + z²/4n²) / (1 + z²/n)`.
 */
export function wilson95(successes: number, n: number): [number, number] {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`wilson95: not a count: ${n}`);
  if (!Number.isSafeInteger(successes) || successes < 0 || successes > n) throw new RangeError(`wilson95: ${successes} of ${n}`);
  const p = successes / n;
  const z2 = WILSON_Z * WILSON_Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (WILSON_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // At 0 (or n) successes the lower (upper) bound is exactly 0 (1): center and half are then the
  // same quotient, which float64 can leave a few ulps apart.
  const lo = successes === 0 ? 0 : center - half;
  const hi = successes === n ? 1 : center + half;
  return [lo < 0 ? 0 : lo, hi > 1 ? 1 : hi];
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * The result digest (engine-and-returns §3.12, decision 31): FNV-1a, 32 bits, over the
 * little-endian bytes of `endNominal` as float64 followed by those of `failIdx` as int16, written
 * through a `DataView` (no host byte order), as 8 lower-case hex digits.
 */
export function digest(endNominal: ArrayLike<number>, failIdx: ArrayLike<number>): string {
  const view = new DataView(new ArrayBuffer(8));
  let h = FNV_OFFSET;
  for (let i = 0; i < endNominal.length; i++) {
    view.setFloat64(0, endNominal[i]!, true);
    for (let b = 0; b < 8; b++) h = Math.imul(h ^ view.getUint8(b), FNV_PRIME);
  }
  for (let i = 0; i < failIdx.length; i++) {
    view.setInt16(0, failIdx[i]!, true);
    for (let b = 0; b < 2; b++) h = Math.imul(h ^ view.getUint8(b), FNV_PRIME);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The fan's percentiles in basis points (engine-and-returns §2.6): p10, p25, p50, p75, p90. */
export const FAN_PERCENTILES_BP = [1000, 2500, 5000, 7500, 9000] as const;

/** The fan stops after the last plan year with at least this many paths alive (or all paths when fewer run). */
export const FAN_MIN_ALIVE = 100;

/** The number of leading plan years the fan shows: those with `aliveCount ≥ min(FAN_MIN_ALIVE, paths)` (strategies-outputs-web §3.10). */
export function fanYearsShown(aliveCount: ArrayLike<number>, paths: number): number {
  const threshold = paths < FAN_MIN_ALIVE ? paths : FAN_MIN_ALIVE;
  let t = 0;
  while (t < aliveCount.length && aliveCount[t]! >= threshold) t++;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Chunk and run summaries

/**
 * The results of paths `[pathStart, pathStart + pathCount)` (engine-and-returns §2.5 with seams
 * C40's below-plan bit, C41's warning totals and F9's lifetime sums). Per path: `endReal` (today's
 * dollars), `endNominal`, `flags` (`PATH_FLAG`), `failIdx` (first failing plan year, −1 if none),
 * `endIdx` (last plan year), `deathIdx` (`i × P + person`), the lifetime sums in today's dollars, the
 * years whose gross-up did not converge and the conversions skipped after a death. Per path and
 * plan year (`i × Y + t`): the end-of-year portfolio in today's dollars and nominal, and funded
 * spending in today's dollars (NaN after the path's last year, and for spending in accumulation
 * years). Typed arrays only, so a worker can transfer the buffers.
 */
export interface ChunkSummary {
  readonly pathStart: number;
  readonly pathCount: number;
  readonly years: number;
  readonly people: number;
  readonly endReal: Float64Array;
  readonly endNominal: Float64Array;
  readonly flags: Uint8Array;
  readonly failIdx: Int16Array;
  readonly endIdx: Int16Array;
  readonly deathIdx: Int16Array;
  readonly shortfallReal: Float64Array;
  readonly taxesReal: Float64Array;
  readonly spendReal: Float64Array;
  readonly notConvergedYears: Uint16Array;
  readonly conversionsSkipped: Uint16Array;
  readonly totalReal: Float64Array;
  readonly totalNominal: Float64Array;
  readonly spendingReal: Float64Array;
  /** The tax area's path warnings, merged over the chunk's paths (C41). */
  readonly warnMax: Float64Array;
  readonly warnPaths: Uint32Array;
}

/** The summary of every path of a run: a chunk that starts at 0 and holds `run.paths` paths. */
export type RunSummary = ChunkSummary;

export function createChunkSummary(run: PreparedRun, pathStart: number, pathCount: number): ChunkSummary {
  if (!Number.isSafeInteger(pathStart) || pathStart < 0 || !Number.isSafeInteger(pathCount) || pathCount < 0 || pathStart + pathCount > run.paths) {
    throw new RangeError(`a chunk of ${pathCount} paths from ${pathStart} does not fit a run of ${run.paths}`);
  }
  const n = pathCount;
  const Y = run.years;
  const totals = createWarningTotals();
  return {
    pathStart,
    pathCount: n,
    years: Y,
    people: run.personCount,
    endReal: new Float64Array(n),
    endNominal: new Float64Array(n),
    flags: new Uint8Array(n),
    failIdx: new Int16Array(n),
    endIdx: new Int16Array(n),
    deathIdx: new Int16Array(n * run.personCount),
    shortfallReal: new Float64Array(n),
    taxesReal: new Float64Array(n),
    spendReal: new Float64Array(n),
    notConvergedYears: new Uint16Array(n),
    conversionsSkipped: new Uint16Array(n),
    totalReal: new Float64Array(n * Y),
    totalNominal: new Float64Array(n * Y),
    spendingReal: new Float64Array(n * Y),
    warnMax: totals.warnMax,
    warnPaths: totals.warnPaths,
  };
}

export function createRunSummary(run: PreparedRun): RunSummary {
  return createChunkSummary(run, 0, run.paths);
}

/** Copies the results of the path `ps` has just simulated into slot `i` of `chunk` and adds its warnings. Allocates nothing. */
export function recordPath(chunk: ChunkSummary, i: number, ps: PathState): void {
  const Y = chunk.years;
  const P = chunk.people;
  chunk.endReal[i] = ps.endReal;
  chunk.endNominal[i] = ps.endNominal;
  chunk.flags[i] = ps.flags;
  chunk.failIdx[i] = ps.failIdx;
  chunk.endIdx[i] = ps.endIdx;
  for (let p = 0; p < P; p++) chunk.deathIdx[i * P + p] = ps.deathIdx[p]!;
  chunk.shortfallReal[i] = ps.shortfallReal;
  chunk.taxesReal[i] = ps.taxesReal;
  chunk.spendReal[i] = ps.spendReal;
  chunk.notConvergedYears[i] = ps.notConvergedYears;
  chunk.conversionsSkipped[i] = ps.conversionsSkipped;
  chunk.totalReal.set(ps.totalReal, i * Y);
  chunk.totalNominal.set(ps.totalNominal, i * Y);
  chunk.spendingReal.set(ps.spendingReal, i * Y);
  addPathWarnings(chunk as WarningTotals, ps.wn);
}

/** Copies `chunk` into `summary` at its `pathStart` offset and merges its warning totals (order-independent). */
export function addChunk(summary: RunSummary, chunk: ChunkSummary): void {
  if (chunk.years !== summary.years || chunk.people !== summary.people) throw new RangeError("addChunk: the chunk is from another run");
  const o = chunk.pathStart - summary.pathStart;
  if (o < 0 || o + chunk.pathCount > summary.pathCount) throw new RangeError(`addChunk: paths ${chunk.pathStart} to ${chunk.pathStart + chunk.pathCount} are outside the summary`);
  const Y = summary.years;
  const P = summary.people;
  summary.endReal.set(chunk.endReal, o);
  summary.endNominal.set(chunk.endNominal, o);
  summary.flags.set(chunk.flags, o);
  summary.failIdx.set(chunk.failIdx, o);
  summary.endIdx.set(chunk.endIdx, o);
  summary.deathIdx.set(chunk.deathIdx, o * P);
  summary.shortfallReal.set(chunk.shortfallReal, o);
  summary.taxesReal.set(chunk.taxesReal, o);
  summary.spendReal.set(chunk.spendReal, o);
  summary.notConvergedYears.set(chunk.notConvergedYears, o);
  summary.conversionsSkipped.set(chunk.conversionsSkipped, o);
  summary.totalReal.set(chunk.totalReal, o * Y);
  summary.totalNominal.set(chunk.totalNominal, o * Y);
  summary.spendingReal.set(chunk.spendingReal, o * Y);
  mergeWarningTotals(summary as WarningTotals, chunk as WarningTotals);
}

// ---------------------------------------------------------------------------------------------
// The run's result

export type Cents = bigint;

/**
 * The aggregated run (engine-and-returns §2.6 with seams C9, C40, C41, C44 and F9): what the
 * result mappers (`toSimSummary`, `toFanSeries`) and the facade's `SimOutput` are made from. Money
 * is integer cents (bigint, today's dollars unless a name says nominal); a band entry is null
 * where no path is alive.
 */
export interface EngineResult {
  readonly paths: number;
  /** The horizon Y in plan years. */
  readonly years: number;
  readonly startYear: number;
  readonly firstYearFraction: number;
  /** Calendar year of each plan year, and each person's age attained in it (`[person][t]`). */
  readonly calendarYears: readonly number[];
  readonly ages: readonly (readonly number[])[];
  /** Plan-year index of the first drawdown year. */
  readonly drawdownStart: number;
  readonly model: SimSummary["model"];
  readonly mortalityTable: MortalityTableId;
  readonly successCount: number;
  /** Paths with no below-plan drawdown year (C40). */
  readonly fullPlanCount: number;
  /** Wilson's 95% interval of the success rate; null for the historical and fixed models. */
  readonly successCi95: readonly [number, number] | null;
  /**
   * The per-path series (inputs-and-data §2.4, seams C46 and F9): ending wealth, lifetime federal
   * tax and lifetime funded spending in today's cents, and the depletion year (the calendar year
   * of the first drawdown year whose floor was not funded; −1 = never).
   */
  readonly endingRealCents: BigInt64Array;
  readonly depletionYear: Int16Array;
  readonly lifetimeTaxRealCents: BigInt64Array;
  readonly lifetimeSpendingRealCents: BigInt64Array;
  /** Path indices from worst to best (the shared `rankPaths`, C9). */
  readonly order: Uint32Array;
  /** 101 entries: `[p]` is the path at percentile p (`[0]` the worst, `[100]` the best). */
  readonly percentilePathIndex: readonly number[];
  /** 101 entries: `[p]` is the ending wealth of `percentilePathIndex[p]`. */
  readonly endingWealthRealQuantiles: readonly Cents[];
  readonly endingWealthReal: { readonly p10: Cents; readonly p25: Cents; readonly p50: Cents; readonly p75: Cents; readonly p90: Cents; readonly mean: Cents };
  readonly endingWealthNominal: { readonly p10: Cents; readonly p50: Cents; readonly p90: Cents };
  /** The fan's percentiles (`FAN_PERCENTILES_BP`) and its bands `[percentile][t]`, over all Y plan years. */
  readonly percentilesBp: readonly number[];
  readonly fanReal: ReadonlyArray<ReadonlyArray<Cents | null>>;
  readonly fanNominal: ReadonlyArray<ReadonlyArray<Cents | null>>;
  readonly fanSpendingReal: ReadonlyArray<ReadonlyArray<Cents | null>>;
  /** Paths whose plan is still running in each plan year (`endIdx ≥ t`), and the leading years the fan shows. */
  readonly aliveCount: readonly number[];
  readonly fanYears: number;
  /** First failures by plan year. */
  readonly failureYearCounts: readonly number[];
  readonly lifetimeTaxesRealMedian: Cents;
  readonly lifetimeSpendingRealMedian: Cents;
  /** The median lifetime shortfall of the failed paths; null when none failed. */
  readonly shortfallRealMedianOfFailures: Cents | null;
  readonly digest: string;
  readonly warnings: readonly EngineWarning[];
}

/** A whole number with thousands separators (no locale: the same text on every machine). */
function grouped(n: number): string {
  const digits = String(n);
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

const plural = (n: number, one: string, many: string) => `${grouped(n)} ${n === 1 ? one : many}`;

/** The nearest-rank value at `pBp` of `values[0 … n)` (sorted in place). */
function sortedPercentile(values: Float64Array, n: number, pBp: number): number {
  return values[percentileIndex(pBp, n)]!;
}

/** Sorts `values[0 … n)` ascending in place and returns the view. */
function sortPrefix(values: Float64Array, n: number): Float64Array {
  const view = values.subarray(0, n);
  view.sort();
  return view;
}

/**
 * The fan's bands `[percentile][t]` of a per-path, per-year matrix (`i × years + t`, dollars): for
 * each plan year the nearest-rank percentiles (`FAN_PERCENTILES_BP`) of the non-NaN values of the
 * paths with `endIdx ≥ t`, in cents; null where there is none.
 */
export function fanBands(matrix: Float64Array, endIdx: Int16Array, years: number, scratch: Float64Array = new Float64Array(endIdx.length)): Array<Array<Cents | null>> {
  const n = endIdx.length;
  const Y = years;
  if (matrix.length !== n * Y || scratch.length < n) throw new RangeError(`fanBands: a matrix of ${matrix.length} values for ${n} paths of ${Y} years`);
  const out: Array<Array<Cents | null>> = FAN_PERCENTILES_BP.map(() => new Array<Cents | null>(Y).fill(null));
  for (let t = 0; t < Y; t++) {
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (endIdx[i]! < t) continue;
      const v = matrix[i * Y + t]!;
      if (!Number.isNaN(v)) scratch[m++] = v;
    }
    if (m === 0) continue;
    const sorted = sortPrefix(scratch, m);
    FAN_PERCENTILES_BP.forEach((pBp, j) => {
      out[j]![t] = dollarsToCentsBigInt(sortedPercentile(sorted, m, pBp));
    });
  }
  return out;
}

/** Paths whose plan is still running in each of `years` plan years: `aliveCount[t]` = the paths with `endIdx ≥ t`. */
export function aliveCounts(endIdx: Int16Array, years: number): number[] {
  const out = new Array<number>(years).fill(0);
  for (let i = 0; i < endIdx.length; i++) for (let t = 0; t <= endIdx[i]! && t < years; t++) out[t] = out[t]! + 1;
  return out;
}

/**
 * The percentile paths (C9): the shared `rankPaths` order (ending wealth in today's cents, then
 * the earlier depletion year with −1 last, then the path index), `percentilePathIndex[p] =
 * order[percentileIndex(100 p, N)]` for p = 0 … 100, and the ending wealth of each.
 */
export function percentilePaths(
  endingRealCents: BigInt64Array,
  depletionYear: Int16Array,
): { order: Uint32Array; percentilePathIndex: number[]; endingWealthRealQuantiles: Cents[] } {
  const order = rankPaths(endingRealCents, depletionYear);
  const percentilePathIndex: number[] = [];
  const endingWealthRealQuantiles: Cents[] = [];
  for (let p = 0; p <= 100; p++) {
    const k = order[percentileIndex(100 * p, order.length)]!;
    percentilePathIndex.push(k);
    endingWealthRealQuantiles.push(endingRealCents[k]!);
  }
  return { order, percentilePathIndex, endingWealthRealQuantiles };
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * A path's figure in cents for the stored `i64le` series (shared `SERIES_ENCODING`). A
 * `BigInt64Array` would wrap a value beyond ±9.2 × 10^18 cents modulo 2^64 (the review's probe: an
 * ending wealth of 2.2 × 10^52 cents stored as 0, and ranked as 0); such a run is refused instead,
 * as `result_out_of_range`: the plan (a growth or a return far beyond any household's) produced a
 * figure the stored series cannot hold. It is an input error, permanent, mapped by the job like
 * every `EngineInputError` (seams C7).
 */
function seriesCents(dollars: number, what: string, path: number): bigint {
  const c = dollarsToCentsBigInt(dollars);
  if (c < INT64_MIN || c > INT64_MAX) {
    throw new EngineInputError("result_out_of_range", `path ${path}'s ${what} of ${c} cents in today's dollars does not fit the stored 64-bit series; the plan's growth or returns are beyond what the planner can store`);
  }
  return c;
}

/**
 * Reduces the run summary to the run's result (engine-and-returns §3.11 and §3.12 with seams C9,
 * C40, C41 and F9). `summary` must hold every path of `run` (`createRunSummary`). Throws
 * `EngineInputError("result_out_of_range")` when a path's figure does not fit the 64-bit series.
 */
export function aggregate(run: PreparedRun, summary: RunSummary): EngineResult {
  const N = summary.pathCount;
  const Y = summary.years;
  if (summary.pathStart !== 0 || N !== run.paths || Y !== run.years) {
    throw new RangeError(`aggregate: the summary holds paths ${summary.pathStart} to ${summary.pathStart + N} of ${Y} years, the run ${run.paths} paths of ${run.years}`);
  }
  if (N < 1) throw new RangeError("aggregate: a run has at least one path");
  const startYear = run.startYear;

  // The per-path series (C46, F9).
  const endingRealCents = new BigInt64Array(N);
  const depletionYear = new Int16Array(N);
  const lifetimeTaxRealCents = new BigInt64Array(N);
  const lifetimeSpendingRealCents = new BigInt64Array(N);
  let successCount = 0;
  let fullPlanCount = 0;
  let failures = 0;
  let notConvergedYears = 0;
  let notConvergedPaths = 0;
  let skipped = 0;
  let skippedPaths = 0;
  let meanSum = 0;
  const failureYearCounts = new Array<number>(Y).fill(0);
  for (let i = 0; i < N; i++) {
    endingRealCents[i] = seriesCents(summary.endReal[i]!, "ending wealth", i);
    lifetimeTaxRealCents[i] = seriesCents(summary.taxesReal[i]!, "lifetime tax", i);
    lifetimeSpendingRealCents[i] = seriesCents(summary.spendReal[i]!, "lifetime spending", i);
    const f = summary.failIdx[i]!;
    depletionYear[i] = f >= 0 ? startYear + f : NEVER_DEPLETED;
    if (f >= 0) failureYearCounts[f] = failureYearCounts[f]! + 1;
    const flags = summary.flags[i]!;
    if ((flags & PATH_FLAG.SUCCESS) !== 0) successCount++;
    else failures++;
    if ((flags & PATH_FLAG.BELOW_PLAN) === 0) fullPlanCount++;
    meanSum += summary.endReal[i]!;
    if (summary.notConvergedYears[i]! > 0) {
      notConvergedYears += summary.notConvergedYears[i]!;
      notConvergedPaths++;
    }
    if (summary.conversionsSkipped[i]! > 0) {
      skipped += summary.conversionsSkipped[i]!;
      skippedPaths++;
    }
  }

  // Rank (C9) and the percentile paths.
  const { order, percentilePathIndex, endingWealthRealQuantiles } = percentilePaths(endingRealCents, depletionYear);
  const q = (p: number) => endingWealthRealQuantiles[p]!;

  // Nominal ending wealth, the lifetime medians: each series sorted on its own.
  const scratch = new Float64Array(N);
  scratch.set(summary.endNominal);
  const nominal = sortPrefix(scratch, N);
  const endingWealthNominal = {
    p10: dollarsToCentsBigInt(sortedPercentile(nominal, N, 1000)),
    p50: dollarsToCentsBigInt(sortedPercentile(nominal, N, 5000)),
    p90: dollarsToCentsBigInt(sortedPercentile(nominal, N, 9000)),
  };
  const median = (values: Float64Array): Cents => {
    scratch.set(values);
    return dollarsToCentsBigInt(sortedPercentile(sortPrefix(scratch, N), N, 5000));
  };
  const lifetimeTaxesRealMedian = median(summary.taxesReal);
  const lifetimeSpendingRealMedian = median(summary.spendReal);
  let shortfallRealMedianOfFailures: Cents | null = null;
  if (failures > 0) {
    let m = 0;
    for (let i = 0; i < N; i++) if ((summary.flags[i]! & PATH_FLAG.SUCCESS) === 0) scratch[m++] = summary.shortfallReal[i]!;
    shortfallRealMedianOfFailures = dollarsToCentsBigInt(sortedPercentile(sortPrefix(scratch, m), m, 5000));
  }

  // The fan and the survival curve.
  const aliveCount = aliveCounts(summary.endIdx, Y);
  const fanYears = fanYearsShown(aliveCount, N);
  const fanReal = fanBands(summary.totalReal, summary.endIdx, Y, scratch);
  const fanNominal = fanBands(summary.totalNominal, summary.endIdx, Y, scratch);
  const fanSpendingReal = fanBands(summary.spendingReal, summary.endIdx, Y, scratch);

  const kind = run.model.kind;
  const successCi95 = kind === "historical" || kind === "fixed" ? null : wilson95(successCount, N);

  const calendarYears: number[] = [];
  for (let t = 0; t < Y; t++) calendarYears.push(startYear + t);
  const ages: number[][] = [];
  for (let p = 0; p < run.personCount; p++) ages.push(calendarYears.map((y) => y - run.birthYear[p]!));

  // Warnings (C41): the engine's, then the tax area's.
  const warnings: EngineWarning[] = run.warnings.map((w) => ({ code: w.code, message: w.message }));
  if (fanYears < Y && fanYears > 0) {
    const threshold = N < FAN_MIN_ALIVE ? N : FAN_MIN_ALIVE;
    warnings.push({
      code: "few_alive_paths",
      message: `After ${startYear + fanYears - 1} fewer than ${grouped(threshold)} of the ${plural(N, "simulated future", "simulated futures")} still have someone alive; the fan chart stops there.`,
    });
  }
  if (notConvergedYears > 0) {
    warnings.push({
      code: "grossup_not_converged",
      message: `In ${plural(notConvergedYears, "simulated year", "simulated years")} on ${grouped(notConvergedPaths)} of ${plural(N, "path", "paths")} the withdrawal gross-up stopped before it converged; it kept a withdrawal that paid the year's spending and tax, and saved the extra cash.`,
    });
  }
  if (skipped > 0) {
    warnings.push({
      code: "conversion_after_death",
      message: `${plural(skipped, "scheduled Roth conversion was", "scheduled Roth conversions were")} skipped on ${grouped(skippedPaths)} of ${plural(N, "path", "paths")} because the person had died.`,
    });
  }
  const totals: WarningTotals = { warnMax: summary.warnMax, warnPaths: summary.warnPaths };
  if (summary.warnMax.length !== WN_REC) throw new RangeError("aggregate: the summary's warning totals have the wrong length");
  warnings.push(...warningMessages(run.compileWarnings, totals, N));

  return {
    paths: N,
    years: Y,
    startYear,
    firstYearFraction: run.firstYearFraction,
    calendarYears,
    ages,
    drawdownStart: run.drawdownStart,
    model: run.model.summary,
    mortalityTable: run.mortality.table,
    successCount,
    fullPlanCount,
    successCi95,
    endingRealCents,
    depletionYear,
    lifetimeTaxRealCents,
    lifetimeSpendingRealCents,
    order,
    percentilePathIndex,
    endingWealthRealQuantiles,
    endingWealthReal: { p10: q(10), p25: q(25), p50: q(50), p75: q(75), p90: q(90), mean: dollarsToCentsBigInt(meanSum / N) },
    endingWealthNominal,
    percentilesBp: [...FAN_PERCENTILES_BP],
    fanReal,
    fanNominal,
    fanSpendingReal,
    aliveCount,
    fanYears,
    failureYearCounts,
    lifetimeTaxesRealMedian,
    lifetimeSpendingRealMedian,
    shortfallRealMedianOfFailures,
    digest: digest(summary.endNominal, summary.failIdx),
    warnings,
  };
}
