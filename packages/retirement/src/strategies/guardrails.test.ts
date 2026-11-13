import { describe, expect, it } from "vitest";
import { buildSimInput, type PersonOptions } from "../testing/simInput.js";
import { decideSpending } from "./decide.js";
import { prepareStrategies, type StrategyTables } from "./prepare.js";
import { level, testView, type TestViewFields } from "./testKit.js";
import { RULE, SLOT, STRATEGY_STATE_LENGTH, createSpendDecision } from "./types.js";

// Build step 18: guardrails on the reference track (strategies-outputs-web decision 15, §3.4 (c);
// ST-4 to ST-13). Every case is one person (or couple) retired from January 2027, no healthcare or
// care, so `spend` = C. Dollars within 0.005; a and ρ to six decimals as the design prints them.

const CENT = 2;
const SIX = 6;

/** Guardrails with `base` a year; the person's horizon sets `yearsRemaining` (fixed age 95). */
function guardrails(baseDollars: number, o: { essentialDollars?: number; people?: PersonOptions[] } = {}): StrategyTables {
  return prepareStrategies(
    buildSimInput({
      people: o.people ?? [{ birthYear: 1971 }], // 1971 + 95 = 2066: 40 years remaining in 2027
      spending: { baseAnnualCents: String(baseDollars * 100), essentialAnnualCents: String((o.essentialDollars ?? 0) * 100) },
      strategy: { kind: "guardrails" },
    }),
  );
}

function decide(tb: StrategyTables, state: Float64Array, fields: TestViewFields) {
  const out = createSpendDecision();
  decideSpending(testView(tb, fields), state, out);
  return out;
}

/** ρ before any rule of the year: a × x0 × cpi ÷ P. */
function rhoBefore(state: Float64Array, cpi: number, P: number): number {
  return (state[SLOT.ADJUST]! * state[SLOT.X0]! * cpi) / P;
}

describe("ST-4 guardrails trace", () => {
  it("ST-4 plan 50,000 on 1,000,000, inflation 3%, 40 years remaining: C, a and the flags of §3.4 (c)", () => {
    // The design's table. P of the next year = (P − C) × (1 + return); ρ = a × x0 × cpi ÷ P with
    // x0 = 1,000,000. Year 1 by hand: ρ = 1,030,000 ÷ 807,500 = 1.275542 > 1 after a loss with
    // positive inflation, so the raise is skipped (a = 1 ÷ 1.03 = 0.970874, ρ = 1.238390 > 1.2) and
    // then cut (a = 0.9 ÷ 1.03 = 0.873786); C = 0.873786 × 51,500 = 45,000.00.
    const tb = guardrails(50_000);
    const returns = [-0.15, -0.1, 0.25, 0.3, 0.2];
    const expected = [
      { P: 1_000_000, rho: Number.NaN, rhoAfter: Number.NaN, a: 1, C: 50_000, rule: 0 },
      { P: 807_500, rho: 1.275542, rhoAfter: 1.23839, a: 0.873786, C: 45_000, rule: RULE.FREEZE | RULE.CUT },
      // Year 2: ρ = 0.873786 × 1,060,900 ÷ 686,250 = 927,000 ÷ 686,250 = 1.3508196721; the design
      // prints it cut to 1.350819 (rounded: 1.350820), so the exact quotient is asserted.
      { P: 686_250, rho: 927_000 / 686_250, rhoAfter: 1.311475, a: 0.763503, C: 40_500, rule: RULE.FREEZE | RULE.CUT },
      { P: 807_187.5, rho: 1.033589, rhoAfter: 1.033589, a: 0.763503, C: 41_715, rule: 0 },
      { P: 995_114.25, rho: 0.863548, rhoAfter: 0.863548, a: 0.763503, C: 42_966.45, rule: 0 },
      { P: 1_142_577.36, rho: 0.77466, rhoAfter: 0.77466, a: 0.839853, C: 48_680.99, rule: RULE.RAISE },
    ];
    const state = new Float64Array(STRATEGY_STATE_LENGTH);
    let P = 1_000_000;
    for (let t = 0; t < expected.length; t++) {
      const e = expected[t]!;
      const cpi = level(1.03, t);
      expect(P).toBeCloseTo(e.P, CENT);
      if (t > 0) {
        const rho = rhoBefore(state, cpi, P);
        expect(rho).toBeCloseTo(e.rho, SIX);
        if ((e.rule & RULE.FREEZE) !== 0) expect(rho / 1.03).toBeCloseTo(e.rhoAfter, SIX);
      }
      const d = decide(tb, state, { t, cpi, portfolioStart: P, prevInflation: t > 0 ? 0.03 : Number.NaN, prevPortfolioReturn: t > 0 ? returns[t - 1]! : Number.NaN });
      expect(state[SLOT.STARTED]).toBe(1);
      expect(state[SLOT.ADJUST]).toBeCloseTo(e.a, SIX);
      expect(d.spend).toBeCloseTo(e.C, CENT);
      expect(d.floor).toBe(d.spend);
      expect(d.rule).toBe(e.rule);
      expect(d.spend / P).toBeCloseTo([0.05, 0.055728, 0.059016, 0.051679, 0.043177, 0.042606][t]!, SIX);
      expect(Number.isNaN(d.gross)).toBe(true);
      expect(d.planned).toBeCloseTo(50_000 * cpi, 9);
      if (t < returns.length) P = (P - d.spend) * (1 + returns[t]!);
    }
    expect(state[SLOT.X0]).toBe(1_000_000);
  });
});

