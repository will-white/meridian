import { describe, expect, it } from "vitest";
import {
  CONSERVATIVE_GEOMETRIC_MEANS_BP,
  DATA_VERSION,
  ENGINE_VERSION,
  compileParametricCore,
  conservativePresetParams,
  customParams,
  historicalPresetParams,
} from "@meridian/retirement";
import { defaultRunSettings, ParametricParams, RetirementMeta, STORED_PERCENTILES } from "@meridian/shared";
import { createPlanner, PRESET_LABELS, realPlannerEnv, returnModelsMeta } from "./planner.js";
import { toRetirementMeta } from "./views/retirement.js";

/**
 * `app.planner` (docs/design/phase-4/inputs-and-data.md §6.1, tax-rmd-ss §6) and route 1's meta
 * (§4.8 `RetirementMeta`, seams C47), on the real engine. No database.
 */

describe("the real planner environment (inputs §6.1, tax-rmd-ss §6)", () => {
  it("carries the engine's versions, its rule sets with current law first, the first tax year and both functions", () => {
    const env = realPlannerEnv();
    expect(env.engineVersion).toBe(ENGINE_VERSION);
    expect(env.dataVersion).toBe(DATA_VERSION);
    expect(env.ruleSets[0]).toBe("current_law");
    // C47: the first year of the tax data.
    expect(env.minStartYear).toBe(2026);
    // The 2026 IRA limit for a 40-year-old is 7,500.00 (Notice 2025-67); the engine answers in cents.
    expect(env.contributionLimit?.(2026, 40, "ira")).toBe(750_000n);
    expect(typeof env.validateInput).toBe("function");
  });
});

