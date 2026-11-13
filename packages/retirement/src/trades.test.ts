import { describe, expect, it } from "vitest";
import { EngineInvariantError } from "./errors.js";
import {
  TRADE_FLOWS_ONLY,
  TRADE_FULL,
  type TradeMode,
  createTradeResult,
  depositAtWeights,
  planTrades,
  tradeModeOf,
} from "./trades.js";

// Build step 15: one trade list per account for flows and rebalancing, average-cost basis per
// simulated asset (engine-and-returns §3.8, T23; seams C17 item 1). Dollars within 0.005.

const CENT = 2; // toBeCloseTo(x, 2): |actual − expected| < 0.005

interface Account {
  bal: Float64Array;
  basis: Float64Array;
  target: Float64Array;
}

function account(bal: [number, number, number], basis: [number, number, number], target: [number, number, number]): Account {
  return { bal: Float64Array.from(bal), basis: Float64Array.from(basis), target: Float64Array.from(target) };
}

function trade(acct: Account, netOut: number, mode: TradeMode, taxable: boolean, apply: boolean) {
  const out = createTradeResult();
  planTrades(acct.bal, acct.basis, 0, acct.target, 0, netOut, mode, taxable, apply, out);
  return out;
}

function expectAll(actual: Float64Array, expected: number[]): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((x, j) => expect(actual[j]).toBeCloseTo(x, CENT));
}