describe("ST-5 to ST-7 the rule's conditions", () => {
  /** The state after ST-4's start year. */
  const started = () => Float64Array.from({ length: STRATEGY_STATE_LENGTH }, (_, i) => (i === SLOT.STARTED ? 1 : i === SLOT.X0 ? 1_000_000 : i === SLOT.ADJUST ? 1 : 0));

  it("ST-5 the final 15 years: year 1 of ST-4 with yearsRemaining 15 freezes but does not cut (a = 0.970874, C = 50,000.00)", () => {
    // Born 1947: horizon 2042, so in 2028 yearsRemaining = 2042 − 2028 + 1 = 15, not above 15.
    // a = 1 ÷ 1.03 = 0.970874; C = 0.970874 × 51,500 = 50,000.00.
    const tb = guardrails(50_000, { people: [{ birthYear: 1947 }] });
    const state = started();
    const d = decide(tb, state, { t: 1, cpi: 1.03, portfolioStart: 807_500, prevInflation: 0.03, prevPortfolioReturn: -0.15 });
    expect(d.rule).toBe(RULE.FREEZE);
    expect(state[SLOT.ADJUST]).toBeCloseTo(0.970874, SIX);
    expect(d.spend).toBeCloseTo(50_000, CENT);
  });

  it("ST-6 no freeze after a gain: P 800,000, cpi 1.03, previous return +5%, planned core 51,500 → ρ = 1.287500, cut, C = 46,350.00", () => {
    // ρ = 1,030,000 ÷ 800,000 = 1.2875 > 1.2 → a = 0.9; C = 0.9 × 51,500 = 46,350.
    const tb = guardrails(50_000);
    const state = started();
    expect(rhoBefore(state, 1.03, 800_000)).toBeCloseTo(1.2875, SIX);
    const d = decide(tb, state, { t: 1, cpi: 1.03, portfolioStart: 800_000, prevInflation: 0.03, prevPortfolioReturn: 0.05 });
    expect(d.rule).toBe(RULE.CUT);
    expect(state[SLOT.ADJUST]).toBeCloseTo(0.9, 12);
    expect(d.spend).toBeCloseTo(46_350, CENT);
  });

  it("ST-7 a freeze needs positive inflation: ST-4 year 1 at −1% (cpi 0.99, planned core 49,500) → ρ = 1.226006, no freeze, cut, C = 44,550.00", () => {
    // ρ = 990,000 ÷ 807,500 = 1.226006 > 1.2; inflation −1% is not > 0, so no freeze; a = 0.9;
    // C = 0.9 × 49,500 = 44,550.
    const tb = guardrails(50_000);
    const state = started();
    expect(rhoBefore(state, 0.99, 807_500)).toBeCloseTo(1.226006, SIX);
    const d = decide(tb, state, { t: 1, cpi: 0.99, portfolioStart: 807_500, prevInflation: -0.01, prevPortfolioReturn: -0.15 });
    expect(d.rule).toBe(RULE.CUT);
    expect(d.spend).toBeCloseTo(44_550, CENT);
  });

  it("ST-7 skipInflationAfterLoss false never freezes", () => {
    const tb = prepareStrategies(
      buildSimInput({ people: [{ birthYear: 1971 }], spending: { baseAnnualCents: "5000000" }, strategy: { kind: "guardrails", skipInflationAfterLoss: false } }),
    );
    const state = started();
    // ρ = 1.275542 > 1.2 without the freeze: cut only, a = 0.9, C = 46,350.
    const d = decide(tb, state, { t: 1, cpi: 1.03, portfolioStart: 807_500, prevInflation: 0.03, prevPortfolioReturn: -0.15 });
    expect(d.rule).toBe(RULE.CUT);
    expect(d.spend).toBeCloseTo(46_350, CENT);
  });
});

