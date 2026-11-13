import type { ParametricParams, ReturnModelConfig } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { EngineInputError } from "../errors.js";
import { seedKey } from "../rng.js";
import { compileReturnModel, createMarketPath } from "./index.js";
import { compileParametricCore, customParams, innovationVolatilities, parametricStep } from "./parametric.js";
import type { ParametricCore } from "./parametric.js";

// Build step 13: the parametric correlated lognormal model (engine-and-returns §3.5 (d), §7 T9,
// T10; seams C3, C14, C22, G2). Expected values are the design's; each was re-derived with 60-digit
// decimals from the generator's exact normals (scratchpad p4-rng/deriv.py), and the 52/365 part of
// T9 is replaced by f = 2/12 per seams §10.

const KEY = seedKey(20261110);

/** T9's parameters as stored settings (C3: integer basis points). */
const T9_PARAMS: ParametricParams = {
  meanKind: "arithmetic",
  stocks: { meanBp: 700, volBp: 1800 },
  bonds: { meanBp: 400, volBp: 700 },
  bills: { meanBp: 300, volBp: 200, persistenceBp: 0 },
  inflation: { meanBp: 250, volBp: 200, persistenceBp: 5000, initialBp: 300 },
  // Innovation correlations, order stocks, bonds, bills, inflation: S–B 0.1, B–C 0.3, B–π −0.2, C–π 0.4.
  correlationBp: [
    [10000, 1000, 0, 0],
    [1000, 10000, 3000, -2000],
    [0, 3000, 10000, 4000],
    [0, -2000, 4000, 10000],
  ],
};
const custom = (params: ParametricParams): ReturnModelConfig => ({ kind: "parametric", preset: "custom", params });
const t9Model = (firstYearMonths: number, params = T9_PARAMS) =>
  compileReturnModel(custom(params), { key: KEY, years: 3, firstYearMonths, requestedPaths: 10000, allFixedLongevity: false });

