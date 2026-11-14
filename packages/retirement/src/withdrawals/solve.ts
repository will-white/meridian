/**
 * The gross-up solver (strategies-outputs-web §3.7, decision 21; engine-and-returns §3.9; seams
 * F4): false position with the Illinois modification on the bracket `[lo, hi]`, where
 * `net(lo) < −CASH_TOL` and `net(hi) > CASH_TOL`, stopping at half a cent of net cash and within
 * the year's `limit` of `net` evaluations (`ASSESS_MAX_CALLS`, every evaluation of the year counted,
 * the hook's own two before the solver included).
 *
 * ```
 * x = lo − hlo                                   first trial: add the raw shortfall
 * if x ≥ hi:  x = lo + (hi − lo) × (−hlo) / (hhi − hlo)
 * while calls < limit:
 *     hx = net(x)
 *     |hx| ≤ TOL: return x
 *     hx < 0: lo = x, hlo = hx (and hhi / 2 when the low end moved twice running)
 *     else:   hi = x, hhi = hx (and hlo / 2 when the high end moved twice running)
 *     hi − lo ≤ TOL / 2: return hi
 *     x = lo + (hi − lo) × (−hlo) / (hhi − hlo), or the midpoint when that leaves (lo, hi)
 * return hi                                       not converged
 * ```
 *
 * `net` is continuous, piecewise linear and increasing while the marginal tax plus penalty rate
 * stays below 100%; false position is exact once both ends lie on the root's linear piece, and the
 * Illinois halving keeps one end from sticking. The contract that Phase 5's cliffs (IRMAA, ACA)
 * rely on is only this (F4): the result is the smallest amount found with `net ≥ 0` (`hi` always
 * is one: it starts at an end with `net > CASH_TOL` and moves only to such points), or an amount
 * with `|net| ≤ CASH_TOL`. Nothing asserts that `net` is monotone.
 *
 * The state is a record and `net` a function of the record (it reads `s.x` and writes `s.hx`), so no
 * double crosses a call (engine-and-returns §4.3).
 */

import { CASH_TOL } from "../constants.js";
import { type NumberKey, doubleFields } from "../doubleFields.js";

/** The solver's record: the bracket, the trial point and its net, and the year's evaluation count. */
export interface SolveState {
  lo: number;
  hlo: number;
  hi: number;
  hhi: number;
  /** The trial amount `net` evaluates; on return, the result. */
  x: number;
  /** `net(x)`, written by the evaluation. */
  hx: number;
  /** Evaluations of `net` this year (the caller's included); `net` increments it. */
  calls: number;
  /** The most evaluations allowed this year. */
  limit: number;
  /** 1 when the last `solve` stopped inside the tolerance or on a bracket under TOL / 2; 0 when it ran out of calls. */
  converged: number;
}

export function createSolveState(limit: number): SolveState {
  return doubleFields({ lo: 0, hlo: 0, hi: 0, hhi: 0, x: 0, hx: 0, calls: 0, limit, converged: 1 }, SOLVE_DOUBLES);
}

/** The solver record's money fields (doubleFields.ts). */
export const SOLVE_DOUBLES = ["lo", "hlo", "hi", "hhi", "x", "hx"] as const satisfies readonly NumberKey<SolveState>[];

/**
 * Solves `net(x) = 0` on `[s.lo, s.hi]` (`s.hlo = net(lo) < −CASH_TOL`, `s.hhi = net(hi) > CASH_TOL`)
 * and leaves the result in `s.x`. `net(s)` evaluates at `s.x`, writes `s.hx` and counts `s.calls`.
 */
export function solve<S extends SolveState>(s: S, net: (s: S) => void): void {
  // Every candidate is computed before the choice between them, so a choice holds only values
  // already computed: an operation first reached in a branch the warm-up never took (the midpoint,
  // an Illinois halving) deoptimizes the solver and its callers, which then run unoptimized and
  // allocate until they are compiled again. The same values are chosen.
  let lo = s.lo;
  let hlo = s.hlo;
  let hi = s.hi;
  let hhi = s.hhi;
  const shortfall = lo - hlo;
  const falsePosition = lo + ((hi - lo) * -hlo) / (hhi - hlo);
  let x = shortfall >= hi ? falsePosition : shortfall;
  const midpoint = (lo + hi) / 2;
  const inside = x > lo && x < hi;
  x = inside ? x : midpoint;
  let side = 0;
  let closed = false;
  s.converged = 1;
  while (s.calls < s.limit) {
    s.x = x;
    net(s);
    const hx = s.hx;
    const withinLow = hx >= -CASH_TOL;
    const withinHigh = hx <= CASH_TOL;
    if (withinLow && withinHigh) {
      s.x = x;
      return;
    }
    const halfHhi = hhi / 2;
    const halfHlo = hlo / 2;
    if (hx < 0) {
      lo = x;
      hlo = hx;
      hhi = side === -1 ? halfHhi : hhi;
      side = -1;
    } else {
      hi = x;
      hhi = hx;
      hlo = side === 1 ? halfHlo : hlo;
      side = 1;
    }
    const width = hi - lo;
    if (width <= CASH_TOL / 2) {
      closed = true;
      break;
    }
    const next = lo + (width * -hlo) / (hhi - hlo);
    const mid = (lo + hi) / 2;
    const nextInside = next > lo && next < hi;
    x = nextInside ? next : mid;
  }
  // The bracket closed under TOL / 2 (converged), or out of calls (not converged): the high end.
  s.converged = closed ? 1 : 0;
  s.x = hi;
}
