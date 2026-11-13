/**
 * From a simple-return mean and volatility to lognormal parameters (engine-and-returns §3.5 (d) 1).
 *
 * A gross return G = e^X with X ~ N(μ, σ²). The owner gives the mean (arithmetic or geometric) and
 * the volatility S (the standard deviation of the simple annual rate); both conversions reproduce the
 * requested mean and S exactly for a lognormal:
 *
 * - arithmetic mean A: `σ² = ln(1 + S² / (1 + A)²)`, `μ = ln(1 + A) − σ²/2` (so E[G] = 1 + A);
 * - geometric mean g:  `μ = ln(1 + g)`, `y = (1 + sqrt(1 + 4 S² / (1 + g)²)) / 2`, `σ² = ln y`
 *   (the median growth is 1 + g, and Var[G] = e^{2μ+σ²}(e^{σ²} − 1) = S²).
 *
 * Logarithms are `detLog` (§3.14). The mean must be above −100%.
 */

import { detLog } from "../detmath.js";

export interface LogParams {
  /** The mean of the log gross return. */
  mu: number;
  /** The standard deviation of the log gross return. */
  sigma: number;
}

export function lognormalFromArithmetic(mean: number, vol: number): LogParams {
  const g = 1 + mean;
  if (!(g > 0)) throw new RangeError(`lognormalFromArithmetic: the mean must be above −100%, got ${mean}`);
  const s2 = detLog(1 + (vol * vol) / (g * g));
  return { mu: detLog(g) - s2 / 2, sigma: Math.sqrt(s2) };
}

export function lognormalFromGeometric(mean: number, vol: number): LogParams {
  const g = 1 + mean;
  if (!(g > 0)) throw new RangeError(`lognormalFromGeometric: the mean must be above −100%, got ${mean}`);
  const y = (1 + Math.sqrt(1 + (4 * vol * vol) / (g * g))) / 2;
  return { mu: detLog(g), sigma: Math.sqrt(detLog(y)) };
}
