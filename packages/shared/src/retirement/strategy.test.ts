import { describe, expect, it } from "vitest";
import {
  DEFAULT_STRATEGY,
  DEFAULT_WITHDRAWAL_ORDER,
  STRATEGY_INFO,
  StrategyConfig,
  StrategyKind,
  vpwParams,
  vpwPercentage,
  vpwRawPercentage,
  WithdrawalOrderConfig,
} from "./strategy.js";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe("StrategyConfig (strategies-outputs-web §4.1)", () => {
  it("the defaults parse to themselves", () => {
    expect(DEFAULT_STRATEGY).toEqual({ kind: "constant_dollar" });
    expect(StrategyConfig.parse(DEFAULT_STRATEGY)).toEqual(DEFAULT_STRATEGY);
    expect(DEFAULT_WITHDRAWAL_ORDER).toEqual({ kind: "default", cashReserveCents: "0" });
    expect(WithdrawalOrderConfig.parse({ kind: "default" })).toEqual(DEFAULT_WITHDRAWAL_ORDER);
  });

  it("each strategy's parameters default as the design lists them", () => {
    expect(StrategyConfig.parse({ kind: "fixed_percentage" })).toEqual({ kind: "fixed_percentage", rateBp: 400 });
    expect(StrategyConfig.parse({ kind: "guardrails" })).toEqual({
      kind: "guardrails",
      upperBandBp: 2000,
      lowerBandBp: 2000,
      cutBp: 1000,
      raiseBp: 1000,
      skipInflationAfterLoss: true,
      preservationCutoffYears: 15,
      planningAge: 95,
    });
    expect(StrategyConfig.parse({ kind: "vpw" })).toEqual({ kind: "vpw", stockRealBp: 500, bondRealBp: 190, lastWithdrawalAge: 99, maxRateBp: 1000 });
    // rateBp absent = the plan's own percentage.
    expect(StrategyConfig.parse({ kind: "floor_ceiling" })).toEqual({ kind: "floor_ceiling", floorBp: 1500, ceilingBp: 2000 });
    expect(StrategyConfig.parse({ kind: "floor_ceiling", rateBp: 450 })).toEqual({ kind: "floor_ceiling", rateBp: 450, floorBp: 1500, ceilingBp: 2000 });
  });

  it("ranges and integers", () => {
    for (const [config, valid] of [
      [{ kind: "fixed_percentage", rateBp: 50 }, true],
      [{ kind: "fixed_percentage", rateBp: 2000 }, true],
      [{ kind: "fixed_percentage", rateBp: 49 }, false],
      [{ kind: "fixed_percentage", rateBp: 2001 }, false],
      [{ kind: "fixed_percentage", rateBp: 400.5 }, false],
      [{ kind: "guardrails", lowerBandBp: 9001 }, false],
      [{ kind: "guardrails", upperBandBp: 99 }, false],
      [{ kind: "guardrails", preservationCutoffYears: 61 }, false],
      [{ kind: "guardrails", planningAge: 79 }, false],
      [{ kind: "vpw", lastWithdrawalAge: 84 }, false],
      [{ kind: "vpw", stockRealBp: 1501 }, false],
      [{ kind: "vpw", maxRateBp: 99 }, false],
      [{ kind: "floor_ceiling", ceilingBp: 20001 }, false],
      [{ kind: "floor_ceiling", floorBp: 9001 }, false],
    ] as const) {
      expect(ok(StrategyConfig, config), JSON.stringify(config)).toBe(valid);
    }
  });

  it("strict, with no unknown kind", () => {
    expect(ok(StrategyConfig, { kind: "constant_dollar", rateBp: 400 })).toBe(false);
    expect(ok(StrategyConfig, { kind: "guardrails", band: 2000 })).toBe(false);
    expect(ok(StrategyConfig, { kind: "bucket" })).toBe(false);
    expect(ok(WithdrawalOrderConfig, { kind: "default", cashReserveCents: "0", order: [] })).toBe(false);
    expect(ok(WithdrawalOrderConfig, { kind: "bracket_fill" })).toBe(false);
  });

  it("the cash reserve is bounded request cents", () => {
    expect(ok(WithdrawalOrderConfig, { kind: "default", cashReserveCents: "2500000" })).toBe(true);
    for (const bad of ["-1", "1.5", "1000000000000000", 100]) expect(ok(WithdrawalOrderConfig, { kind: "default", cashReserveCents: bad }), String(bad)).toBe(false);
  });

  it("STRATEGY_INFO has a card for every kind", () => {
    expect(Object.keys(STRATEGY_INFO)).toEqual(StrategyKind.options);
    expect(Object.values(STRATEGY_INFO).map((i) => i.label)).toEqual(["Constant inflation-adjusted", "Fixed percentage", "Guardrails", "Variable percentage", "Floor and ceiling"]);
    for (const info of Object.values(STRATEGY_INFO)) {
      expect(info.summary.length).toBeGreaterThan(40);
      expect(info.source.length).toBeGreaterThan(0);
    }
  });
});

