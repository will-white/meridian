/**
 * Row factors shared by the historical and bootstrap models (engine-and-returns §3.5 (b), (c) and
 * the year-0 rule; §2.3 `grossFirst`).
 *
 * Both models replay whole data rows: one index selects stocks, bonds, bills and inflation of one
 * calendar year together, so cross-asset correlation and the return–inflation link are history's.
 * A full year uses the row's own factors `1 + r` (no exp/log round trip). A partial year 0 uses
 * `detExp(f·m + √f·(x − m))` with x = detLog(1 + r) and m the data file's mean log return of that
 * column (the estimator's first output: 0.095471, 0.044348, 0.033160, 0.029906 on the pinned file),
 * precomputed here for every row.
 */

import { detLog } from "../detmath.js";
import { estimateLogMoments } from "./estimate.js";
import { BILLS, BONDS, type MarketPath, STOCKS, SIM_ASSET_COUNT, partialYearFactor } from "./market.js";
import { type ReturnSeries, seriesColumns, seriesLength } from "./series.js";

export interface HistoryTable {
  readonly series: ReturnSeries;
  /** Data years N. */
  readonly n: number;
  readonly firstYear: number;
  /** `1 + r` per row, row-major by (row, column) with columns stocks, bonds, bills, inflation. */
  readonly gross: Float64Array;
  /** The year-0 factors per row in the same layout: equal to `gross` when f = 1. */
  readonly grossFirst: Float64Array;
  /** The mean log returns m of the four columns (the year-0 rule's model means). */
  readonly logMeans: Float64Array;
}

export function buildHistoryTable(series: ReturnSeries, f: number): HistoryTable {
  const n = seriesLength(series);
  const columns = seriesColumns(series);
  const gross = new Float64Array(n * 4);
  for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) gross[i * 4 + j] = 1 + columns[j]![i]!;
  const logMeans = estimateLogMoments(series).mu;
  let grossFirst = gross;
  if (f < 1) {
    grossFirst = new Float64Array(n * 4);
    const sqrtF = Math.sqrt(f);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 4; j++) {
        grossFirst[i * 4 + j] = partialYearFactor(detLog(gross[i * 4 + j]!), logMeans[j]!, f, sqrtF);
      }
    }
  }
  return { series, n, firstYear: series.firstYear, gross, grossFirst, logMeans };
}

/** Writes data row i as plan year t of `out`. */
export function writeHistoryYear(table: HistoryTable, i: number, t: number, out: MarketPath): void {
  const src = t === 0 ? table.grossFirst : table.gross;
  const g = t * SIM_ASSET_COUNT;
  const r = i * 4;
  out.growth[g + STOCKS] = src[r]!;
  out.growth[g + BONDS] = src[r + 1]!;
  out.growth[g + BILLS] = src[r + 2]!;
  out.priceFactor[t] = src[r + 3]!;
  out.billsFull[t] = table.series.bills[i]!;
  out.inflationFull[t] = table.series.inflation[i]!;
  out.sampledYear[t] = table.firstYear + i;
}