describe("GET /meta's return models (seams C47, G2; engine-and-returns §3.5 (d))", () => {
  const models = returnModelsMeta();

  it("historyStartParams: the data file's arithmetic means and simple-return volatilities, its persistence and correlations, to the basis point", () => {
    // Seams §8 D2: arithmetic means 0.118547, 0.048224, 0.034149, 0.031083 → 1185, 482, 341, 311 bp;
    // engine-and-returns §3.5 (d): sample standard deviations 0.194034, 0.079024, 0.030358, 0.038953
    // → 1940, 790, 304, 390 bp; φ_π 0.6190 → 6190; the six correlations 0.0224, −0.0043, 0.0164,
    // 0.2664, −0.2066, 0.1247 → 224, −43, 164, 2664, −2066, 1247 bp. (These are the figures the web
    // copied into retirementForms.ts as HISTORY_START_PARAMS before /meta carried them.)
    expect(models.historyStartParams).toEqual({
      meanKind: "arithmetic",
      stocks: { meanBp: 1185, volBp: 1940 },
      bonds: { meanBp: 482, volBp: 790 },
      bills: { meanBp: 341, volBp: 304, persistenceBp: 0 },
      inflation: { meanBp: 311, volBp: 390, persistenceBp: 6190 },
      correlationBp: [
        [10000, 224, -43, 164],
        [224, 10000, 2664, -2066],
        [-43, 2664, 10000, 1247],
        [164, -2066, 1247, 10000],
      ],
    });
    expect(models.history).toEqual({ firstYear: 1928, lastYear: 2025 });
  });

  it("the historical preset: the fitted lognormal's arithmetic means and volatilities", () => {
    // μ = 0.095471, σ = 0.188737 (stocks, §3.5 (d)): exp(μ + σ²/2) − 1 = exp(0.113282) − 1 = 0.119947
    // → 1199 bp; (1 + A)·sqrt(exp(σ²) − 1) = 1.119947 × sqrt(0.036264) = 0.213273 → 2133 bp.
    // Bonds μ 0.044348, σ 0.074201: exp(0.047101) − 1 = 0.048228 → 482; 1.048228 × 0.074305 = 0.077889 → 779.
    // Bills μ 0.033160, σ 0.028969: exp(0.033580) − 1 = 0.034150, which at six decimals sits on the
    // half; the unrounded moments give 341.501 bp → 342; 1.034150 × sqrt(0.00083955) = 0.029965 → 300.
    // Inflation μ 0.029906, σ 0.037719: exp(0.030617) − 1 = 0.031091 → 311; 1.031091 × 0.037732 = 0.038905 → 389.
    // Persistence and correlations as the start parameters'. (apps/web's RETURN_MODELS_META copies this answer.)
    const historical = models.presets.find((p) => p.id === "historical")!;
    expect(historical.label).toBe(PRESET_LABELS.historical);
    expect(historical.params).toEqual({
      meanKind: "arithmetic",
      stocks: { meanBp: 1199, volBp: 2133 },
      bonds: { meanBp: 482, volBp: 779 },
      bills: { meanBp: 342, volBp: 300, persistenceBp: 0 },
      inflation: { meanBp: 311, volBp: 389, persistenceBp: 6190 },
      correlationBp: models.historyStartParams.correlationBp,
    });
  });

  it("the conservative preset: the engine's geometric means with the data's simple-return volatilities", () => {
    const conservative = models.presets.find((p) => p.id === "conservative")!;
    expect(conservative.label).toBe(PRESET_LABELS.conservative);
    // 5.5%, 4.5%, 3.2%, 2.5% (§3.5 (d)) with the volatilities 1940, 790, 304, 390 bp of the start parameters.
    expect(CONSERVATIVE_GEOMETRIC_MEANS_BP).toEqual([550, 450, 320, 250]);
    expect(conservative.params).toEqual({
      meanKind: "geometric",
      stocks: { meanBp: 550, volBp: 1940 },
      bonds: { meanBp: 450, volBp: 790 },
      bills: { meanBp: 320, volBp: 304, persistenceBp: 0 },
      inflation: { meanBp: 250, volBp: 390, persistenceBp: 6190 },
      correlationBp: models.historyStartParams.correlationBp,
    });
  });

  it("each preset, read back as custom parameters, is the engine's preset to within the basis-point rounding", () => {
    // Half a basis point on a mean or a volatility moves μ or σ by well under 1e-4.
    const cases = [
      [models.presets.find((p) => p.id === "historical")!.params, historicalPresetParams()],
      [models.presets.find((p) => p.id === "conservative")!.params, conservativePresetParams()],
    ] as const;
    for (const [view, engine] of cases) {
      const back = customParams(view);
      for (let j = 0; j < 4; j++) {
        expect(Math.abs(back.mu[j]! - engine.mu[j]!)).toBeLessThan(1e-4);
        expect(Math.abs(back.sigma[j]! - engine.sigma[j]!)).toBeLessThan(1e-4);
      }
      expect(Math.abs(back.phiInflation - engine.phiInflation)).toBeLessThan(1e-4);
      expect(back.phiBills).toBe(0);
      expect(back.billsInitial).toBe(engine.billsInitial);
      expect(back.inflationInitial).toBe(engine.inflationInitial);
    }
  });

  it("every parameter set is valid custom input with a positive definite correlation matrix", () => {
    for (const params of [models.historyStartParams, ...models.presets.map((p) => p.params)]) {
      expect(ParametricParams.parse(params)).toEqual(params);
      // The engine's own compile: the covariance of the innovations and its Cholesky factor.
      expect(() => compileParametricCore(customParams(params))).not.toThrow();
    }
  });
});

describe("route 1's view (inputs §4.8 RetirementMeta)", () => {
  it("the engine's facts and the planner's fixed figures; parses with the contract", () => {
    const meta = toRetirementMeta(createPlanner());
    expect(RetirementMeta.parse(meta)).toEqual(meta);
    expect(meta).toMatchObject({
      engineVersion: ENGINE_VERSION,
      dataVersion: DATA_VERSION,
      minStartYear: 2026,
      limits: { minPaths: 100, maxPaths: 100_000, defaultPaths: 10_000 },
      medicareAge: 65,
      disclaimer: "The planner is an estimate, not tax or investment advice.",
    });
    expect(meta.ruleSets[0]).toEqual({ id: "current_law", label: expect.any(String) });
    expect(meta.ruleSets.map((r) => r.id)).toEqual(realPlannerEnv().ruleSets);
    expect(meta.defaultSettings).toEqual(defaultRunSettings());
    expect(meta.storedPercentiles).toEqual([...STORED_PERCENTILES]);
    // tax-rmd-ss §4.1: from 1900, ending with 1960 and later at 67.
    expect(meta.fullRetirementAge[0]!.fromBirthYear).toBe(1900);
    expect(meta.fullRetirementAge.at(-1)).toEqual({ fromBirthYear: 1960, toBirthYear: null, years: 67, months: 0 });
    expect(meta.returnModels).toEqual(returnModelsMeta());
  });
});
