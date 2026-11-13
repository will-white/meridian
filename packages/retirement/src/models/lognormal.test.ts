import { describe, expect, it } from "vitest";
import { EngineInputError } from "../errors.js";
import { CHOLESKY_MIN_PIVOT, cholesky, covarianceFrom } from "./cholesky.js";
import { lognormalFromArithmetic, lognormalFromGeometric } from "./lognormal.js";

// Build step 12 (engine-and-returns §3.4, §3.5 (d) 1, §7 T6 to T8). Expected values are the
// design's; each was re-derived with 60-digit decimals (scratchpad p4-rng/deriv.py) and agrees.
// Tests may use Math.exp and Math.log as references (the determinism rule covers src/ only).

describe("T6 lognormal conversions", () => {
  it("T6 arithmetic 7%, vol 18%: σ² = ln(1 + 0.0324/1.1449) = 0.027906384154, σ = 0.167052040258, μ = 0.053705456397", () => {
    const { mu, sigma } = lognormalFromArithmetic(0.07, 0.18);
    expect(sigma * sigma).toBeCloseTo(0.027906384154, 12);
    expect(sigma).toBeCloseTo(0.167052040258, 12);
    expect(mu).toBeCloseTo(0.053705456397, 12);
    // Check: exp(μ + σ²/2) − 1 = 0.07, the requested arithmetic mean.
    expect(Math.exp(mu + (sigma * sigma) / 2) - 1).toBeCloseTo(0.07, 14);
    // ...and the simple return's standard deviation is the requested 18%.
    expect(Math.sqrt(Math.exp(2 * mu + sigma * sigma) * (Math.exp(sigma * sigma) - 1))).toBeCloseTo(0.18, 14);
  });

  it("T6 geometric 5%, vol 18%: σ² = 0.028170876967, σ = 0.167841821268, μ = ln 1.05 = 0.048790164169", () => {
    const { mu, sigma } = lognormalFromGeometric(0.05, 0.18);
    expect(sigma * sigma).toBeCloseTo(0.028170876967, 12);
    expect(sigma).toBeCloseTo(0.167841821268, 12);
    expect(mu).toBeCloseTo(0.048790164169, 12);
    // Check: the standard deviation of the simple return is 0.18 and the expected return 0.0648943610.
    expect(Math.sqrt(Math.exp(2 * mu + sigma * sigma) * (Math.exp(sigma * sigma) - 1))).toBeCloseTo(0.18, 14);
    expect(Math.exp(mu + (sigma * sigma) / 2) - 1).toBeCloseTo(0.064894361, 9);
  });

  it("a zero volatility gives σ = 0 and μ = ln(1 + mean); a mean at or below −100% is refused", () => {
    expect(lognormalFromArithmetic(0.03, 0)).toEqual({ mu: lognormalFromGeometric(0.03, 0).mu, sigma: 0 });
    expect(() => lognormalFromArithmetic(-1, 0.1)).toThrow(RangeError);
    expect(() => lognormalFromGeometric(-1.5, 0.1)).toThrow(RangeError);
  });
});

describe("T7 Cholesky of a stated matrix", () => {
  it("T7 [[4, 12, −16], [12, 37, −43], [−16, −43, 98]] → L = [[2, 0, 0], [6, 1, 0], [−8, 5, 3]]", () => {
    // By hand: L11 = 2; L21 = 12/2 = 6; L22 = sqrt(37 − 36) = 1; L31 = −16/2 = −8;
    // L32 = (−43 + 48)/1 = 5; L33 = sqrt(98 − 64 − 25) = 3. Every step is exact in binary64.
    const l = cholesky([4, 12, -16, 12, 37, -43, -16, -43, 98], 3);
    expect(Array.from(l)).toEqual([2, 0, 0, 6, 1, 0, -8, 5, 3]);
  });

  it("reads only the lower triangle and refuses a wrong size", () => {
    expect(Array.from(cholesky([4, 999, -999, 12, 37, 999, -16, -43, 98], 3))).toEqual([2, 0, 0, 6, 1, 0, -8, 5, 3]);
    expect(() => cholesky([1, 0, 0], 2)).toThrow(RangeError);
  });
});

describe("T8 Cholesky from volatilities and correlations; rejection", () => {
  it("T8 vols (0.20, 0.08, 0.03), ρ12 = 0.2, ρ13 = 0, ρ23 = 0.3", () => {
    const sigma = covarianceFrom([0.2, 0.08, 0.03], [1, 0.2, 0, 0.2, 1, 0.3, 0, 0.3, 1]);
    // Covariance rows (0.04, 0.0032, 0), (0.0032, 0.0064, 0.00072), (0, 0.00072, 0.0009).
    const expected = [0.04, 0.0032, 0, 0.0032, 0.0064, 0.00072, 0, 0.00072, 0.0009];
    expected.forEach((v, i) => expect(sigma[i]).toBeCloseTo(v, 15));
    const l = cholesky(sigma, 3);
    // L11 = 0.2; L21 = 0.0032/0.2 = 0.016; L22 = sqrt(0.0064 − 0.000256) = 0.0783836718;
    // L31 = 0; L32 = 0.00072/0.0783836718 = 0.0091855865; L33 = sqrt(0.0009 − 0.0000843750) = 0.0285591491.
    expect(l[0]).toBeCloseTo(0.2, 15);
    expect(l[3]).toBeCloseTo(0.016, 15);
    expect(l[4]).toBeCloseTo(0.0783836718, 10);
    expect(l[6]).toBe(0);
    expect(l[7]).toBeCloseTo(0.0091855865, 10);
    expect(l[8]).toBeCloseTo(0.0285591491, 10);
    expect([l[1], l[2], l[5]]).toEqual([0, 0, 0]);
  });

  it("T8 ρ12 = ρ13 = 0.9, ρ23 = −0.9 (determinant −2.888) raises correlation_not_positive_definite", () => {
    // det = 1 + 2(0.9)(0.9)(−0.9) − 3(0.81) = 1 − 1.458 − 2.43 = −2.888.
    const sigma = covarianceFrom([0.2, 0.08, 0.03], [1, 0.9, 0.9, 0.9, 1, -0.9, 0.9, -0.9, 1]);
    let caught: unknown;
    try {
      cholesky(sigma, 3);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineInputError);
    expect((caught as EngineInputError).code).toBe("correlation_not_positive_definite");
    expect((caught as EngineInputError).permanent).toBe(true);
  });

  it("a zero variance (a pivot at or below 1e-14) is refused, a small positive one accepted", () => {
    expect(CHOLESKY_MIN_PIVOT).toBe(1e-14);
    expect(() => cholesky([0.04, 0, 0, 0], 2)).toThrow(EngineInputError);
    expect(() => cholesky([1e-14, 0, 0, 1], 2)).toThrow(EngineInputError);
    expect(() => cholesky([Number.NaN, 0, 0, 1], 2)).toThrow(EngineInputError);
    // A 1 bp volatility (variance 1e-8) is far above the pivot.
    expect(cholesky([1e-8, 0, 0, 1], 2)[0]).toBeCloseTo(1e-4, 18);
  });
});
