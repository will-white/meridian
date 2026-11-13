import { describe, expect, it } from "vitest";
import { AssetClass } from "../enums.js";
import {
  AssetClassMap,
  AssetClassMapRow,
  CorrelationMatrixBp,
  DEFAULT_ASSET_CLASS_MAP,
  DEFAULT_PORTFOLIO_SETTINGS,
  DEFAULT_RETURN_MODEL,
  FixedReturnRow,
  ParametricParams,
  PortfolioSettings,
  ReturnModelConfig,
  SIM_ASSETS,
} from "./returnModel.js";
import { forbiddenValuePaths } from "./testFixtures.js";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const identity = [
  [10000, 0, 0, 0],
  [0, 10000, 0, 0],
  [0, 0, 10000, 0],
  [0, 0, 0, 10000],
];
/** R4's custom parameters (strategies-outputs-web §7.9): arithmetic means, all correlations 0. */
const r4Params = {
  meanKind: "arithmetic",
  stocks: { meanBp: 600, volBp: 1200 },
  bonds: { meanBp: 400, volBp: 700 },
  bills: { meanBp: 300, volBp: 200 },
  inflation: { meanBp: 250, volBp: 100, persistenceBp: 0 },
  correlationBp: identity,
} as const;

describe("ReturnModelConfig (engine-and-returns §2.2, seams C3)", () => {
  it("plan decision 6: a new scenario runs the bootstrap with a mean block of 10 years", () => {
    expect(DEFAULT_RETURN_MODEL).toEqual({ kind: "bootstrap", meanBlockYears: 10 });
    expect(ReturnModelConfig.parse(DEFAULT_RETURN_MODEL)).toEqual(DEFAULT_RETURN_MODEL);
    expect(ReturnModelConfig.parse({ kind: "bootstrap" })).toEqual(DEFAULT_RETURN_MODEL);
  });

  it("plan decision 7: historical cohorts default to auto; complete and wrap can be chosen", () => {
    expect(ReturnModelConfig.parse({ kind: "historical" })).toEqual({ kind: "historical", cohorts: "auto" });
    for (const cohorts of ["complete", "wrap"]) expect(ReturnModelConfig.parse({ kind: "historical", cohorts })).toEqual({ kind: "historical", cohorts });
    expect(ok(ReturnModelConfig, { kind: "historical", cohorts: "rolling" })).toBe(false);
  });

  it("R3 (§7.8) is the historical model with complete cohorts", () => {
    expect(ok(ReturnModelConfig, { kind: "historical", cohorts: "complete" })).toBe(true);
  });

  it("R4 (§7.9): custom parametric parameters in basis points", () => {
    const model = ReturnModelConfig.parse({ kind: "parametric", preset: "custom", params: r4Params });
    // bills.persistenceBp defaults to 0; the two initial rates stay absent (the data file's last year).
    expect(model).toEqual({ kind: "parametric", preset: "custom", params: { ...r4Params, bills: { ...r4Params.bills, persistenceBp: 0 } } });
    expect(forbiddenValuePaths(model)).toEqual([]);
  });

  it("the presets take no parameters; custom needs them", () => {
    for (const preset of ["historical", "conservative"]) expect(ok(ReturnModelConfig, { kind: "parametric", preset }), preset).toBe(true);
    expect(ok(ReturnModelConfig, { kind: "parametric", preset: "historical", params: r4Params })).toBe(false);
    const missing = ReturnModelConfig.safeParse({ kind: "parametric", preset: "custom" });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]).toMatchObject({ path: ["params"], message: "the custom preset needs its parameters" });
  });

  it("R1 and R2 (§7.6, §7.7): the fixed model in parts per million", () => {
    // R1: every asset 5.0% a year, inflation 2.5%.
    const r1 = { kind: "fixed", series: [{ stocksPpm: 50_000, bondsPpm: 50_000, billsPpm: 50_000, inflationPpm: 25_000 }] };
    expect(ReturnModelConfig.parse(r1)).toEqual(r1);
    // R2: stocks 6%, bonds 4%, bills 2%, inflation 2.5%.
    expect(ok(ReturnModelConfig, { kind: "fixed", series: [{ stocksPpm: 60_000, bondsPpm: 40_000, billsPpm: 20_000, inflationPpm: 25_000 }] })).toBe(true);
    // The data file's precision: 1928 stocks 0.438112 → 438,112 ppm; 1931 −0.438375 → −438,375.
    expect(ok(FixedReturnRow, { stocksPpm: 438_112, bondsPpm: 8_355, billsPpm: 30_800, inflationPpm: -11_561 })).toBe(true);
    expect(ok(FixedReturnRow, { stocksPpm: -438_375, bondsPpm: -25_589, billsPpm: 23_100, inflationPpm: -93_168 })).toBe(true);
  });

  it("C3: integers only, in range", () => {
    expect(ok(ReturnModelConfig, { kind: "bootstrap", meanBlockYears: 2.5 })).toBe(false);
    expect(ok(ReturnModelConfig, { kind: "bootstrap", meanBlockYears: 0 })).toBe(false);
    expect(ok(ReturnModelConfig, { kind: "bootstrap", meanBlockYears: 31 })).toBe(false);
    expect(ok(ReturnModelConfig, { kind: "bootstrap", meanBlockYears: 1 })).toBe(true);
    expect(ok(FixedReturnRow, { stocksPpm: 50_000.5, bondsPpm: 0, billsPpm: 0, inflationPpm: 0 })).toBe(false);
    expect(ok(FixedReturnRow, { stocksPpm: -1_000_000, bondsPpm: 0, billsPpm: 0, inflationPpm: 0 })).toBe(false);
    expect(ok(FixedReturnRow, { stocksPpm: -999_999, bondsPpm: 0, billsPpm: 0, inflationPpm: 0 })).toBe(true);
    expect(ok(ParametricParams, { ...r4Params, stocks: { meanBp: 6.5, volBp: 1200 } })).toBe(false);
    expect(ok(ParametricParams, { ...r4Params, stocks: { meanBp: 600, volBp: -1 } })).toBe(false);
    expect(ok(ParametricParams, { ...r4Params, stocks: { meanBp: -5001, volBp: 1200 } })).toBe(false);
    expect(ok(ParametricParams, { ...r4Params, inflation: { ...r4Params.inflation, persistenceBp: 9501 } })).toBe(false);
    expect(ok(ParametricParams, { ...r4Params, inflation: { ...r4Params.inflation, initialBp: 274 } })).toBe(true);
    expect(ok(ParametricParams, { ...r4Params, inflation: { ...r4Params.inflation, initialBp: 5001 } })).toBe(false);
    expect(ok(ParametricParams, { ...r4Params, inflation: { meanBp: 250, volBp: 100 } })).toBe(false);
  });

  it("the fixed series has 1 to 120 rows", () => {
    const row = { stocksPpm: 0, bondsPpm: 0, billsPpm: 0, inflationPpm: 0 };
    expect(ok(ReturnModelConfig, { kind: "fixed", series: [] })).toBe(false);
    expect(ok(ReturnModelConfig, { kind: "fixed", series: Array.from({ length: 120 }, () => row) })).toBe(true);
    expect(ok(ReturnModelConfig, { kind: "fixed", series: Array.from({ length: 121 }, () => row) })).toBe(false);
  });

  it("correlations: 4 × 4, −10000 to 10000, unit diagonal, symmetric", () => {
    expect(ok(CorrelationMatrixBp, identity)).toBe(true);
    const offDiagonal = identity.map((row) => [...row]);
    offDiagonal[0]![1] = 224;
    offDiagonal[1]![0] = 224;
    expect(ok(CorrelationMatrixBp, offDiagonal)).toBe(true);
    const asymmetric = identity.map((row) => [...row]);
    asymmetric[0]![1] = 224;
    expect(CorrelationMatrixBp.safeParse(asymmetric).error?.issues[0]?.message).toBe("the matrix must be symmetric");
    const diagonal = identity.map((row) => [...row]);
    diagonal[2]![2] = 9999;
    expect(CorrelationMatrixBp.safeParse(diagonal).error?.issues[0]?.message).toBe("the diagonal must be 10000 bp");
    expect(ok(CorrelationMatrixBp, identity.slice(0, 3))).toBe(false);
    expect(ok(CorrelationMatrixBp, identity.map((row) => row.slice(0, 3)))).toBe(false);
    const outOfRange = identity.map((row) => [...row]);
    outOfRange[0]![3] = -10001;
    outOfRange[3]![0] = -10001;
    expect(ok(CorrelationMatrixBp, outOfRange)).toBe(false);
    expect(ok(CorrelationMatrixBp, identity.map((row) => row.map((v) => v / 10000)))).toBe(false);
  });

  it("strict: an unknown key is refused in every kind", () => {
    for (const model of [
      { kind: "historical", window: 30 },
      { kind: "bootstrap", meanBlockYears: 10, seed: 1 },
      { kind: "parametric", preset: "historical", shift: 0 },
      { kind: "fixed", series: [{ stocksPpm: 0, bondsPpm: 0, billsPpm: 0, inflationPpm: 0, goldPpm: 0 }] },
      { kind: "parametric", preset: "custom", params: { ...r4Params, extra: 1 } },
      { kind: "parametric", preset: "custom", params: { ...r4Params, bills: { ...r4Params.bills, extra: 1 } } },
      { kind: "lognormal" },
    ]) {
      expect(ok(ReturnModelConfig, model), JSON.stringify(model)).toBe(false);
    }
  });
});

