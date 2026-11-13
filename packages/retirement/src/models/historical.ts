/**
 * Historical cohorts (engine-and-returns decisions 14 and 15, §3.5 (b); plan decision 7; seams C6).
 *
 * A cohort is a start year of the record followed in calendar order. With N data years and a
 * horizon of Y plan years there are `N − Y + 1` complete cohorts.
 * - `complete` uses only start years whose whole window fits (the Trinity, FIRECalc and cFIREsim
 *   rule) and needs at least one (`historical_horizon_too_long` otherwise).
 * - `wrap` uses all N start years and continues from the first data year after the last.
 * - `auto` (the default) is `complete` when every person has a fixed life expectancy and at least
 *   30 complete cohorts exist, `wrap` otherwise. With mortality draws the horizon runs to `maxAge`
 *   (seams C28), which would leave few complete windows although almost no path lives that long.
 *
 * Path k uses cohort `c = k mod C` and replicate `floor(k / C)`; plan year t uses data row
 * `(c + t) mod N`. Effective path count (C6): C when every person has a fixed life expectancy
 * (repeating an identical market adds nothing), otherwise `C × ceil(requested / C)` so every cohort
 * gets the same number of mortality draws. The historical model draws no random numbers.
 */

import type { CohortMode, HistoricalCohorts } from "@meridian/shared";
import { EngineInputError } from "../errors.js";
import { type HistoryTable, writeHistoryYear } from "./history.js";
import { type MarketPath, checkYears } from "./market.js";

/** The fewest complete cohorts `auto` accepts before it wraps. */
export const MIN_COMPLETE_COHORTS = 30;

export interface CohortPlan {
  readonly mode: CohortMode;
  /** C: the number of start years used. */
  readonly cohortCount: number;
  /** Paths per cohort: 1 with fixed life expectancies, else ceil(requested / C). */
  readonly replicates: number;
  /** The effective path count, C × replicates. */
  readonly paths: number;
  readonly firstStartYear: number;
  readonly lastStartYear: number;
  /** N and the calendar year of data row 0. */
  readonly dataYears: number;
  readonly firstDataYear: number;
  /** The horizon Y the plan was made for. */
  readonly years: number;
}

export interface CohortPlanOptions {
  readonly cohorts: HistoricalCohorts;
  /** The horizon in plan years. */
  readonly years: number;
  /** Every person has a fixed life expectancy (no mortality draws). */
  readonly allFixedLongevity: boolean;
  readonly requestedPaths: number;
  readonly dataYears: number;
  readonly firstDataYear: number;
}

export function planCohorts(o: CohortPlanOptions): CohortPlan {
  checkYears(o.years);
  if (!Number.isInteger(o.requestedPaths) || o.requestedPaths < 1) {
    throw new RangeError(`the requested path count must be a whole number of at least 1, got ${o.requestedPaths}`);
  }
  const n = o.dataYears;
  const complete = n - o.years + 1;
  let mode: CohortMode;
  if (o.cohorts === "complete") {
    if (complete < 1) {
      throw new EngineInputError(
        "historical_horizon_too_long",
        `This plan is longer than the historical record allows with complete cycles (${o.years} years against ${n} years of data); switch to wrap-around or shorten the plan`,
      );
    }
    mode = "complete";
  } else if (o.cohorts === "wrap") {
    mode = "wrap";
  } else {
    mode = o.allFixedLongevity && complete >= MIN_COMPLETE_COHORTS ? "complete" : "wrap";
  }
  const cohortCount = mode === "complete" ? complete : n;
  // ceil(requested / C) in integer arithmetic.
  const replicates = o.allFixedLongevity ? 1 : Math.floor((o.requestedPaths + cohortCount - 1) / cohortCount);
  return {
    mode,
    cohortCount,
    replicates,
    paths: cohortCount * replicates,
    firstStartYear: o.firstDataYear,
    lastStartYear: o.firstDataYear + cohortCount - 1,
    dataYears: n,
    firstDataYear: o.firstDataYear,
    years: o.years,
  };
}

export interface Cohort {
  /** The data row of plan year 0. */
  readonly startIndex: number;
  readonly startYear: number;
  readonly replicate: number;
  /** The window of `plan.years` years runs past the last data year (only possible in wrap mode). */
  readonly wrapped: boolean;
}

export function cohortFor(plan: CohortPlan, pathIndex: number): Cohort {
  if (!Number.isInteger(pathIndex) || pathIndex < 0) throw new RangeError(`a path index is a whole number ≥ 0, got ${pathIndex}`);
  const c = pathIndex % plan.cohortCount;
  return {
    startIndex: c,
    startYear: plan.firstDataYear + c,
    replicate: Math.floor(pathIndex / plan.cohortCount),
    wrapped: c + plan.years > plan.dataYears,
  };
}

/** Fills one path of the historical model (the same mapping as `cohortFor`, without allocating). */
export function fillHistoricalPath(table: HistoryTable, plan: CohortPlan, pathIndex: number, out: MarketPath): void {
  const c = pathIndex % plan.cohortCount;
  const n = table.n;
  let i = c;
  for (let t = 0; t < out.years; t++) {
    writeHistoryYear(table, i, t, out);
    i = i + 1 === n ? 0 : i + 1;
  }
  out.cohortStartYear = plan.firstDataYear + c;
  out.replicate = Math.floor(pathIndex / plan.cohortCount);
  out.wrapped = c + plan.years > plan.dataYears;
}