describe("T9 parametric path", () => {
  it("T9 μ, the innovation volatilities and L", () => {
    const p = customParams(T9_PARAMS);
    [0.0537054564, 0.0369606659, 0.0293703186, 0.0245022859].forEach((v, j) => expect(p.mu[j]).toBeCloseTo(v, 10));
    const s = innovationVolatilities(p);
    [0.1670520403, 0.0672316474, 0.0194156458, 0.0168964486].forEach((v, j) => expect(s[j]).toBeCloseTo(v, 10));
    const l = compileParametricCore(p).chol;
    const rows = [
      [0.1670520403],
      [0.0067231647, 0.0668946445],
      [0, 0.0058540375, 0.0185120919],
      [0, -0.003396314, 0.0081624667, 0.0143989293],
    ];
    rows.forEach((row, i) => row.forEach((v, j) => expect(l[i * 4 + j]).toBeCloseTo(v, 10)));
    // The bp conversion is exact division: 700 / 10000 is the double nearest 0.07.
    expect(p.correlation[1]).toBe(0.1);
    expect(p.phiInflation).toBe(0.5);
    expect(p.inflationInitial).toBe(0.03);
  });

  it("T9 path 0, full first year: the three years' factors", () => {
    // Year 0 by hand: stocks 0.0537054564 + 0.1670520403 × (−0.2260053950) = 0.0159507940 → e^x = 1.0160787;
    // bonds 0.0369606659 − 0.0015194715 − 0.0211101443 = 0.0143310502 → 1.0144342; bills
    // 0.0293703186 − 0.0018473762 − 0.0151750614 = 0.0123478810 → 1.0124244; inflation innovation
    // 0.0010717850 − 0.0066910824 + 0.0055379061 = −0.0000813913, conditional mean
    // 0.0245022859 + 0.5 × (ln 1.03 − 0.0245022859) = 0.0270305441, ℓ_0 = 0.0269491528 → 0.0273156.
    const model = t9Model(12);
    const out = createMarketPath(3);
    model.fillPath(0, out);
    const table = [
      [1.0160786871, 1.014434232, 1.0124244308, 0.0273155653],
      [0.9425761769, 1.0503874265, 1.0029185376, 0.0133356972],
      [1.2309231596, 1.0406259766, 1.0269740942, 0.0510494446],
    ];
    table.forEach(([s, b, c, infl], t) => {
      expect(out.growth[t * 3]).toBeCloseTo(s!, 10);
      expect(out.growth[t * 3 + 1]).toBeCloseTo(b!, 10);
      expect(out.growth[t * 3 + 2]).toBeCloseTo(c!, 10);
      expect(out.priceFactor[t]! - 1).toBeCloseTo(infl!, 10);
      expect(out.inflationFull[t]).toBeCloseTo(infl!, 10);
      expect(out.billsFull[t]).toBeCloseTo(c! - 1, 10);
    });
    expect(Array.from(out.sampledYear)).toEqual([-1, -1, -1]);
    expect(model.summary).toEqual({ kind: "parametric", requestedPaths: 10000, preset: "custom" });
    expect(model.paths).toBe(10000);
    // bills.initial is absent: the year-0 bond-interest reference is the data's last bill return (C18).
    expect(model.billRef0).toBe(0.0421);
  });

  it("T9 the same path with f = 2/12 (a November start; re-derived, seams §10)", () => {
    // √f = 0.408248290464. Stocks: f·c + √f·e = 0.053705456397/6 + 0.408248290464 × (−0.037754662352)
    // = 0.008950909400 − 0.015413276363 = −0.006462366963 → 0.9935584692. Bonds: c 0.036960665949,
    // e −0.022629615781 → 0.9969263424. Bills: c 0.029370318590, e −0.017022437629 → 0.9979477807.
    // Inflation: 0.027030544091/6 + 0.408248290464 × (−0.000081391298) = 0.004505090682 − 0.000033227860
    // = 0.004471862823 → price factor 1.0044818765. Year 1 is unchanged: the AR state carries the
    // full-year rate. (The design's 52/365 values 0.9934225552, 0.9967295228, 0.9977617162 and
    // 1.0038275123 come out of the same script with f = 52/365.)
    const model = t9Model(2);
    expect(model.firstYearFraction).toBe(2 / 12);
    const out = createMarketPath(3);
    model.fillPath(0, out);
    expect(out.growth[0]).toBeCloseTo(0.9935584692, 10);
    expect(out.growth[1]).toBeCloseTo(0.9969263424, 10);
    expect(out.growth[2]).toBeCloseTo(0.9979477807, 10);
    expect(out.priceFactor[0]).toBeCloseTo(1.0044818765, 10);
    // C22, C18: the full-year rates of year 0 are the full-year draw's, not the part-year factors.
    expect(out.inflationFull[0]).toBeCloseTo(0.0273155653, 10);
    expect(out.billsFull[0]).toBeCloseTo(0.0124244308, 10);
    const full = createMarketPath(3);
    t9Model(12).fillPath(0, full);
    expect(Array.from(out.growth.subarray(3))).toEqual(Array.from(full.growth.subarray(3)));
    expect(Array.from(out.priceFactor.subarray(1))).toEqual(Array.from(full.priceFactor.subarray(1)));
  });

  it("T9 bills.persistence 0.9 and bills.initial 0.0421: bills factors 1.0331694780, 1.0209904969, 1.0206428443", () => {
    // Bill innovation volatility 0.0194156458 × sqrt(0.19) = 0.0084630838; third row of L
    // (0, 0.0025517158, 0.0080692338); year-0 conditional mean 0.0293703186 + 0.9 × (ln 1.0421 −
    // 0.0293703186) = 0.0400511491, innovation −0.0008052526 − 0.0066146559 = −0.0074199085.
    const params: ParametricParams = { ...T9_PARAMS, bills: { meanBp: 300, volBp: 200, persistenceBp: 9000, initialBp: 421 } };
    const p = customParams(params);
    expect(innovationVolatilities(p)[2]).toBeCloseTo(0.0084630838, 10);
    const l = compileParametricCore(p).chol;
    [0, 0.0025517158, 0.0080692338].forEach((v, j) => expect(l[8 + j]).toBeCloseTo(v, 10));
    const model = t9Model(12, params);
    expect(model.billRef0).toBe(0.0421);
    const out = createMarketPath(3);
    model.fillPath(0, out);
    [1.033169478, 1.0209904969, 1.0206428443].forEach((v, t) => expect(out.growth[t * 3 + 2]).toBeCloseTo(v, 10));
    // The other three series are unchanged.
    const base = createMarketPath(3);
    t9Model(12).fillPath(0, base);
    for (let t = 0; t < 3; t++) {
      expect(out.growth[t * 3]).toBe(base.growth[t * 3]);
      expect(out.growth[t * 3 + 1]).toBe(base.growth[t * 3 + 1]);
      expect(out.priceFactor[t]).toBe(base.priceFactor[t]);
    }
  });
});

