/**
 * The historical series the return models read (engine-and-returns decision 4, §2.8; seams §8 D2):
 * simple annual rates as fractions, one entry per calendar year, from the generated module (built
 * from `data/us-annual-returns.csv` by `scripts/build-data.mjs`). Tests may pass another series of
 * the same shape.
 */

import { US_BILLS, US_BONDS, US_FIRST_YEAR, US_INFLATION, US_STOCKS } from "../generated/data.js";

export interface ReturnSeries {
  /** Calendar year of index 0. */
  readonly firstYear: number;
  readonly stocks: Float64Array;
  readonly bonds: Float64Array;
  readonly bills: Float64Array;
  readonly inflation: Float64Array;
}

/** S&P 500 total return, 10-year Treasury total return, 3-month T-bill return and CPI-U inflation, 1928 to 2025. */
export const US_SERIES: ReturnSeries = {
  firstYear: US_FIRST_YEAR,
  stocks: US_STOCKS,
  bonds: US_BONDS,
  bills: US_BILLS,
  inflation: US_INFLATION,
};

/** The number of data years; throws when the four columns differ in length or are empty. */
export function seriesLength(series: ReturnSeries): number {
  const n = series.stocks.length;
  if (n === 0 || series.bonds.length !== n || series.bills.length !== n || series.inflation.length !== n) {
    throw new RangeError("a return series needs four non-empty columns of equal length");
  }
  return n;
}

/** The four columns in the order of the parametric model's variables (stocks, bonds, bills, inflation). */
export function seriesColumns(series: ReturnSeries): readonly [Float64Array, Float64Array, Float64Array, Float64Array] {
  return [series.stocks, series.bonds, series.bills, series.inflation];
}
