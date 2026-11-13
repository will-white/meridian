import { describe, expect, it } from "vitest";
import { createSpendingOutcome, fillNeeds, settleSpending } from "./outcome.js";
import { type SpendDecision, createSpendDecision } from "./types.js";

// Build step 18: what the loop does with the decision once the withdrawals are settled
// (strategies-outputs-web §3.8; seams C40's gross-year branch and below-plan flag). `net` is the
// record call's cash left after tax and need; the cases take it from the worked examples of §3.6,
// whose tax and withdrawals are the withdrawal step's (WD-10 to WD-14, build step 19).

const CENT = 2;

function decision(fields: Partial<SpendDecision>): SpendDecision {
  return Object.assign(createSpendDecision(), fields);
}

function settle(d: SpendDecision, net: number, o: { f?: number; drawdown?: boolean; rmd?: number } = {}) {
  const out = createSpendingOutcome();
  settleSpending(d, o.f ?? 1, o.drawdown ?? true, net, o.rmd ?? 0, out);
  return out;
}

describe("§3.8 settling the year's spending", () => {
  it("gross year, RMD below the rule (the numbers of WD-11): everything the rule released is spent, nothing saved", () => {
    // vpw, no essentials: gross 75,832.60, need = floor = 0. RMD 48,780.49, taxable withdrawal
    // wd = 27,052.11, tax 3,267.27, Social Security 50,000: net = 50,000 + 48,780.49 + 27,052.11
    // − 3,267.27 = 122,565.33. excess = max(0, 48,780.49 − 75,832.60) = 0; extra = net.
    const d = decision({ gross: 75_832.6, planned: 0 });
    const o = settle(d, 50_000 + 48_780.49 + 27_052.11 - 3_267.27, { rmd: 48_780.49 });
    expect(o.funded).toBeCloseTo(122_565.33, CENT);
    expect(o.surplus).toBeCloseTo(0, CENT);
    expect(o.shortfall).toBe(0);
    expect(o.failed).toBe(false);
  });

  it("gross year, RMD above the rule (the numbers of WD-12): 9,780.49 saved, 85,732.73 spent", () => {
    // fixed 3%: gross 39,000 < RMD 48,780.49, wd = 0: net = 50,000 + 48,780.49 − 3,267.27 =
    // 95,513.22; excess = 48,780.49 − 39,000 = 9,780.49; extra = 85,732.73.
    const d = decision({ gross: 39_000 });
    const o = settle(d, 50_000 + 48_780.49 - 3_267.27, { rmd: 48_780.49 });
    expect(o.surplus).toBeCloseTo(9_780.49, CENT);
    expect(o.funded).toBeCloseTo(85_732.73, CENT);
  });

  it("gross year with a top-up (the numbers of WD-13): floor 50,000 funds 60,044.00; floor 65,000 funds exactly 65,000.00", () => {
    // fixed 4%, gross 40,000, Social Security 24,000, no RMD. Floor 50,000: wd = 40,000, tax 3,956:
    // net = 24,000 + 40,000 − 50,000 − 3,956 = 10,044 → funded 60,044, nothing saved.
    const low = settle(decision({ spend: 50_000, floor: 50_000, gross: 40_000, planned: 50_000 }), 10_044);
    expect(low.funded).toBeCloseTo(60_044, CENT);
    expect(low.surplus).toBe(0);
    expect(low.belowPlan).toBe(false);
    // Floor 65,000: topped up to 45,713.64 with tax 4,713.64, net = 0 → funded = need = 65,000.
    const high = settle(decision({ spend: 65_000, floor: 65_000, gross: 40_000, planned: 65_000 }), 24_000 + 45_713.64 - 65_000 - 4_713.64);
    expect(high.funded).toBeCloseTo(65_000, CENT);
    expect(high.failed).toBe(false);
  });

  it("a shortfall (the numbers of WD-10): funded 44,000.00, shortfall 16,000.00, the path fails", () => {
    // Target 60,000; Social Security 24,000, RMD 990.10, everything else 19,009.90 drawn, tax 0:
    // net = 44,000 − 60,000 = −16,000.
    const o = settle(decision({ spend: 60_000, floor: 60_000, planned: 60_000 }), 24_000 + 990.1 + 19_009.9 - 60_000);
    expect(o.shortfall).toBeCloseTo(16_000, CENT);
    expect(o.funded).toBeCloseTo(44_000, CENT);
    expect(o.surplus).toBe(0);
    expect(o.failed).toBe(true);
    expect(o.belowPlan).toBe(true);
  });

  it("a surplus in a target year (the numbers of WD-14): funded = need, 31,768.72 saved", () => {
    const o = settle(decision({ spend: 100_000, floor: 100_000, planned: 100_000 }), 31_768.7154, { rmd: 81_300.81 });
    expect(o.funded).toBe(100_000);
    expect(o.surplus).toBeCloseTo(31_768.72, CENT);
  });

  it("the shortfall is capped at the need: tax beyond all cash is dropped (engine-and-returns §3.11)", () => {
    const o = settle(decision({ spend: 10_000, floor: 10_000, planned: 10_000 }), -25_000);
    expect(o.shortfall).toBe(10_000);
    expect(o.funded).toBe(0);
  });

  it("accumulation: a goal not fully paid is a shortfall but never a failure or below plan", () => {
    const o = settle(decision({ lump: 20_000, lumpFloor: 0 }), -5, { drawdown: false });
    expect(o.need).toBe(20_000);
    expect(o.floorNeed).toBe(0);
    expect(o.funded).toBe(19_995);
    expect(o.failed).toBe(false);
    expect(o.belowPlan).toBe(false);
  });

  it("below plan without failure: a gross year whose spending stays above the floor but under the plan", () => {
    // planned 60,000, floor 40,000, the rule's money funds 50,000.
    const o = settle(decision({ spend: 40_000, floor: 40_000, gross: 30_000, planned: 60_000 }), 10_000, { rmd: 0 });
    expect(o.funded).toBe(50_000);
    expect(o.failed).toBe(false);
    expect(o.belowPlan).toBe(true);
  });

  it("the failure test allows half a cent (CASH_TOL)", () => {
    const d = decision({ spend: 1_000, floor: 1_000, planned: 1_000 });
    expect(settle(d, -0.004).failed).toBe(false);
    expect(settle(d, -0.006).failed).toBe(true);
  });

  it("a partial first year: recurring amounts are scaled by f, lumps are not, and so is the rule's release", () => {
    // f = 0.25: need = 40,000 × 0.25 + 1,000 = 11,000; planned 48,000 × 0.25 + 1,000 = 13,000.
    // Gross 8,000 releases 8,000 × 0.25 + 1,000 = 3,000; an RMD of 5,000 exceeds it by 2,000, which
    // is saved; the rest of a net of 6,000 is spent: funded = 11,000 + 4,000 = 15,000.
    const d = decision({ spend: 40_000, floor: 40_000, lump: 1_000, lumpFloor: 1_000, gross: 8_000, planned: 48_000 });
    const needs = createSpendingOutcome();
    fillNeeds(d, 0.25, needs);
    expect([needs.need, needs.floorNeed, needs.plannedNeed]).toEqual([11_000, 11_000, 13_000]);
    const o = settle(d, 6_000, { f: 0.25, rmd: 5_000 });
    expect(o.surplus).toBe(2_000);
    expect(o.funded).toBe(15_000);
    expect(o.belowPlan).toBe(false);
  });
});
