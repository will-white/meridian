/**
 * What a return model produces for one path (engine-and-returns §2.4 `growth` and `priceFactor`,
 * §3.5; seams C14, C18, C22), and the first-partial-year rule shared by every model.
 *
 * Plan year 0 is the rest of the start year: `f = plan.firstYearMonths / 12` (C14, plan decision 2;
 * no day fraction exists). For a year-0 log return x whose model mean is m the part-year factor is
 * `detExp(f·m + √f·(x − m))`: mean log return f·m and variance f·σ², the right first two moments for
 * a fraction of a year. The fixed model has no dispersion (m = x), so its factor is `(1 + r)^f`.
 * With f = 1 no transformation is applied and a factor is the row's or draw's own.
 */

import { detExp } from "../detmath.js";

/** The three simulated assets, in the order of every per-year triple. */
export const STOCKS = 0;
export const BONDS = 1;
export const BILLS = 2;
export const SIM_ASSET_COUNT = 3;

/** The engine's horizon cap (engine decision 27). */
export const MAX_PLAN_YEARS = 120;

/** One path's market, filled by `ReturnModel.fillPath`; allocated once per thread and overwritten per path. */
export interface MarketPath {
  readonly years: number;
  /** Gross period factor of plan year t and simulated asset j at `growth[t * 3 + j]`; the year-0 entry is the part-year factor. */
  readonly growth: Float64Array;
  /** Period factor of the price level (1 + inflation; the part-year factor in year 0). `cpi[t + 1] = cpi[t] × priceFactor[t]`. */
  readonly priceFactor: Float64Array;
  /** Full-year inflation rate of each plan year: the `indexInflation` of seams C22 (year 0's is the model's full-year rate, not the part-year factor). */
  readonly inflationFull: Float64Array;
  /** Full-year bill return of each plan year: the bond-interest reference of the next year (seams C18). */
  readonly billsFull: Float64Array;
  /** The data year used in each plan year by the historical and bootstrap models; −1 for the others. */
  readonly sampledYear: Int16Array;
  /** Historical model: the cohort's start year, its replicate and whether its window ran past the last data year; −1, 0, false otherwise. */
  cohortStartYear: number;
  replicate: number;
  wrapped: boolean;
}

export function createMarketPath(years: number): MarketPath {
  checkYears(years);
  return {
    years,
    growth: new Float64Array(years * SIM_ASSET_COUNT),
    priceFactor: new Float64Array(years),
    inflationFull: new Float64Array(years),
    billsFull: new Float64Array(years),
    sampledYear: new Int16Array(years).fill(-1),
    cohortStartYear: -1,
    replicate: 0,
    wrapped: false,
  };
}

export function checkYears(years: number): void {
  if (!Number.isInteger(years) || years < 1 || years > MAX_PLAN_YEARS) {
    throw new RangeError(`a plan runs 1 to ${MAX_PLAN_YEARS} years, got ${years}`);
  }
}

/** f = firstYearMonths / 12 for a whole number of months 1 … 12 (12 gives exactly 1). */
export function firstYearFraction(firstYearMonths: number): number {
  if (!Number.isInteger(firstYearMonths) || firstYearMonths < 1 || firstYearMonths > 12) {
    throw new RangeError(`firstYearMonths must be a whole number 1 to 12, got ${firstYearMonths}`);
  }
  return firstYearMonths / 12;
}

/** The part-year factor `detExp(f·m + √f·(x − m))` of a full-year log return x with model mean m. */
export function partialYearFactor(x: number, m: number, f: number, sqrtF: number): number {
  return detExp(f * m + sqrtF * (x - m));
}
