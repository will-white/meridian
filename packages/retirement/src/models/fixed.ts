/**
 * The deterministic `fixed` model (engine-and-returns decision 30, §3.5 (a); seams C3, C6), for
 * hand-calculated tests and the reference scenarios R1 and R2. Plan year t uses row
 * `min(t, length − 1)`, so the last row repeats. Rows are parts per million (six decimals, the data
 * file's precision), converted to fractions here once.
 *
 * The year-0 rule with no dispersion (m = x) is plain compounding: a partial year 0 has the factor
 * `(1 + r)^f = detPow(1 + r, f)`, the price level included; with f = 1 the factor is `1 + r`.
 */

import type { FixedReturnRow } from "@meridian/shared";
import { detPow } from "../detmath.js";
import { BILLS, BONDS, type MarketPath, STOCKS, SIM_ASSET_COUNT } from "./market.js";

const PPM = 1_000_000;

export class FixedPaths {
  /** Simple rates by row: stocks, bonds, bills, inflation, row-major. */
  readonly rates: Float64Array;
  readonly rows: number;
  /** Row 0's year-0 factors (part-year when f < 1). */
  private readonly first: Float64Array;

  constructor(series: readonly FixedReturnRow[], f: number) {
    if (series.length < 1) throw new RangeError("a fixed series needs at least one row");
    this.rows = series.length;
    this.rates = new Float64Array(series.length * 4);
    series.forEach((row, i) => {
      this.rates[i * 4] = row.stocksPpm / PPM;
      this.rates[i * 4 + 1] = row.bondsPpm / PPM;
      this.rates[i * 4 + 2] = row.billsPpm / PPM;
      this.rates[i * 4 + 3] = row.inflationPpm / PPM;
    });
    this.first = new Float64Array(4);
    for (let j = 0; j < 4; j++) {
      const gross = 1 + this.rates[j]!;
      this.first[j] = f < 1 ? detPow(gross, f) : gross;
    }
  }

  /** Row 0's bill rate: the year-0 bond-interest reference (seams C18). */
  get firstBillRate(): number {
    return this.rates[2]!;
  }

  fill(out: MarketPath): void {
    for (let t = 0; t < out.years; t++) {
      const r = (t < this.rows ? t : this.rows - 1) * 4;
      const g = t * SIM_ASSET_COUNT;
      if (t === 0) {
        out.growth[g + STOCKS] = this.first[0]!;
        out.growth[g + BONDS] = this.first[1]!;
        out.growth[g + BILLS] = this.first[2]!;
        out.priceFactor[t] = this.first[3]!;
      } else {
        out.growth[g + STOCKS] = 1 + this.rates[r]!;
        out.growth[g + BONDS] = 1 + this.rates[r + 1]!;
        out.growth[g + BILLS] = 1 + this.rates[r + 2]!;
        out.priceFactor[t] = 1 + this.rates[r + 3]!;
      }
      out.billsFull[t] = this.rates[r + 2]!;
      out.inflationFull[t] = this.rates[r + 3]!;
      out.sampledYear[t] = -1;
    }
    out.cohortStartYear = -1;
    out.replicate = 0;
    out.wrapped = false;
  }
}