describe("T23 trades, realized gains and the guards", () => {
  it("T23 full rebalance: gain 74,285.71, basis 244,285.71 / 370,000, holdings 570,000 / 380,000", () => {
    // V' = 1,000,000 − 50,000 = 950,000; Δ_S = 700,000 − 0.6 × 950,000 = +130,000 (sold);
    // Δ_B = 300,000 − 0.4 × 950,000 = −80,000 (bought). Gain 130,000 × (1 − 300,000/700,000)
    // = 130,000 × 4/7 = 74,285.714; stock basis 300,000 − 130,000 × 3/7 = 244,285.714; bond basis
    // 290,000 + 80,000 = 370,000.
    const a = account([700_000, 300_000, 0], [300_000, 290_000, 0], [0.6, 0.4, 0]);
    const preview = trade(a, 50_000, TRADE_FULL, true, false);
    expect(preview.realizedGain).toBeCloseTo(74_285.71, CENT);
    expect(preview.valueAfter).toBe(950_000);
    expectAll(preview.sell, [130_000, 0, 0]);
    expectAll(preview.buy, [0, 80_000, 0]);
    expectAll(preview.post, [570_000, 380_000, 0]);
    // A preview writes nothing.
    expect(Array.from(a.bal)).toEqual([700_000, 300_000, 0]);
    expect(Array.from(a.basis)).toEqual([300_000, 290_000, 0]);

    const applied = trade(a, 50_000, TRADE_FULL, true, true);
    expect(applied.realizedGain).toBeCloseTo(74_285.71, CENT);
    expectAll(a.bal, [570_000, 380_000, 0]);
    expectAll(a.basis, [244_285.71, 370_000, 0]);
  });

  it("T23 flows only: sell 50,000 of stocks; gain 28,571.43, basis 278,571.43 / 290,000, holdings 650,000 / 300,000", () => {
    // P = Σ max(Δ, 0) = 130,000; sell_S = 130,000 × 50,000 / 130,000 = 50,000; nothing bought.
    // Gain 50,000 × 4/7 = 28,571.429; basis 300,000 − 50,000 × 3/7 = 278,571.429.
    const a = account([700_000, 300_000, 0], [300_000, 290_000, 0], [0.6, 0.4, 0]);
    const out = trade(a, 50_000, TRADE_FLOWS_ONLY, true, true);
    expect(out.realizedGain).toBeCloseTo(28_571.43, CENT);
    expectAll(out.sell, [50_000, 0, 0]);
    expectAll(out.buy, [0, 0, 0]);
    expectAll(a.bal, [650_000, 300_000, 0]);
    expectAll(a.basis, [278_571.43, 290_000, 0]);
  });

  it("T23 a Roth account with the same numbers trades the same amounts and reports no gain (flows_only is for taxable accounts only)", () => {
    for (const mode of [TRADE_FULL, TRADE_FLOWS_ONLY] as const) {
      const a = account([700_000, 300_000, 0], [0, 0, 0], [0.6, 0.4, 0]);
      const out = trade(a, 50_000, mode, false, true);
      expect(out.realizedGain).toBe(0);
      expectAll(out.sell, [130_000, 0, 0]);
      expectAll(out.buy, [0, 80_000, 0]);
      expectAll(a.bal, [570_000, 380_000, 0]);
      // A non-taxable account keeps no basis.
      expect(Array.from(a.basis)).toEqual([0, 0, 0]);
    }
  });

  it("T23 a single-asset taxable account, 10,000 out in each of two years: gain 6,000 each year, 90,000 / 80,000, basis 36,000 / 32,000, no NaN", () => {
    // 100,000 stocks at basis 40,000, target 100/0/0, no returns. Year 1: Δ_S = 100,000 − 90,000
    // = 10,000; the empty bonds and bills have Δ = 0 and are skipped. Gain 10,000 × (1 − 0.4) =
    // 6,000; basis 40,000 − 10,000 × 0.4 = 36,000. Year 2: gain 10,000 × (1 − 36,000/90,000) =
    // 6,000; basis 36,000 − 4,000 = 32,000.
    for (const mode of [TRADE_FULL, TRADE_FLOWS_ONLY] as const) {
      const a = account([100_000, 0, 0], [40_000, 0, 0], [1, 0, 0]);
      const y1 = trade(a, 10_000, mode, true, true);
      expect(y1.realizedGain).toBeCloseTo(6_000, CENT);
      expectAll(a.bal, [90_000, 0, 0]);
      expectAll(a.basis, [36_000, 0, 0]);
      const y2 = trade(a, 10_000, mode, true, true);
      expect(y2.realizedGain).toBeCloseTo(6_000, CENT);
      expectAll(a.bal, [80_000, 0, 0]);
      expectAll(a.basis, [32_000, 0, 0]);
      for (const x of [...a.bal, ...a.basis, ...y2.sell, ...y2.buy, ...y2.post, y2.realizedGain]) expect(Number.isNaN(x)).toBe(false);
    }
  });

  it("T23 an account exactly on target with no flow under flows_only: no trade, gain 0, balances and basis unchanged", () => {
    const a = account([60_000, 40_000, 0], [50_000, 41_000, 0], [0.6, 0.4, 0]);
    const out = trade(a, 0, TRADE_FLOWS_ONLY, true, true);
    expect(out.realizedGain).toBe(0);
    expect(Array.from(out.sell)).toEqual([0, 0, 0]);
    expect(Array.from(out.buy)).toEqual([0, 0, 0]);
    expect(Array.from(a.bal)).toEqual([60_000, 40_000, 0]);
    expect(Array.from(a.basis)).toEqual([50_000, 41_000, 0]);
  });

  it("T23 a deposit (netOut < 0) buys the underweight assets: full and flows only", () => {
    // 700,000 / 300,000 at basis 300,000 / 290,000, target 60/40, 50,000 deposited: V' = 1,050,000;
    // Δ_S = 700,000 − 630,000 = +70,000; Δ_B = 300,000 − 420,000 = −120,000.
    // Full: sell 70,000 of stocks (gain 70,000 × 4/7 = 40,000; basis 300,000 − 30,000 = 270,000),
    // buy 120,000 of bonds (basis 410,000); holdings 630,000 / 420,000.
    const full = account([700_000, 300_000, 0], [300_000, 290_000, 0], [0.6, 0.4, 0]);
    const f = trade(full, -50_000, TRADE_FULL, true, true);
    expect(f.realizedGain).toBeCloseTo(40_000, CENT);
    expectAll(full.bal, [630_000, 420_000, 0]);
    expectAll(full.basis, [270_000, 410_000, 0]);
    // Flows only: Q = 120,000; buy_B = 120,000 × 50,000 / 120,000 = 50,000; nothing sold, no gain;
    // holdings 700,000 / 350,000, bond basis 340,000.
    const flows = account([700_000, 300_000, 0], [300_000, 290_000, 0], [0.6, 0.4, 0]);
    const g = trade(flows, -50_000, TRADE_FLOWS_ONLY, true, true);
    expect(g.realizedGain).toBe(0);
    expectAll(g.sell, [0, 0, 0]);
    expectAll(flows.bal, [700_000, 350_000, 0]);
    expectAll(flows.basis, [300_000, 340_000, 0]);
  });

  it("T23 emptying an account sells every holding and leaves basis at exactly 0, in both modes", () => {
    // V' = 0: Δ_j = bal_j; gain = 60,000 × (1 − 45/60) + 40,000 × (1 − 41/40) = 15,000 − 1,000 = 14,000.
    for (const mode of [TRADE_FULL, TRADE_FLOWS_ONLY] as const) {
      const a = account([60_000, 40_000, 0], [45_000, 41_000, 0], [0.6, 0.4, 0]);
      const out = trade(a, 100_000, mode, true, true);
      expect(out.realizedGain).toBeCloseTo(14_000, CENT);
      expect(out.valueAfter).toBe(0);
      expect(Array.from(a.bal)).toEqual([0, 0, 0]);
      expect(Array.from(a.basis)).toEqual([0, 0, 0]);
    }
  });

  it("T23 a sale of a whole holding with a zero target weight leaves its basis at exactly 0", () => {
    // Bills 10,000 at basis 10,000 with target 60/40/0 and no flow: Δ_C = 10,000 is sold in full.
    const a = account([50_000, 40_000, 10_000], [30_000, 40_000, 10_000], [0.6, 0.4, 0]);
    trade(a, 0, TRADE_FULL, true, true);
    expect(a.bal[2]).toBe(0);
    expect(a.basis[2]).toBe(0);
    // V' = 100,000: stocks 60,000 (bought 10,000; basis 40,000), bonds 40,000 unchanged.
    expectAll(a.bal, [60_000, 40_000, 0]);
    expectAll(a.basis, [40_000, 40_000, 0]);
  });

  it("T23 a loss: selling below basis realizes a negative gain", () => {
    // 50,000 stocks at basis 80,000, 10,000 out: gain 10,000 × (1 − 1.6) = −6,000; basis 80,000 − 16,000 = 64,000.
    const a = account([50_000, 0, 0], [80_000, 0, 0], [1, 0, 0]);
    expect(trade(a, 10_000, TRADE_FULL, true, true).realizedGain).toBeCloseTo(-6_000, CENT);
    expectAll(a.basis, [64_000, 0, 0]);
  });

  it("T23 guards: an overdraw within half a cent empties the account; beyond it, or a non-finite flow, is an invariant error", () => {
    const a = account([60_000, 40_000, 0], [60_000, 40_000, 0], [0.6, 0.4, 0]);
    const out = trade(a, 100_000.004, TRADE_FLOWS_ONLY, true, true);
    expect(out.valueAfter).toBe(0);
    expect(Array.from(a.bal)).toEqual([0, 0, 0]);
    const b = account([60_000, 40_000, 0], [60_000, 40_000, 0], [0.6, 0.4, 0]);
    expect(() => trade(b, 100_000.01, TRADE_FULL, true, false)).toThrow(EngineInvariantError);
    expect(() => trade(b, Number.NaN, TRADE_FULL, true, false)).toThrow(EngineInvariantError);
    expect(() => trade(b, Number.NEGATIVE_INFINITY, TRADE_FULL, true, false)).toThrow(EngineInvariantError);
  });

  it("T23 flows only never sells an underweight asset and never scales above 1", () => {
    // 90,000 / 0 / 30,000, target 60/40/0, 20,000 out: V' = 100,000; Δ = 90,000 − 60,000 = +30,000,
    // 0 − 40,000 = −40,000, 30,000 − 0 = +30,000 (Σ = 20,000); P = 60,000, scale 1/3: stocks and
    // bills 10,000 each, the underweight bonds nothing.
    const a = account([90_000, 0, 30_000], [90_000, 0, 30_000], [0.6, 0.4, 0]);
    const out = trade(a, 20_000, TRADE_FLOWS_ONLY, true, false);
    expectAll(out.sell, [10_000, 0, 10_000]);
    expectAll(out.buy, [0, 0, 0]);
    expect(out.sell[1]).toBe(0);
  });

  it("T23 several accounts share one array: the offset selects the account and leaves the others untouched", () => {
    const bal = Float64Array.from([1, 2, 3, 700_000, 300_000, 0]);
    const basis = Float64Array.from([1, 2, 3, 300_000, 290_000, 0]);
    const target = Float64Array.from([0.2, 0.3, 0.5, 0.6, 0.4, 0]);
    const out = createTradeResult();
    planTrades(bal, basis, 3, target, 3, 50_000, TRADE_FULL, true, true, out);
    expect(out.realizedGain).toBeCloseTo(74_285.71, CENT);
    expect(Array.from(bal.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(basis.subarray(0, 3))).toEqual([1, 2, 3]);
    expectAll(bal.subarray(3), [570_000, 380_000, 0]);
  });

  it("the surplus deposit goes in at the target weights, with basis in a taxable account (seams C24)", () => {
    // 10,000 at 60/30/10 into 100,000 / 0 / 0 at basis 40,000: 106,000 / 3,000 / 1,000, basis 46,000 / 3,000 / 1,000.
    const bal = Float64Array.from([100_000, 0, 0]);
    const basis = Float64Array.from([40_000, 0, 0]);
    const target = Float64Array.from([0.6, 0.3, 0.1]);
    depositAtWeights(bal, basis, 0, target, 0, 10_000, true);
    expectAll(bal, [106_000, 3_000, 1_000]);
    expectAll(basis, [46_000, 3_000, 1_000]);
    const roth = Float64Array.from([0, 0, 0]);
    const none = Float64Array.from([0, 0, 0]);
    depositAtWeights(roth, none, 0, target, 0, 10_000, false);
    expectAll(roth, [6_000, 3_000, 1_000]);
    expect(Array.from(none)).toEqual([0, 0, 0]);
    expect(() => depositAtWeights(bal, basis, 0, target, 0, -1, true)).toThrow(EngineInvariantError);
    expect(() => depositAtWeights(bal, basis, 0, target, 0, Number.NaN, true)).toThrow(EngineInvariantError);
  });

  it("the trade mode follows RunSettings.portfolio.taxableRebalance", () => {
    expect(tradeModeOf("full")).toBe(TRADE_FULL);
    expect(tradeModeOf("flows_only")).toBe(TRADE_FLOWS_ONLY);
  });
});
