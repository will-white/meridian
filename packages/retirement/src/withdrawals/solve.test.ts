import { describe, expect, it } from "vitest";
import { CASH_TOL } from "../constants.js";
import { ASSESS_MAX_CALLS } from "../hooks.js";
import { type SolveState, createSolveState, solve } from "./solve.js";

// Build step 19: the gross-up solver (strategies-outputs-web §3.7, decision 21; seams F4) on
// hand-made net functions. The contract: stop at |net| ≤ CASH_TOL or on a bracket narrower than
// CASH_TOL / 2, within the year's limit of evaluations (the caller's included); otherwise return the
// smallest amount found with net ≥ 0. Nothing assumes that net is monotone.

interface Probe extends SolveState {
  trace: number[];
}

/** A solver record on `[lo, hi]` for `h`, with the caller's two evaluations already counted. */
function setup(h: (x: number) => number, lo: number, hi: number, limit = ASSESS_MAX_CALLS): { s: Probe; net: (s: Probe) => void } {
  const s: Probe = { ...createSolveState(limit), trace: [] };
  s.lo = lo;
  s.hlo = h(lo);
  s.hi = hi;
  s.hhi = h(hi);
  s.calls = 2;
  return {
    s,
    net: (p) => {
      p.calls += 1;
      p.trace.push(p.x);
      p.hx = h(p.x);
    },
  };
}

describe("§3.7 the solver", () => {
  it("§3.7 slope 1 (a tier with nothing taxable): the first trial, lo − h(lo), is the root; one evaluation", () => {
    // net(x) = x − 12,345.67 on [0, 100,000]: x = 0 − (−12,345.67).
    const { s, net } = setup((x) => x - 12345.67, 0, 100000);
    solve(s, net);
    expect(s.x).toBeCloseTo(12345.67, 9);
    expect(s.trace.length).toBe(1);
    expect(s.converged).toBe(1);
  });

  it("§3.7 one linear piece of slope 0.8 (pre-tax at 20%): the second trial is exact", () => {
    // net(x) = 0.8x − 40,000 on [0, 100,000]: trial 1 at 40,000 (net −8,000), then false position
    // on [40,000, 100,000] with ends −8,000 and +40,000: 40,000 + 60,000 × 8/48 = 50,000.
    const { s, net } = setup((x) => 0.8 * x - 40000, 0, 100000);
    solve(s, net);
    expect(s.x).toBeCloseTo(50000, 6);
    expect(s.trace).toEqual([40000, expect.closeTo(50000, 6)]);
  });

  it("§3.7 a first trial beyond hi falls back to false position on the bracket", () => {
    // net(x) = 2x − 30,000 on [0, 20,000] (ends −30,000 and +10,000): the first trial 0 + 30,000
    // is beyond hi, so false position gives 20,000 × 30,000 / 40,000 = 15,000, the root.
    const { s, net } = setup((x) => 2 * x - 30000, 0, 20000);
    solve(s, net);
    expect(s.trace[0]).toBeCloseTo(15000, 9);
    expect(s.x).toBeCloseTo(15000, 9);
  });

  it("§3.7 piecewise linear (a kink from 12% to 22% and benefits phasing in): converged within the tolerance in a few evaluations", () => {
    // net(x) = x − tax(x) − 50,000 with tax 12% to 40,000 and 22% above, ×1.85 between 20,000 and 30,000.
    const tax = (x: number) => {
      const phase = Math.min(Math.max(x - 20000, 0), 10000) * 0.85;
      const z = x + phase;
      return z <= 40000 ? 0.12 * z : 4800 + 0.22 * (z - 40000);
    };
    const h = (x: number) => x - tax(x) - 50000;
    const { s, net } = setup(h, 0, 1e6);
    solve(s, net);
    expect(Math.abs(h(s.x))).toBeLessThanOrEqual(CASH_TOL);
    expect(s.calls).toBeLessThanOrEqual(8);
    expect(s.converged).toBe(1);
  });

  it("§3.7 the Illinois step keeps a convex end from sticking", () => {
    // net(x) = (x / 1,000)³ − 8 on [0, 10,000]: the root is 2,000, where the slope is 0.012, so
    // |net| ≤ 0.005 allows |x − 2,000| ≤ 0.42. Plain false position keeps hi for many steps; the
    // Illinois halving reaches the tolerance well inside the limit.
    const h = (x: number) => (x / 1000) * (x / 1000) * (x / 1000) - 8;
    const { s, net } = setup(h, 0, 10000);
    solve(s, net);
    expect(Math.abs(s.x - 2000)).toBeLessThan(0.42);
    expect(Math.abs(h(s.x))).toBeLessThanOrEqual(CASH_TOL);
    expect(s.calls).toBeLessThanOrEqual(ASSESS_MAX_CALLS);
  });

  it("F4 an upward jump across 0 (no root): the result is the smallest amount found with net ≥ 0", () => {
    // net = x − 1,000 below 999 and x − 950 from 999: no |net| ≤ 0.005 exists. The bracket shrinks
    // onto 999, or the limit is reached; either way x has net ≥ 0 and nothing tried below it does.
    const h = (x: number) => (x < 999 ? x - 1000 : x - 950);
    const { s, net } = setup(h, 0, 100000);
    solve(s, net);
    expect(h(s.x)).toBeGreaterThanOrEqual(0);
    for (const x of s.trace) if (x < s.x) expect(h(x)).toBeLessThan(0);
    expect(s.x).toBeGreaterThanOrEqual(999);
    expect(s.calls).toBeLessThanOrEqual(ASSESS_MAX_CALLS);
  });

  it("F4 a downward cliff (net not monotone, as IRMAA's): still an amount with net ≥ −CASH_TOL, inside the bracket", () => {
    // net = 0.5x − 1,000 below 1,500, 0.5x − 1,400 from 1,500: the root is 2,800.
    const h = (x: number) => (x < 1500 ? 0.5 * x - 1000 : 0.5 * x - 1400);
    const { s, net } = setup(h, 0, 100000);
    solve(s, net);
    expect(h(s.x)).toBeGreaterThanOrEqual(-CASH_TOL);
    expect(s.x).toBeGreaterThan(0);
    expect(s.x).toBeLessThanOrEqual(100000);
  });

  it("F4 cut off by the limit: hi, with net > 0, and converged = 0; no evaluation beyond the limit", () => {
    // net(x) = 0.8x − 40,000 needs two evaluations after the caller's two; a limit of 3 allows one.
    const { s, net } = setup((x) => 0.8 * x - 40000, 0, 100000, 3);
    solve(s, net);
    expect(s.calls).toBe(3);
    expect(s.converged).toBe(0);
    expect(s.x).toBe(100000);
    // With the limit already used up, nothing is evaluated and the top of the bracket is returned.
    const spent = setup((x) => 0.8 * x - 40000, 0, 100000, 2);
    solve(spent.s, spent.net);
    expect(spent.s.trace).toEqual([]);
    expect(spent.s.x).toBe(100000);
  });
});
