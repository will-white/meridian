/**
 * The parametric model: correlated lognormal returns (engine-and-returns decision 17, §3.5 (d);
 * seams C3, G2; spec "correlated lognormal returns with user-set expected returns and volatilities").
 *
 * Four variables in the order stocks, bonds, bills, inflation. Each has a stationary log mean μ and
 * log volatility σ. Log inflation is AR(1) with persistence φ_π; log bill returns may be AR(1) with
 * φ_C (0 by default). Innovation volatilities `s = (σ_S, σ_B, σ_C·sqrt(1 − φ_C²), σ_π·sqrt(1 − φ_π²))`
 * keep each series' stationary volatility; their covariance is `Σ_ij = ρ_ij s_i s_j` with ρ the
 * correlation matrix of the innovations, and `L = cholesky(Σ)`.
 *
 * Each plan year: `z_j = invNorm(uniformAt(MARKET, t, j))`, `e = L z`; conditional means `c_S = μ_S`,
 * `c_B = μ_B`, `c_C = μ_C + φ_C(ℓC_{t−1} − μ_C)`, `c_π = μ_π + φ_π(ℓπ_{t−1} − μ_π)` with
 * `ℓ_{−1} = ln(1 + initial)`; log rates `c_j + e_j`, factors `detExp(c_j + e_j)`. In a partial year 0
 * the factors are `detExp(f·c_j + √f·e_j)` while the stored ℓ values stay the full-year rates (so
 * year 1 is the same whatever f is). With every persistence 0 this is the plain iid model.
 *
 * Presets: `historical` (the estimator's log moments, φ_C = 0); `conservative` (geometric means
 * 5.5%, 4.5%, 3.2%, 2.5% with the data's simple-return volatilities, persistence and correlations as
 * in `historical`); `custom` (the owner's integer basis points, C3, converted here once).
 */

import type { ParametricParams } from "@meridian/shared";
import { detExpInPlace, detLog } from "../detmath.js";
import { EngineInputError } from "../errors.js";
import { PURPOSE, type RngKey, invNormInPlace, uniformsAt } from "../rng.js";
import { cholesky, covarianceFrom } from "./cholesky.js";
import { estimateLogMoments } from "./estimate.js";
import { lognormalFromArithmetic, lognormalFromGeometric } from "./lognormal.js";
import { BILLS, BONDS, type MarketPath, STOCKS, SIM_ASSET_COUNT } from "./market.js";
import { type ReturnSeries, US_SERIES } from "./series.js";

/** Indices of the four variables. */
export const PV_STOCKS = 0;
export const PV_BONDS = 1;
export const PV_BILLS = 2;
export const PV_INFLATION = 3;

/**
 * The conservative preset's geometric nominal means in basis points: stocks, bonds, bills, inflation
 * (engine-and-returns §3.5 (d)). An assumption of the design, placed between published ten-year
 * outlooks (its §10), not a measured figure (seams §9 item 11). Engine behaviour: a change bumps
 * ENGINE_VERSION.
 */
export const CONSERVATIVE_GEOMETRIC_MEANS_BP = [550, 450, 320, 250] as const;

/** The model's parameters in log space, before compilation. */
export interface ParametricLogParams {
  /** Stationary log means of stocks, bonds, bills, inflation. */
  readonly mu: readonly number[];
  /** Stationary log volatilities. */
  readonly sigma: readonly number[];
  readonly phiBills: number;
  readonly phiInflation: number;
  /** Row-major 4 × 4 correlations of the innovations; symmetric with a unit diagonal. */
  readonly correlation: ArrayLike<number>;
  /** Simple rates of the year before plan year 0 (`bills.initial`, `inflation.initial`). */
  readonly billsInitial: number;
  readonly inflationInitial: number;
}

/** What one year's draw needs. */
export interface ParametricCore {
  readonly mu: Float64Array;
  readonly phiBills: number;
  readonly phiInflation: number;
  /** Row-major lower Cholesky factor of the innovations' covariance. */
  readonly chol: Float64Array;
}

/** `(σ_S, σ_B, σ_C·sqrt(1 − φ_C²), σ_π·sqrt(1 − φ_π²))`. */
export function innovationVolatilities(p: ParametricLogParams): Float64Array {
  return new Float64Array([
    p.sigma[PV_STOCKS]!,
    p.sigma[PV_BONDS]!,
    p.sigma[PV_BILLS]! * Math.sqrt(1 - p.phiBills * p.phiBills),
    p.sigma[PV_INFLATION]! * Math.sqrt(1 - p.phiInflation * p.phiInflation),
  ]);
}

