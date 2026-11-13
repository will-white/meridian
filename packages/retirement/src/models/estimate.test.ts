import { describe, expect, it } from "vitest";
import { US_BILLS, US_INFLATION } from "../generated/data.js";
import { cholesky, covarianceFrom } from "./cholesky.js";
import { estimateLogMoments } from "./estimate.js";
import { conservativePresetParams, historicalPresetParams, innovationVolatilities } from "./parametric.js";

// Build step 13: the estimator behind the parametric `historical` preset and the year-0 rule's
// data means (engine-and-returns §3.5 (d) "Presets", T13). The design states the figures to four or
// six decimals; the ten-to-twelve-decimal values below were re-derived from the pinned CSV with
// 60-digit decimal logarithms (scratchpad p4-rng/deriv.py, python3 -I) and agree with every one of
// the design's figures. data.test.ts asserts the same figures from its own reference computation.

const m = estimateLogMoments();

describe("T13 estimateLogMoments on the pinned data file", () => {
  it("T13 μ = (0.095471, 0.044348, 0.033160, 0.029906)", () => {
    const exact = [0.095471251114, 0.04434778033, 0.033160333443, 0.029905825171];
    exact.forEach((v, j) => expect(m.mu[j]).toBeCloseTo(v, 11));
    expect(Array.from(m.mu, (v) => Number(v.toFixed(6)))).toEqual([0.095471, 0.044348, 0.03316, 0.029906]);
  });

  it("T13 σ = (0.188737, 0.074201, 0.028969, 0.037719), sample standard deviations of the logs", () => {
    const exact = [0.188736772964, 0.07420099025, 0.028969380518, 0.037719346824];
    exact.forEach((v, j) => expect(m.sigma[j]).toBeCloseTo(v, 11));
  });

  it("T13 φ_π = 0.6190 and the inflation shock volatility 0.029624", () => {
    expect(m.phiInflation).toBeCloseTo(0.619003325523, 11);
    expect(Number(m.phiInflation.toFixed(4))).toBe(0.619);
    expect(m.shockVolatility).toBeCloseTo(0.02962433611, 11);
    expect(Number(m.shockVolatility.toFixed(6))).toBe(0.029624);
  });

  it("T13 the six correlations: ρ(S,B) 0.0224, ρ(S,C) −0.0043, ρ(B,C) 0.2664, ρ(S,ε) 0.0164, ρ(B,ε) −0.2066, ρ(C,ε) 0.1247", () => {
    const c = m.correlation;
    const pairs: Array<[number, number, number]> = [
      [0, 1, 0.02238298],
      [0, 2, -0.00430177],
      [1, 2, 0.26639695],
      [0, 3, 0.01644661],
      [1, 3, -0.20660365],
      [2, 3, 0.12471984],
    ];
    for (const [i, j, v] of pairs) {
      expect(c[i * 4 + j]).toBeCloseTo(v, 7);
      expect(c[j * 4 + i]).toBe(c[i * 4 + j]);
    }
    expect(pairs.map(([i, j]) => Number(c[i * 4 + j]!.toFixed(4)))).toEqual([0.0224, -0.0043, 0.2664, 0.0164, -0.2066, 0.1247]);
    for (let i = 0; i < 4; i++) expect(c[i * 4 + i]).toBe(1);
  });

  it("T13 the ten entries of the historical preset's Cholesky factor (six decimals, from the unrounded moments)", () => {
    const p = historicalPresetParams();
    const l = cholesky(covarianceFrom(innovationVolatilities(p), p.correlation), 4);
    const exact = [
      [0.188736773],
      [0.0016608395, 0.0741824007],
      [-0.0001246195, 0.0077220786, 0.0279209416],
      [0.00048722, -0.006132938, 0.0055318387, 0.0284455574],
    ];
    exact.forEach((row, i) => row.forEach((v, j) => expect(l[i * 4 + j]).toBeCloseTo(v, 9)));
    const six = [
      [0.188737],
      [0.001661, 0.074182],
      [-0.000125, 0.007722, 0.027921],
      [0.000487, -0.006133, 0.005532, 0.028446],
    ];
    expect(exact.map((row, i) => row.map((_, j) => Number(l[i * 4 + j]!.toFixed(6))))).toEqual(six);
  });

  it("T13 the conservative preset's log parameters (geometric 5.5%, 4.5%, 3.2%, 2.5% on the data's simple-return volatilities)", () => {
    // Simple-return sample sds 0.194034, 0.079024, 0.030358, 0.038953 (re-derived 0.194034304141,
    // 0.079024231471, 0.030358025319, 0.038952555249).
    expect(Array.from(m.simpleSd, (v) => Number(v.toFixed(6)))).toEqual([0.194034, 0.079024, 0.030358, 0.038953]);
    const p = conservativePresetParams();
    const exact = [
      [0.053540766928, 0.179522631682],
      [0.044016885417, 0.075300319223],
      [0.031498667059, 0.029397630037],
      [0.02469261259, 0.037961440255],
    ];
    exact.forEach(([mu, sigma], j) => {
      expect(p.mu[j]).toBeCloseTo(mu!, 11);
      expect(p.sigma[j]).toBeCloseTo(sigma!, 11);
    });
    expect(exact.map((_, j) => [Number(p.mu[j]!.toFixed(6)), Number(p.sigma[j]!.toFixed(6))])).toEqual([
      [0.053541, 0.179523],
      [0.044017, 0.0753],
      [0.031499, 0.029398],
      [0.024693, 0.037961],
    ]);
    // Shock 0.029814 = 0.037961 × sqrt(1 − 0.6190²) (re-derived 0.029814473474).
    expect(innovationVolatilities(p)[3]).toBeCloseTo(0.029814473474, 11);
    expect(p.phiInflation).toBe(m.phiInflation);
    expect(Array.from(p.correlation)).toEqual(Array.from(m.correlation));
  });

  it("the presets start from the last data year: bills 0.042100, inflation 0.027351; φ_C = 0", () => {
    expect(m.lastBills).toBe(US_BILLS[97]);
    expect(m.lastBills).toBe(0.0421);
    expect(m.lastInflation).toBe(US_INFLATION[97]);
    expect(m.lastInflation).toBe(0.027351);
    for (const p of [historicalPresetParams(), conservativePresetParams()]) {
      expect(p.phiBills).toBe(0);
      expect(p.billsInitial).toBe(0.0421);
      expect(p.inflationInitial).toBe(0.027351);
    }
  });

  it("is deterministic and refuses a series too short to estimate", () => {
    const again = estimateLogMoments();
    expect(Array.from(again.mu)).toEqual(Array.from(m.mu));
    expect(Array.from(again.correlation)).toEqual(Array.from(m.correlation));
    const two = new Float64Array([0.01, 0.02]);
    expect(() => estimateLogMoments({ firstYear: 2000, stocks: two, bonds: two, bills: two, inflation: two })).toThrow(RangeError);
  });
});
