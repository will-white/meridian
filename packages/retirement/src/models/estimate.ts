/**
 * The estimator behind the parametric `historical` preset and the year-0 rule's data means
 * (engine-and-returns §3.5 (d) "Presets", `estimateLogMoments()`).
 *
 * On the log gross returns `ℓ_j,t = detLog(1 + r_j,t)` of the four columns (stocks, bonds, bills,
 * inflation), t = 1 … N:
 * - means `m_j` and sample standard deviations (divisor N − 1);
 * - the inflation persistence `φ_π = Σ_{t=2..N}(ℓ_t − m)(ℓ_{t−1} − m) / Σ_{t=1..N}(ℓ_t − m)²`;
 * - the inflation shocks `ε_t = ℓ_t − m − φ_π(ℓ_{t−1} − m)` for t = 2 … N, whose volatility the model
 *   uses is `σ_π · sqrt(1 − φ_π²)` (the innovation volatility that keeps the stationary one);
 * - Pearson correlations among the three asset logs over all N years, and between each asset log
 *   (t = 2 … N) and ε, each pair with the means of its own sample.
 * The bill persistence is 0 in the preset (§8 item 10). On the pinned file (seams §8 D2) this gives
 * μ = (0.095471, 0.044348, 0.033160, 0.029906), σ = (0.188737, 0.074201, 0.028969, 0.037719),
 * φ_π = 0.6190 and a shock volatility of 0.029624 (T13).
 *
 * Every sum runs in index order; only detLog and Math.sqrt are used (§3.14).
 */

import { detLog } from "../detmath.js";
import { type ReturnSeries, US_SERIES, seriesColumns, seriesLength } from "./series.js";

export interface LogMoments {
  /** Means of the four log series: stocks, bonds, bills, inflation. */
  readonly mu: Float64Array;
  /** Sample standard deviations (N − 1) of the four log series. */
  readonly sigma: Float64Array;
  /** Lag-1 coefficient of the inflation logs. */
  readonly phiInflation: number;
  /** `σ_π · sqrt(1 − φ_π²)`. */
  readonly shockVolatility: number;
  /** Row-major 4 × 4 correlations of the innovations: the three asset logs and the inflation shock. */
  readonly correlation: Float64Array;
  /** Sample standard deviations (N − 1) of the four simple-return series (the conservative preset's volatilities). */
  readonly simpleSd: Float64Array;
  /** The last data year's simple bill return and inflation (the parametric models' initial rates). */
  readonly lastBills: number;
  readonly lastInflation: number;
}

function mean(a: ArrayLike<number>, from: number, to: number): number {
  let s = 0;
  for (let t = from; t < to; t++) s += a[t]!;
  return s / (to - from);
}

function sampleSd(a: ArrayLike<number>): number {
  const n = a.length;
  const m = mean(a, 0, n);
  let s = 0;
  for (let t = 0; t < n; t++) {
    const d = a[t]! - m;
    s += d * d;
  }
  return Math.sqrt(s / (n - 1));
}

/** Pearson correlation of a[aFrom + k] and b[bFrom + k] for k = 0 … count − 1. */
function pearson(a: ArrayLike<number>, aFrom: number, b: ArrayLike<number>, bFrom: number, count: number): number {
  const ma = mean(a, aFrom, aFrom + count);
  const mb = mean(b, bFrom, bFrom + count);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let k = 0; k < count; k++) {
    const x = a[aFrom + k]! - ma;
    const y = b[bFrom + k]! - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  return sab / Math.sqrt(saa * sbb);
}

export function estimateLogMoments(series: ReturnSeries = US_SERIES): LogMoments {
  const n = seriesLength(series);
  if (n < 3) throw new RangeError("the estimator needs at least three data years");
  const columns = seriesColumns(series);
  const logs = columns.map((col) => {
    const out = new Float64Array(n);
    for (let t = 0; t < n; t++) out[t] = detLog(1 + col[t]!);
    return out;
  });
  const mu = new Float64Array(4);
  const sigma = new Float64Array(4);
  const simpleSd = new Float64Array(4);
  for (let j = 0; j < 4; j++) {
    mu[j] = mean(logs[j]!, 0, n);
    sigma[j] = sampleSd(logs[j]!);
    simpleSd[j] = sampleSd(columns[j]!);
  }

  const li = logs[3]!;
  const mi = mu[3]!;
  let num = 0;
  for (let t = 1; t < n; t++) num += (li[t]! - mi) * (li[t - 1]! - mi);
  let den = 0;
  for (let t = 0; t < n; t++) {
    const d = li[t]! - mi;
    den += d * d;
  }
  const phi = num / den;
  const eps = new Float64Array(n - 1);
  for (let t = 1; t < n; t++) eps[t - 1] = li[t]! - mi - phi * (li[t - 1]! - mi);

  const correlation = new Float64Array(16);
  for (let i = 0; i < 4; i++) correlation[i * 4 + i] = 1;
  const set = (i: number, j: number, v: number) => {
    correlation[i * 4 + j] = v;
    correlation[j * 4 + i] = v;
  };
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) set(i, j, pearson(logs[i]!, 0, logs[j]!, 0, n));
    set(i, 3, pearson(logs[i]!, 1, eps, 0, n - 1));
  }

  return {
    mu,
    sigma,
    phiInflation: phi,
    shockVolatility: sigma[3]! * Math.sqrt(1 - phi * phi),
    correlation,
    simpleSd,
    lastBills: series.bills[n - 1]!,
    lastInflation: series.inflation[n - 1]!,
  };
}
