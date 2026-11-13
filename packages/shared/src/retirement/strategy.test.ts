import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY, DEFAULT_WITHDRAWAL_ORDER, STRATEGY_INFO, StrategyConfig, StrategyKind, WithdrawalOrderConfig } from "./strategy.js";

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
