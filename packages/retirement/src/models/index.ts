/**
 * The return models (engine-and-returns §3.5; seams C3, C6, C14, C18, C22, C51; plan decisions 2,
 * 6 and 7): one compiled model per run and thread, filling one path's market at a time.
 *
 * `compileReturnModel(settings.returnModel, …)` converts the stored integer settings once (C3),
 * decides the effective path count (C6) and precomputes the year-0 factors for
 * `f = plan.firstYearMonths / 12` (C14). `fillPath(k, out)` then writes path k's period factors,
 * full-year inflation (C22's `indexInflation`) and full-year bill returns (C18's reference for the
 * next year) into a `MarketPath` allocated once per thread. A path depends only on (model, key, k).
 */

import type { ReturnModelConfig, ReturnModelKind, SimSummary } from "@meridian/shared";
import type { RngKey } from "../rng.js";
import type { EngineWarning } from "../warning.js";
import { checkMeanBlockYears, fillBootstrapPath } from "./bootstrap.js";
import { FixedPaths } from "./fixed.js";
import { buildHistoryTable } from "./history.js";
import { type CohortPlan, fillHistoricalPath, planCohorts } from "./historical.js";
import { type MarketPath, checkYears, firstYearFraction } from "./market.js";
import { ParametricPaths, conservativePresetParams, customParams, historicalPresetParams } from "./parametric.js";
import type { ParametricLogParams } from "./parametric.js";
import { type ReturnSeries, US_SERIES, seriesLength } from "./series.js";
import { EngineInputError } from "../errors.js";

export interface ReturnModelOptions {
  /** The generator key (`seedKey(settings.seed)`). */
  readonly key: RngKey;
  /** The horizon Y in plan years. */
  readonly years: number;
  /** `plan.firstYearMonths`, 1 … 12. */
  readonly firstYearMonths: number;
  /** `settings.paths`. */
  readonly requestedPaths: number;
  /** Every person has a fixed life expectancy (no mortality draws). */
  readonly allFixedLongevity: boolean;
  /** The historical series; the pinned US record when absent. */
  readonly series?: ReturnSeries;
}

export interface ReturnModel {
  readonly kind: ReturnModelKind;
  readonly years: number;
  /** f = firstYearMonths / 12. */
  readonly firstYearFraction: number;
  /** The effective path count (C6). */
  readonly paths: number;
  /** `SimSummary.model`. */
  readonly summary: SimSummary["model"];
  /** The year-0 bond-interest reference (C18): `bills.initial` (parametric), row 0 (fixed), else the data's last bill return. */
  readonly billRef0: number;
  /** The historical model's cohorts. */
  readonly cohorts?: CohortPlan;
  /** The parametric model's log parameters, as compiled. */
  readonly parametric?: ParametricLogParams;
  readonly warnings: readonly EngineWarning[];
  /** Writes path k (0 ≤ k < paths) into `out`, which must have `years` years. */
  fillPath(pathIndex: number, out: MarketPath): void;
}

