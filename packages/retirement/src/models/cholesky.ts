/**
 * Cholesky factor of a covariance matrix (engine-and-returns §3.4), for the parametric model's
 * correlated innovations.
 *
 * Cholesky–Banachiewicz, row by row: `L_ij = (M_ij − Σ_{k<j} L_ik·L_jk) / L_jj` for j < i and
 * `L_ii = sqrt(M_ii − Σ_{k<i} L_ik²)`, each sum taken in increasing k. A pivot at or below 1e-14
 * (or NaN) means the matrix is not positive definite: `EngineInputError("correlation_not_positive_definite")`.
 * A zero variance is therefore refused too, which is why every series of a custom model needs a
 * volatility above 0.
 */

import { EngineInputError } from "../errors.js";

/** The smallest pivot accepted. */
export const CHOLESKY_MIN_PIVOT = 1e-14;

/** The row-major lower factor L of the n × n row-major matrix m (only its lower triangle is read), with L·Lᵀ = m. */
export function cholesky(m: ArrayLike<number>, n: number): Float64Array {
  if (m.length !== n * n) throw new RangeError(`cholesky: expected ${n * n} entries, got ${m.length}`);
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let v = m[i * n + j]!;
      for (let k = 0; k < j; k++) v -= l[i * n + k]! * l[j * n + k]!;
      if (i === j) {
        if (!(v > CHOLESKY_MIN_PIVOT)) {
          throw new EngineInputError(
            "correlation_not_positive_definite",
            "These correlations cannot all hold at once (the covariance matrix is not positive definite); lower one of them, and give every series a volatility above 0",
          );
        }
        l[i * n + i] = Math.sqrt(v);
      } else {
        l[i * n + j] = v / l[j * n + j]!;
      }
    }
  }
  return l;
}

/** The covariance `Σ_ij = ρ_ij · s_i · s_j` (row-major) of volatilities s and a row-major correlation matrix ρ. */
export function covarianceFrom(vols: ArrayLike<number>, correlation: ArrayLike<number>): Float64Array {
  const n = vols.length;
  if (correlation.length !== n * n) throw new RangeError(`covarianceFrom: expected ${n * n} correlations, got ${correlation.length}`);
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) out[i * n + j] = correlation[i * n + j]! * vols[i]! * vols[j]!;
  }
  return out;
}