function checkParams(p: ParametricLogParams): void {
  if (p.mu.length !== 4 || p.sigma.length !== 4 || p.correlation.length !== 16) {
    throw new RangeError("parametric parameters need four means, four volatilities and a 4 × 4 correlation matrix");
  }
  for (const phi of [p.phiBills, p.phiInflation]) {
    if (!(phi >= 0 && phi < 1)) throw new EngineInputError("persistence_invalid", `a persistence must lie in [0, 1), got ${phi}`);
  }
  for (let i = 0; i < 4; i++) {
    if (p.correlation[i * 4 + i] !== 1) throw new EngineInputError("correlation_not_symmetric", "the correlation matrix must have a unit diagonal");
    for (let j = 0; j < i; j++) {
      const v = p.correlation[i * 4 + j]!;
      if (v !== p.correlation[j * 4 + i] || !(v >= -1 && v <= 1)) {
        throw new EngineInputError("correlation_not_symmetric", "the correlation matrix must be symmetric with entries in [−1, 1]");
      }
    }
  }
}

/** Builds Σ and its Cholesky factor; `correlation_not_positive_definite` when it has none. */
export function compileParametricCore(p: ParametricLogParams): ParametricCore {
  checkParams(p);
  const chol = cholesky(covarianceFrom(innovationVolatilities(p), p.correlation), 4);
  return { mu: Float64Array.from(p.mu), phiBills: p.phiBills, phiInflation: p.phiInflation, chol };
}

/**
 * One year of the model: writes the conditional means `c` to `out[0..3]` and the innovations
 * `e = L z` to `out[4..7]`, and replaces `state = [ℓC_{t−1}, ℓπ_{t−1}]` with this year's full-year
 * log rates. Each innovation is summed over k = 0 … i in order.
 */
export function parametricStep(core: ParametricCore, z: ArrayLike<number>, state: Float64Array, out: Float64Array): void {
  const mu = core.mu;
  const l = core.chol;
  out[PV_STOCKS] = mu[PV_STOCKS]!;
  out[PV_BONDS] = mu[PV_BONDS]!;
  out[PV_BILLS] = mu[PV_BILLS]! + core.phiBills * (state[0]! - mu[PV_BILLS]!);
  out[PV_INFLATION] = mu[PV_INFLATION]! + core.phiInflation * (state[1]! - mu[PV_INFLATION]!);
  for (let i = 0; i < 4; i++) {
    let e = 0;
    for (let k = 0; k <= i; k++) e += l[i * 4 + k]! * z[k]!;
    out[4 + i] = e;
  }
  state[0] = out[PV_BILLS]! + out[4 + PV_BILLS]!;
  state[1] = out[PV_INFLATION]! + out[4 + PV_INFLATION]!;
}

/** The `historical` preset: the estimator's log moments on the data file, φ_C = 0, initial rates = the last data year. */
export function historicalPresetParams(series: ReturnSeries = US_SERIES): ParametricLogParams {
  const m = estimateLogMoments(series);
  return {
    mu: Array.from(m.mu),
    sigma: Array.from(m.sigma),
    phiBills: 0,
    phiInflation: m.phiInflation,
    correlation: Array.from(m.correlation),
    billsInitial: m.lastBills,
    inflationInitial: m.lastInflation,
  };
}

/** The `conservative` preset: geometric means of `CONSERVATIVE_GEOMETRIC_MEANS_BP` with the data's simple-return volatilities. */
export function conservativePresetParams(series: ReturnSeries = US_SERIES): ParametricLogParams {
  const m = estimateLogMoments(series);
  const mu: number[] = [];
  const sigma: number[] = [];
  for (let j = 0; j < 4; j++) {
    const lp = lognormalFromGeometric(CONSERVATIVE_GEOMETRIC_MEANS_BP[j]! / 10000, m.simpleSd[j]!);
    mu.push(lp.mu);
    sigma.push(lp.sigma);
  }
  return {
    mu,
    sigma,
    phiBills: 0,
    phiInflation: m.phiInflation,
    correlation: Array.from(m.correlation),
    billsInitial: m.lastBills,
    inflationInitial: m.lastInflation,
  };
}

/**
 * The `custom` preset from the owner's basis points (C3): means and volatilities ÷ 10000 read as
 * arithmetic or geometric, persistences and correlations ÷ 10000, initial rates ÷ 10000 or, when
 * absent, the data file's last observed year exactly.
 */
