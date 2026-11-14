/**
 * `toSimSummary` and `toFanSeries` (strategies-outputs-web §3.9 and §3.10 with seams C40, C44,
 * C45 and C46): pure mappers from the aggregated run (`EngineResult`, cents as bigint) to the
 * stored shapes of shared `results.ts` (cents as strings, ratios as integer basis points or ppm).
 *
 * Ratios computed inside the engine from float64 (the Wilson bounds, the first-year fraction) are
 * rounded half away from zero at the boundary (C44, `units.ts`); `fundedBp` is computed from path
 * counts with the shared `fundedShareBp`, which truncates (the rule outside the engine).
 */

import { type FanSeries, type SimInput, type SimSummary, fundedShareBp } from "@meridian/shared";
import type { Cents, EngineResult } from "../aggregate.js";
import { EngineInvariantError } from "../errors.js";
import { ratioToBp, ratioToPpm } from "../units.js";
import { DATA_CHECKSUM } from "../version.js";

const str = (c: Cents) => c.toString();

/**
 * The failure block (§3.10): the first-failure counts by plan year, the calendar year of the first
 * non-zero count and the calendar year at which the running count first reaches
 * `ceil(failures ÷ 2)` (C46's depletion years); both absent when no path failed.
 */
export function failureSummary(failureYearCounts: readonly number[], startYear: number): SimSummary["failure"] {
  let paths = 0;
  for (const c of failureYearCounts) paths += c;
  const out: SimSummary["failure"] = { paths, byYear: [...failureYearCounts] };
  if (paths === 0) return out;
  const half = Math.ceil(paths / 2);
  let running = 0;
  for (let t = 0; t < failureYearCounts.length; t++) {
    const c = failureYearCounts[t]!;
    if (c > 0 && out.firstDepletionYear === undefined) out.firstDepletionYear = startYear + t;
    running += c;
    if (running >= half) {
      out.medianDepletionYear = startYear + t;
      break;
    }
  }
  return out;
}

/** The stored run summary (`sim_run.summary`). */
export function toSimSummary(result: EngineResult, input: SimInput): SimSummary {
  const failure = failureSummary(result.failureYearCounts, result.startYear);
  if (failure.paths !== result.paths - result.successCount) {
    throw new EngineInvariantError("result_inconsistent", `${failure.paths} first failures but ${result.paths - result.successCount} failed paths`);
  }
  const ew = result.endingWealthReal;
  const en = result.endingWealthNominal;
  const summary: SimSummary = {
    schemaVersion: 1,
    paths: result.paths,
    successPaths: result.successCount,
    fullPlanPaths: result.fullPlanCount,
    endingWealthReal: { p10: str(ew.p10), p25: str(ew.p25), p50: str(ew.p50), p75: str(ew.p75), p90: str(ew.p90), mean: str(ew.mean) },
    endingWealthNominal: { p10: str(en.p10), p50: str(en.p50), p90: str(en.p90) },
    failure,
    lifetimeSpendingRealP50: str(result.lifetimeSpendingRealMedian),
    lifetimeTaxesRealP50: str(result.lifetimeTaxesRealMedian),
    model: { ...result.model },
    mortalityTable: result.mortalityTable,
    strategy: input.settings.strategy.kind,
    startYear: result.startYear,
    firstYearFractionPpm: ratioToPpm(result.firstYearFraction),
    dataChecksum: DATA_CHECKSUM,
    digest: result.digest,
  };
  if (result.successCi95 !== null) summary.successCi95Bp = [ratioToBp(result.successCi95[0]), ratioToBp(result.successCi95[1])];
  if (result.shortfallRealMedianOfFailures !== null) summary.shortfallRealP50OfFailures = str(result.shortfallRealMedianOfFailures);
  return summary;
}

type Band = FanSeries["real"];

function band(fan: ReadonlyArray<ReadonlyArray<Cents | null>>, from: number, to: number, what: string): Band {
  const row = (j: number): string[] => {
    const values = fan[j]!.slice(from, to);
    return values.map((v, i) => {
      if (v === null) throw new EngineInvariantError("result_inconsistent", `the ${what} fan has no path alive in plan year ${from + i}`);
      return v.toString();
    });
  };
  return { p10: row(0), p25: row(1), p50: row(2), p75: row(3), p90: row(4) };
}

/**
 * The stored fan (`sim_run.fan`, §3.10): the five percentiles of the end-of-year portfolio (today's
 * dollars and nominal) and of funded spending (today's dollars), over the leading plan years with
 * at least `min(100, paths)` paths alive (`truncated` says whether later years were cut); the
 * spending bands start at the first drawdown year (`spendingFromIndex`), so no entry is missing.
 */
export function toFanSeries(result: EngineResult): FanSeries {
  const n = result.fanYears;
  const from = result.drawdownStart < n ? result.drawdownStart : n;
  return {
    schemaVersion: 1,
    years: result.calendarYears.slice(0, n),
    ages: result.ages.map((a) => a.slice(0, n)),
    aliveCount: result.aliveCount.slice(0, n),
    fundedBp: fundedShareBp(result.paths, result.failureYearCounts).slice(0, n),
    truncated: n < result.years,
    real: band(result.fanReal, 0, n, "real"),
    nominal: band(result.fanNominal, 0, n, "nominal"),
    spendingFromIndex: from,
    spendingReal: band(result.fanSpendingReal, from, n, "spending"),
  };
}