describe("ST-8 to ST-11 outside income and planned steps", () => {
  it("ST-8 income covers most of the need: year 1 a = 0.873786, C = 102,350.00 (draw 4,500.00); year 2 ρ = 1.064722, no rule, C = 105,420.50", () => {
    // Planned core 100,000, income 95,000 rising with prices, P = 1,000,000: the start year draws
    // 5,000. Year 1 (−20%, 3%): P = 995,000 × 0.8 = 796,000, ρ = 1,030,000 ÷ 796,000 = 1.293970,
    // freeze to 1.256281, cut: a = 0.873786. planDraw = 103,000 − 97,850 = 5,150;
    // C = 103,000 − (1 − 0.873786) × 5,150 = 102,350.00. Year 2 (+10%, 3%):
    // P = (796,000 − 4,500) × 1.1 = 870,650; ρ = 0.873786 × 1,060,900 ÷ 870,650 = 1.064722;
    // planDraw = 106,090 − 100,785.50 = 5,304.50; C = 106,090 − 0.126214 × 5,304.50 = 105,420.50.
    const tb = guardrails(100_000);
    const state = new Float64Array(STRATEGY_STATE_LENGTH);
    const d0 = decide(tb, state, { t: 0, cpi: 1, portfolioStart: 1_000_000, guaranteedIncome: 95_000 });
    expect(d0.spend).toBeCloseTo(100_000, CENT);
    const d1 = decide(tb, state, { t: 1, cpi: 1.03, portfolioStart: 796_000, guaranteedIncome: 97_850, prevInflation: 0.03, prevPortfolioReturn: -0.2 });
    expect(d1.rule).toBe(RULE.FREEZE | RULE.CUT);
    expect(state[SLOT.ADJUST]).toBeCloseTo(0.873786, SIX);
    expect(d1.spend).toBeCloseTo(102_350, CENT);
    expect(d1.spend - 97_850).toBeCloseTo(4_500, CENT);
    const P2 = (796_000 - 4_500) * 1.1;
    expect(P2).toBeCloseTo(870_650, CENT);
    expect(rhoBefore(state, level(1.03, 2), P2)).toBeCloseTo(1.064722, SIX);
    const d2 = decide(tb, state, { t: 2, cpi: level(1.03, 2), portfolioStart: P2, guaranteedIncome: 95_000 * level(1.03, 2), prevInflation: 0.03, prevPortfolioReturn: 0.1 });
    expect(d2.rule).toBe(0);
    expect(d2.spend).toBeCloseTo(105_420.5, CENT);
  });

  it("ST-9 a planned income step: year 1 ρ = 1.063830; year 2 ρ = 1.136364, no rule, C = 95,481.00", () => {
    // 1,500,000 and planned core 90,000, no income. Year 1 (+3%, 3%): P = 1,410,000 × 1.03 =
    // 1,452,300, ρ = 1,545,000 ÷ 1,452,300 = 1.063830; C = 92,700. Year 2: P = 1,359,600 × 1.03 =
    // 1,400,388, cpi 1.0609, ρ = 1,591,350 ÷ 1,400,388 = 1.136364, inside the band; Social Security
    // of 40,000 starts: planDraw = 95,481 − 40,000 = 55,481, a = 1, C = 95,481.00.
    const tb = guardrails(90_000);
    const state = new Float64Array(STRATEGY_STATE_LENGTH);
    decide(tb, state, { t: 0, cpi: 1, portfolioStart: 1_500_000 });
    const P1 = 1_410_000 * 1.03;
    expect(rhoBefore(state, 1.03, P1)).toBeCloseTo(1.06383, SIX);
    const d1 = decide(tb, state, { t: 1, cpi: 1.03, portfolioStart: P1, prevInflation: 0.03, prevPortfolioReturn: 0.03 });
    expect(d1.rule).toBe(0);
    expect(d1.spend).toBeCloseTo(92_700, CENT);
    const P2 = (P1 - d1.spend) * 1.03;
    expect(P2).toBeCloseTo(1_400_388, CENT);
    expect(rhoBefore(state, level(1.03, 2), P2)).toBeCloseTo(1.136364, SIX);
    const d2 = decide(tb, state, { t: 2, cpi: level(1.03, 2), portfolioStart: P2, guaranteedIncome: 40_000, prevInflation: 0.03, prevPortfolioReturn: 0.03 });
    expect(d2.rule).toBe(0);
    expect(d2.spend).toBeCloseTo(95_481, CENT);
  });

  it("ST-10 a pension without a cost-of-living clause: ρ = 1.052632, no rule, planDraw 41,800, C = 61,800.00", () => {
    // Planned core 60,000, nominal pension 20,000, P 800,000 (draw 40,000). Next year P =
    // 760,000 × 1.03 = 782,800, cpi 1.03: ρ = 824,000 ÷ 782,800 = 1.052632; planDraw = 61,800 −
    // 20,000 = 41,800; a = 1, C = 61,800.
    const tb = guardrails(60_000);
    const state = new Float64Array(STRATEGY_STATE_LENGTH);
    decide(tb, state, { t: 0, cpi: 1, portfolioStart: 800_000, guaranteedIncome: 20_000 });
    expect(rhoBefore(state, 1.03, 782_800)).toBeCloseTo(1.052632, SIX);
    const d = decide(tb, state, { t: 1, cpi: 1.03, portfolioStart: 782_800, guaranteedIncome: 20_000, prevInflation: 0.03, prevPortfolioReturn: 0.03 });
    expect(d.rule).toBe(0);
    expect(d.spend - 20_000).toBeCloseTo(41_800, CENT);
    expect(d.spend).toBeCloseTo(61_800, CENT);
  });

  it("ST-11 income covers everything at the start: 50,000.00; 51,500.00 with a = 0.873786; 52,413.93", () => {
    // Planned core 50,000, income 60,000, P = 500,000: planDraw 0, C = 50,000. After −24% with 3%
    // (P = 380,000): ρ = 515,000 ÷ 380,000 = 1.355263, freeze to 1.315789, cut: a = 0.873786;
    // planDraw = max(0, 51,500 − 61,800) = 0, so C = 51,500. Later (planned core 53,045, income
    // 48,045, P = 400,000): ρ = 0.873786 × 530,450 ÷ 400,000 = 1.158750, no rule;
    // C = 53,045 − 0.126214 × 5,000 = 52,413.93.
    const tb = guardrails(50_000);
    const state = new Float64Array(STRATEGY_STATE_LENGTH);
    expect(decide(tb, state, { t: 0, cpi: 1, portfolioStart: 500_000, guaranteedIncome: 60_000 }).spend).toBeCloseTo(50_000, CENT);
    expect(rhoBefore(state, 1.03, 380_000)).toBeCloseTo(1.355263, SIX);
    const d1 = decide(tb, state, { t: 1, cpi: 1.03, portfolioStart: 380_000, guaranteedIncome: 61_800, prevInflation: 0.03, prevPortfolioReturn: -0.24 });
    expect(d1.rule).toBe(RULE.FREEZE | RULE.CUT);
    expect(state[SLOT.ADJUST]).toBeCloseTo(0.873786, SIX);
    expect(d1.spend).toBeCloseTo(51_500, CENT);
    expect(rhoBefore(state, level(1.03, 2), 400_000)).toBeCloseTo(1.15875, SIX);
    const d2 = decide(tb, state, { t: 2, cpi: level(1.03, 2), portfolioStart: 400_000, guaranteedIncome: 48_045, prevInflation: 0.03, prevPortfolioReturn: 400_000 / 380_000 - 1 });
    expect(d2.rule).toBe(0);
    expect(d2.spend).toBeCloseTo(52_413.93, CENT);
  });
});

