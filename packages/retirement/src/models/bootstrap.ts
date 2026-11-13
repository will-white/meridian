/**
 * The stationary block bootstrap (Politis and Romano, "The Stationary Bootstrap", JASA 89(428),
 * 1994; engine-and-returns decision 16 and §3.5 (c); plan decision 6).
 *
 * With p = 1 / meanBlockYears (a whole number of years, 1 … 30): plan year 0 starts a block at a
 * uniformly random data row; each later year starts a new block with probability p, at a uniformly
 * random row, and otherwise takes the next calendar year, wrapping from the last data year to the
 * first. Block lengths are geometric with mean 1/p, the circular series makes every year equally
 * likely at every position, and one index selects a whole row, so cross-asset correlation, the
 * return–inflation link and serial dependence inside a block are history's. `meanBlockYears = 1` is
 * the plain independent bootstrap (a uniform is always below 1).
 *
 * Draws: the decision of year t is `uniformAt(BOOT, t, 0)`, its start row `floor(uniformAt(BOOT, t, 1) × N)`.
 */

import { EngineInputError } from "../errors.js";
import { PURPOSE, type RngKey, uniformAt } from "../rng.js";
import { type HistoryTable, writeHistoryYear } from "./history.js";
import type { MarketPath } from "./market.js";

export const MAX_MEAN_BLOCK_YEARS = 30;

export function checkMeanBlockYears(meanBlockYears: number): void {
  if (!Number.isInteger(meanBlockYears) || meanBlockYears < 1 || meanBlockYears > MAX_MEAN_BLOCK_YEARS) {
    throw new EngineInputError("mean_block_invalid", `the mean block length must be a whole number of years from 1 to ${MAX_MEAN_BLOCK_YEARS}, got ${meanBlockYears}`);
  }
}

/** The rows of plan years 0 … years − 1 into `out`; p = 1 / meanBlockYears, unchecked. */
function selectRows(key: RngKey, path: number, years: number, n: number, p: number, out: Int16Array): void {
  let i = 0;
  for (let t = 0; t < years; t++) {
    if (t === 0 || uniformAt(key, path, PURPOSE.BOOT, t, 0) < p) {
      i = Math.floor(uniformAt(key, path, PURPOSE.BOOT, t, 1) * n);
    } else {
      i = i + 1 === n ? 0 : i + 1;
    }
    out[t] = i;
  }
}

/** The data row of each plan year t = 0 … years − 1 of one path, written into `out` (allocated when absent). */
export function bootstrapIndices(
  key: RngKey,
  path: number,
  years: number,
  n: number,
  meanBlockYears: number,
  out: Int16Array = new Int16Array(years),
): Int16Array {
  checkMeanBlockYears(meanBlockYears);
  if (out.length < years) throw new RangeError(`bootstrapIndices: out holds ${out.length} years, ${years} asked`);
  selectRows(key, path, years, n, 1 / meanBlockYears, out);
  return out;
}

/** Fills one path of the bootstrap model; `rows` is the caller's scratch of at least `out.years` entries. */
export function fillBootstrapPath(table: HistoryTable, key: RngKey, meanBlockYears: number, pathIndex: number, out: MarketPath, rows: Int16Array): void {
  selectRows(key, pathIndex, out.years, table.n, 1 / meanBlockYears, rows);
  for (let t = 0; t < out.years; t++) writeHistoryYear(table, rows[t]!, t, out);
  out.cohortStartYear = -1;
  out.replicate = 0;
  out.wrapped = false;
}