describe("vpwPercentage (strategies-outputs-web §3.4 (d), decision 16, seams C47)", () => {
  const p = vpwParams({ kind: "vpw", stockRealBp: 500, bondRealBp: 190, lastWithdrawalAge: 99, maxRateBp: 1000 });

  it("the default setting gives 5.0% and 1.9% real, n = 100 − age, a 10% cap", () => {
    expect(p).toEqual({ stockReal: 0.05, bondReal: 0.019, lastAge: 99, maxRate: 0.1 });
    expect(vpwParams(StrategyConfig.parse({ kind: "vpw" }) as Extract<StrategyConfig, { kind: "vpw" }>)).toEqual(p);
  });

  it("by hand at 65 with 60% stocks: g = 3.76%, n = 35, 1.0376^35 = 3.6395, 0.0376 ÷ 0.72524 ÷ 1.0376 = 0.049966", () => {
    expect(vpwPercentage(65, 0.6, p)).toBeCloseTo(0.049966, 6);
  });

  // The design's table, re-derived with 60-digit decimal arithmetic (Python `decimal`, prec 60):
  // g = s × 0.05 + (1 − s) × 0.019, n = 100 − age, raw = g ÷ (1 − 1 ÷ (1 + g)^n) ÷ (1 + g). Every
  // value agrees with the design's four decimals of a percent; the float64 result must agree with the
  // exact one to 1e−12.
  it.each([
    [60, 0.5, 40, 0.0449151827316],
    [62, 0.5, 38, 0.0460357998522],
    [65, 0.5, 35, 0.0479912545499],
    [65, 0.6, 35, 0.0499660816507],
    [66, 0.6, 34, 0.0506881241622],
    [69, 0.6, 31, 0.0531709141432],
    [70, 0.6, 30, 0.0541218425212],
    [71, 0.6, 29, 0.0551451615678],
    [40, 0.4, 60, 0.0360903504547],
    [65, 0.4, 35, 0.0460494651781],
    [75, 0.5, 25, 0.0583327672762],
    [88, 0.5, 12, 0.0997386829627],
    [64, 0.5, 36, 0.0472987157233],
  ])("the table: age %i, %f stocks (n = %i) → %f", (age, share, _n, expected) => {
    expect(Math.abs(vpwRawPercentage(age, share, p) - expected)).toBeLessThan(1e-12);
    expect(vpwPercentage(age, share, p)).toBe(vpwRawPercentage(age, share, p));
  });

  it("the nine published table values, to the printed 0.1%", () => {
    const published: Array<[number, number, number]> = [
      [60, 0.5, 4.5],
      [62, 0.5, 4.6],
      [65, 0.6, 5.0],
      [66, 0.6, 5.1],
      [69, 0.6, 5.3],
      [70, 0.6, 5.4],
      [71, 0.6, 5.5],
      [40, 0.4, 3.6],
      [65, 0.4, 4.6],
    ];
    for (const [age, share, printed] of published) expect(Math.round(vpwPercentage(age, share, p) * 1000), `${age}, ${share}`).toBe(Math.round(printed * 10));
  });

  it("89 at 50% stocks is capped at 10% (raw 10.7094%); n never falls below 1; g = 0 gives 1 ÷ n", () => {
    expect(Math.abs(vpwRawPercentage(89, 0.5, p) - 0.107093853194)).toBeLessThan(1e-11);
    expect(vpwPercentage(89, 0.5, p)).toBe(0.1);
    // At 99 and later n = 1: g ÷ (1 − 1 ÷ (1 + g)) ÷ (1 + g) = 1, the whole portfolio (to float64
    // rounding: the two divisions leave 1 + 2.2e−15), capped.
    expect(vpwRawPercentage(99, 0.5, p)).toBeCloseTo(1, 12);
    expect(vpwRawPercentage(104, 0.5, p)).toBe(vpwRawPercentage(99, 0.5, p));
    expect(vpwPercentage(104, 0.5, p)).toBe(0.1);
    // 1 ÷ 35 = 2.8571%.
    expect(vpwRawPercentage(65, 0.5, { stockReal: 0, bondReal: 0, lastAge: 99, maxRate: 0.1 })).toBe(1 / 35);
  });

  it("is deterministic: the power is taken by repeated multiplication, the engine's powInt order", () => {
    const g = 0.6 * 0.05 + (1 - 0.6) * 0.019;
    let growth = 1;
    for (let i = 0; i < 35; i++) growth *= 1 + g;
    expect(vpwRawPercentage(65, 0.6, p)).toBe(g / (1 - 1 / growth) / (1 + g));
  });
});