export function customParams(params: ParametricParams, series: ReturnSeries = US_SERIES): ParametricLogParams {
  const convert = params.meanKind === "arithmetic" ? lognormalFromArithmetic : lognormalFromGeometric;
  const vars = [params.stocks, params.bonds, params.bills, params.inflation];
  const lps = vars.map((v) => convert(v.meanBp / 10000, v.volBp / 10000));
  const correlation: number[] = [];
  for (const row of params.correlationBp) for (const v of row) correlation.push(v / 10000);
  const last = series.bills.length - 1;
  return {
    mu: lps.map((lp) => lp.mu),
    sigma: lps.map((lp) => lp.sigma),
    phiBills: params.bills.persistenceBp / 10000,
    phiInflation: params.inflation.persistenceBp / 10000,
    correlation,
    billsInitial: params.bills.initialBp === undefined ? series.bills[last]! : params.bills.initialBp / 10000,
    inflationInitial: params.inflation.initialBp === undefined ? series.inflation[last]! : params.inflation.initialBp / 10000,
  };
}

/** A compiled parametric model with its per-thread scratch; fills one path at a time. */
export class ParametricPaths {
  readonly core: ParametricCore;
  readonly lnBills0: number;
  readonly lnInflation0: number;
  private readonly z = new Float64Array(4);
  private readonly state = new Float64Array(2);
  private readonly ce = new Float64Array(8);
  private readonly ex = new Float64Array(6);

  constructor(
    params: ParametricLogParams,
    private readonly key: RngKey,
    private readonly f: number,
  ) {
    this.core = compileParametricCore(params);
    if (!(params.billsInitial > -1 && params.inflationInitial > -1)) {
      throw new EngineInputError("initial_rate_invalid", "an initial rate must be above −100%");
    }
    this.lnBills0 = detLog(1 + params.billsInitial);
    this.lnInflation0 = detLog(1 + params.inflationInitial);
  }

  fill(pathIndex: number, out: MarketPath): void {
    const { z, state, ce, ex, key, f } = this;
    const sqrtF = Math.sqrt(f);
    state[0] = this.lnBills0;
    state[1] = this.lnInflation0;
    // The year's draws, normals and factors go through arrays (uniformsAt, invNormInPlace,
    // detExpInPlace): a double crossing a call V8 does not inline is boxed. `ex` holds the log
    // factors: full-year bills and inflation, then stocks and bonds, then in a partial year 0 the
    // part-year bills and inflation.
    for (let t = 0; t < out.years; t++) {
      uniformsAt(key, pathIndex, PURPOSE.MARKET, t, 4, z);
      invNormInPlace(z, 0, 4);
      parametricStep(this.core, z, state, ce);
      const g = t * SIM_ASSET_COUNT;
      ex[0] = ce[PV_BILLS]! + ce[4 + PV_BILLS]!;
      ex[1] = ce[PV_INFLATION]! + ce[4 + PV_INFLATION]!;
      const partial = t === 0 && f < 1;
      if (partial) {
        ex[2] = f * ce[PV_STOCKS]! + sqrtF * ce[4 + PV_STOCKS]!;
        ex[3] = f * ce[PV_BONDS]! + sqrtF * ce[4 + PV_BONDS]!;
        ex[4] = f * ce[PV_BILLS]! + sqrtF * ce[4 + PV_BILLS]!;
        ex[5] = f * ce[PV_INFLATION]! + sqrtF * ce[4 + PV_INFLATION]!;
      } else {
        ex[2] = ce[PV_STOCKS]! + ce[4 + PV_STOCKS]!;
        ex[3] = ce[PV_BONDS]! + ce[4 + PV_BONDS]!;
      }
      detExpInPlace(ex, 0, partial ? 6 : 4);
      const billsFull = ex[0]!;
      const inflationFull = ex[1]!;
      out.growth[g + STOCKS] = ex[2]!;
      out.growth[g + BONDS] = ex[3]!;
      if (partial) {
        out.growth[g + BILLS] = ex[4]!;
        out.priceFactor[t] = ex[5]!;
      } else {
        out.growth[g + BILLS] = billsFull;
        out.priceFactor[t] = inflationFull;
      }
      out.billsFull[t] = billsFull - 1;
      out.inflationFull[t] = inflationFull - 1;
      out.sampledYear[t] = -1;
    }
    out.cohortStartYear = -1;
    out.replicate = 0;
    out.wrapped = false;
  }
}