/** A whole number with thousands separators ("10,094"), without the locale machinery. */
function fmt(n: number): string {
  const digits = String(n);
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

function pathCountWarning(paths: number, requested: number, why: string): EngineWarning[] {
  if (paths === requested) return [];
  return [{ code: "path_count_adjusted", message: `${why}: ${fmt(paths)} paths instead of the ${fmt(requested)} requested.` }];
}

export function compileReturnModel(config: ReturnModelConfig, options: ReturnModelOptions): ReturnModel {
  const { key, years, requestedPaths, allFixedLongevity } = options;
  checkYears(years);
  if (!Number.isInteger(requestedPaths) || requestedPaths < 1) {
    throw new RangeError(`the requested path count must be a whole number of at least 1, got ${requestedPaths}`);
  }
  const f = firstYearFraction(options.firstYearMonths);
  const series = options.series ?? US_SERIES;
  const n = seriesLength(series);
  const lastBills = series.bills[n - 1]!;
  const base = { kind: config.kind, years, firstYearFraction: f };

  const checked = (paths: number, fill: (k: number, out: MarketPath) => void) => (k: number, out: MarketPath) => {
    if (!Number.isInteger(k) || k < 0 || k >= paths) throw new RangeError(`path ${k} is outside 0 … ${paths - 1}`);
    if (out.years !== years) throw new RangeError(`the market path holds ${out.years} years, the model ${years}`);
    fill(k, out);
  };

  switch (config.kind) {
    case "historical": {
      const table = buildHistoryTable(series, f);
      const cohorts = planCohorts({
        cohorts: config.cohorts,
        years,
        allFixedLongevity,
        requestedPaths,
        dataYears: n,
        firstDataYear: series.firstYear,
      });
      const warnings: EngineWarning[] = [];
      if (cohorts.mode === "wrap") {
        warnings.push({
          code: "historical_wrapped",
          message: `Historical sequences wrap around: after ${series.firstYear + n - 1} a path continues from ${series.firstYear}, a sequence that never happened.`,
        });
      }
      warnings.push(...pathCountWarning(cohorts.paths, requestedPaths, allFixedLongevity ? "The historical model runs one path per start year" : "The historical model runs the same number of mortality draws for every start year"));
      return {
        ...base,
        paths: cohorts.paths,
        summary: {
          kind: "historical",
          requestedPaths,
          cohortMode: cohorts.mode,
          cohortCount: cohorts.cohortCount,
          firstStartYear: cohorts.firstStartYear,
          lastStartYear: cohorts.lastStartYear,
        },
        billRef0: lastBills,
        cohorts,
        warnings,
        fillPath: checked(cohorts.paths, (k, out) => fillHistoricalPath(table, cohorts, k, out)),
      };
    }
    case "bootstrap": {
      checkMeanBlockYears(config.meanBlockYears);
      const table = buildHistoryTable(series, f);
      const rows = new Int16Array(years);
      const meanBlockYears = config.meanBlockYears;
      return {
        ...base,
        paths: requestedPaths,
        summary: { kind: "bootstrap", requestedPaths, meanBlockYears },
        billRef0: lastBills,
        warnings: [],
        fillPath: checked(requestedPaths, (k, out) => fillBootstrapPath(table, key, meanBlockYears, k, out, rows)),
      };
    }
    case "parametric": {
      let params: ParametricLogParams;
      if (config.preset === "historical") params = historicalPresetParams(series);
      else if (config.preset === "conservative") params = conservativePresetParams(series);
      else if (config.params === undefined) throw new EngineInputError("custom_params_required", "the custom parametric model needs its parameters");
      else params = customParams(config.params, series);
      const model = new ParametricPaths(params, key, f);
      return {
        ...base,
        paths: requestedPaths,
        summary: { kind: "parametric", requestedPaths, preset: config.preset },
        billRef0: params.billsInitial,
        parametric: params,
        warnings: [],
        fillPath: checked(requestedPaths, (k, out) => model.fill(k, out)),
      };
    }
    case "fixed": {
      const model = new FixedPaths(config.series, f);
      const paths = allFixedLongevity ? 1 : requestedPaths;
      return {
        ...base,
        paths,
        summary: { kind: "fixed", requestedPaths },
        billRef0: model.firstBillRate,
        warnings: pathCountWarning(paths, requestedPaths, "The fixed model has one market path, and every life expectancy is fixed"),
        fillPath: checked(paths, (_k, out) => model.fill(out)),
      };
    }
  }
}

export { createMarketPath, firstYearFraction, partialYearFactor, MAX_PLAN_YEARS, BILLS, BONDS, STOCKS, SIM_ASSET_COUNT } from "./market.js";
export type { MarketPath } from "./market.js";
export type { CohortPlan, Cohort } from "./historical.js";
export { MIN_COMPLETE_COHORTS, cohortFor, planCohorts } from "./historical.js";
export { MAX_MEAN_BLOCK_YEARS, bootstrapIndices } from "./bootstrap.js";
export {
  CONSERVATIVE_GEOMETRIC_MEANS_BP,
  compileParametricCore,
  conservativePresetParams,
  customParams,
  historicalPresetParams,
  innovationVolatilities,
  parametricStep,
} from "./parametric.js";
export type { ParametricCore, ParametricLogParams } from "./parametric.js";
export { estimateLogMoments } from "./estimate.js";
export type { LogMoments } from "./estimate.js";
export { US_SERIES } from "./series.js";
export type { ReturnSeries } from "./series.js";