describe("ST-12 and ST-13 the limits", () => {
  it("ST-12 held at essentials: a = 0.5, planned core 50,000, essential core 40,000, no income → C = 40,000.00, flag essentials", () => {
    // ρ = 0.5 × 1,000,000 × 1 ÷ 500,000 = 1 (no rule); C = 50,000 − 0.5 × 50,000 = 25,000 < 40,000.
    const tb = guardrails(50_000, { essentialDollars: 40_000 });
    const state = new Float64Array(STRATEGY_STATE_LENGTH);
    state[SLOT.STARTED] = 1;
    state[SLOT.X0] = 1_000_000;
    state[SLOT.ADJUST] = 0.5;
    const d = decide(tb, state, { t: 0, cpi: 1, portfolioStart: 500_000, prevInflation: 0.03, prevPortfolioReturn: 0.05 });
    expect(d.rule).toBe(RULE.ESSENTIALS);
    expect(d.spend).toBeCloseTo(40_000, CENT);
    expect(state[SLOT.ADJUST]).toBe(0.5);
  });

  it("ST-13 empty portfolio: started, P = 0 → no rule, a unchanged, C = planned core", () => {
    const tb = guardrails(50_000);
    const state = new Float64Array(STRATEGY_STATE_LENGTH);
    decide(tb, state, { t: 0, cpi: 1, portfolioStart: 1_000_000 });
    const d = decide(tb, state, { t: 1, cpi: 1.03, portfolioStart: 0, prevInflation: 0.03, prevPortfolioReturn: -0.5 });
    expect(d.rule).toBe(0);
    expect(state[SLOT.ADJUST]).toBe(1);
    expect(d.spend).toBeCloseTo(51_500, CENT);
    // With a below 1 the factor is kept as it is: C = 51,500 − (1 − 0.8) × 51,500 = 41,200 (no income).
    state[SLOT.ADJUST] = 0.8;
    const e = decide(tb, state, { t: 1, cpi: 1.03, portfolioStart: 0, prevInflation: 0.03, prevPortfolioReturn: -0.5 });
    expect(e.rule).toBe(0);
    expect(state[SLOT.ADJUST]).toBe(0.8);
    expect(e.spend).toBeCloseTo(41_200, CENT);
  });

  it("ST-13 a rule that never sees a positive P never starts, and spending is the plan", () => {
    const tb = guardrails(50_000);
    const state = new Float64Array(STRATEGY_STATE_LENGTH);
    for (let t = 0; t < 3; t++) {
      const d = decide(tb, state, { t, cpi: level(1.03, t), portfolioStart: 0, guaranteedIncome: 10_000, prevInflation: 0.03, prevPortfolioReturn: -0.1 });
      expect(state[SLOT.STARTED]).toBe(0);
      expect(d.rule).toBe(0);
      expect(d.spend).toBeCloseTo(50_000 * level(1.03, t), 9);
    }
  });

  it("yearsRemaining counts the longer-lived horizon of the living people", () => {
    // A couple born 1947 and 1960 (horizons 2042 and 2055): 28 years remain in 2028, so ST-5's
    // freeze is followed by the cut; once only the first is alive, 15 remain and the cut is skipped.
    const tb = guardrails(50_000, { people: [{ birthYear: 1947 }, { birthYear: 1960 }] });
    const both = Float64Array.from({ length: STRATEGY_STATE_LENGTH }, (_, i) => (i === SLOT.STARTED ? 1 : i === SLOT.X0 ? 1_000_000 : i === SLOT.ADJUST ? 1 : 0));
    const one = Float64Array.from(both);
    const view = { t: 1, cpi: 1.03, portfolioStart: 807_500, prevInflation: 0.03, prevPortfolioReturn: -0.15 };
    expect(decide(tb, both, view).rule).toBe(RULE.FREEZE | RULE.CUT);
    expect(decide(tb, one, { ...view, alive: [1, 0] }).rule).toBe(RULE.FREEZE);
  });
});