describe("PortfolioSettings (seams §2.1, plan decision 8)", () => {
  it("taxable accounts are fully rebalanced by default; the asset map is optional", () => {
    expect(PortfolioSettings.parse({})).toEqual({ taxableRebalance: "full" });
    expect(PortfolioSettings.parse(DEFAULT_PORTFOLIO_SETTINGS)).toEqual(DEFAULT_PORTFOLIO_SETTINGS);
    expect(PortfolioSettings.parse({ taxableRebalance: "flows_only" })).toEqual({ taxableRebalance: "flows_only" });
    expect(ok(PortfolioSettings, { taxableRebalance: "none" })).toBe(false);
    expect(ok(PortfolioSettings, { taxableRebalance: "full", stockDividendYield: 0.013 })).toBe(false);
  });

  it("engine decision 3: the default map sends stocks, real estate and other to stocks, bonds to bonds, cash to bills", () => {
    expect(Object.keys(DEFAULT_ASSET_CLASS_MAP)).toEqual(AssetClass.options);
    expect(AssetClassMap.parse(DEFAULT_ASSET_CLASS_MAP)).toEqual(DEFAULT_ASSET_CLASS_MAP);
    expect(PortfolioSettings.parse({ assetClassMap: DEFAULT_ASSET_CLASS_MAP })).toEqual({ taxableRebalance: "full", assetClassMap: DEFAULT_ASSET_CLASS_MAP });
    expect(SIM_ASSETS).toEqual(["stocks", "bonds", "bills"]);
  });

  it("each row of a map sums to 10000; every class is present", () => {
    expect(ok(AssetClassMapRow, [5000, 0, 5000])).toBe(true);
    expect(AssetClassMapRow.safeParse([5000, 0, 4999]).error?.issues[0]?.message).toBe("a row must sum to 10000 bp");
    expect(ok(AssetClassMapRow, [5000, 5000])).toBe(false);
    expect(ok(AssetClassMapRow, [2500.5, 2500, 4999.5])).toBe(false);
    const { other: _other, ...five } = DEFAULT_ASSET_CLASS_MAP;
    expect(ok(AssetClassMap, five)).toBe(false);
    expect(ok(AssetClassMap, { ...DEFAULT_ASSET_CLASS_MAP, gold: [10000, 0, 0] })).toBe(false);
  });
});