describe("T10 one AR step", () => {
  it("T10 μ = (0.07, 0.04, 0.03, 0.025), φ_C 0.9, φ_π 0.6, previous logs 0.045 and 0.04, z = (−1, 0.5, 1, 2)", () => {
    const core: ParametricCore = {
      mu: new Float64Array([0.07, 0.04, 0.03, 0.025]),
      phiBills: 0.9,
      phiInflation: 0.6,
      chol: new Float64Array([0.18, 0, 0, 0, 0.004, 0.07, 0, 0, 0, 0.003, 0.012, 0, 0.002, -0.003, 0.008, 0.028]),
    };
    const state = new Float64Array([0.045, 0.04]);
    const out = new Float64Array(8);
    parametricStep(core, [-1, 0.5, 1, 2], state, out);
    // Innovations −0.18, 0.031, 0.0135, 0.0605.
    [-0.18, 0.031, 0.0135, 0.0605].forEach((v, j) => expect(out[4 + j]).toBeCloseTo(v, 15));
    // Log rates −0.11, 0.071, 0.057 (0.03 + 0.9 × 0.015 + 0.0135), 0.0945 (0.025 + 0.6 × 0.015 + 0.0605).
    const logs = [0, 1, 2, 3].map((j) => out[j]! + out[4 + j]!);
    [-0.11, 0.071, 0.057, 0.0945].forEach((v, j) => expect(logs[j]).toBeCloseTo(v, 15));
    // Factors 0.8958341353, 1.0735812259, 1.0586558104, 1.0991091631 (= e^log).
    [0.8958341353, 1.0735812259, 1.0586558104, 1.0991091631].forEach((v, j) => expect(Math.exp(logs[j]!)).toBeCloseTo(v, 10));
    // The state now holds this year's full-year bill and inflation logs.
    expect(state[0]).toBeCloseTo(0.057, 15);
    expect(state[1]).toBeCloseTo(0.0945, 15);
  });
});

describe("parametric presets and guards", () => {
  it("the historical and conservative presets compile and draw from the same normals", () => {
    const opts = { key: KEY, years: 40, firstYearMonths: 12, requestedPaths: 2000, allFixedLongevity: true };
    const h = compileReturnModel({ kind: "parametric", preset: "historical" }, opts);
    const c = compileReturnModel({ kind: "parametric", preset: "conservative" }, opts);
    expect(h.summary).toEqual({ kind: "parametric", requestedPaths: 2000, preset: "historical" });
    expect(c.summary.preset).toBe("conservative");
    expect([h.billRef0, c.billRef0]).toEqual([0.0421, 0.0421]);
    const a = createMarketPath(40);
    h.fillPath(1999, a);
    for (const v of a.growth) expect(v > 0 && Number.isFinite(v)).toBe(true);
    // Year 0 stocks: c_S + e_S with e_S = L00 × z0, z0 = −0.22600539504450393 (T4), L00 = σ_S = 0.188736772964.
    h.fillPath(0, a);
    expect(Math.log(a.growth[0]!)).toBeCloseTo(0.095471251114 + 0.188736772964 * -0.22600539504450393, 11);
  });

  it("a custom geometric model reads its means as geometric (median growth 1 + mean)", () => {
    const p = customParams({ ...T9_PARAMS, meanKind: "geometric" });
    expect(p.mu[0]).toBeCloseTo(Math.log(1.07), 15);
  });

  it("a custom model with absent initial rates starts from the data's last year exactly", () => {
    const p = customParams({ ...T9_PARAMS, inflation: { meanBp: 250, volBp: 200, persistenceBp: 5000 } });
    expect([p.billsInitial, p.inflationInitial]).toEqual([0.0421, 0.027351]);
  });

  it("correlations that cannot all hold, or a zero volatility, raise correlation_not_positive_definite", () => {
    const bad: ParametricParams = {
      ...T9_PARAMS,
      correlationBp: [
        [10000, 9000, 9000, 0],
        [9000, 10000, -9000, 0],
        [9000, -9000, 10000, 0],
        [0, 0, 0, 10000],
      ],
    };
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof EngineInputError ? e.code : String(e);
      }
      return "no error";
    };
    expect(code(() => t9Model(12, bad))).toBe("correlation_not_positive_definite");
    expect(code(() => t9Model(12, { ...T9_PARAMS, bonds: { meanBp: 400, volBp: 0 } }))).toBe("correlation_not_positive_definite");
    // An asymmetric matrix is refused by the engine too (the shared schema refuses it first).
    const asym = customParams(T9_PARAMS);
    const corr = Array.from(asym.correlation);
    corr[1] = 0.2;
    expect(code(() => compileParametricCore({ ...asym, correlation: corr }))).toBe("correlation_not_symmetric");
    // The custom preset needs its parameters.
    expect(code(() => compileReturnModel({ kind: "parametric", preset: "custom" }, { key: KEY, years: 3, firstYearMonths: 12, requestedPaths: 100, allFixedLongevity: true }))).toBe("custom_params_required");
  });
});
