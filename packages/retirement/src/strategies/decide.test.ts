import type { StrategyConfigInput } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { buildSimInput, type SimInputOptions } from "../testing/simInput.js";
import { decideSpending } from "./decide.js";
import { prepareStrategies, type StrategyTables } from "./prepare.js";
import { level, testView, type TestViewFields } from "./testKit.js";
import { RULE, SLOT, STRATEGY_STATE_LENGTH, createSpendDecision } from "./types.js";

// Build step 18: the spending hook (strategies-outputs-web §3.3 and §3.4; ST-3, ST-14 to ST-16;
// seams C35, C40). Dollars within 0.005; percentages to four decimals of a percent.

const CENT = 2;

function tables(strategy: StrategyConfigInput, o: SimInputOptions = {}): StrategyTables {
  return prepareStrategies(buildSimInput({ ...o, strategy }));
}

function decide(tb: StrategyTables, fields: TestViewFields, state = new Float64Array(STRATEGY_STATE_LENGTH)) {
  const out = createSpendDecision();
  decideSpending(testView(tb, fields), state, out);
  return out;
}

describe("constant_dollar", () => {
  it("§3.4 (a) planned core 96,000 at cpi 1.025, no healthcare: spend = floor = 98,400.00", () => {
    const tb = tables({ kind: "constant_dollar" }, { spending: { baseAnnualCents: "9600000" } });
    const d = decide(tb, { t: 1, cpi: 1.025, portfolioStart: 1_000_000 });
    expect(d.spend).toBeCloseTo(98_400, CENT);
    expect(d.floor).toBe(d.spend);
    expect(d.planned).toBe(d.spend);
    expect(Number.isNaN(d.gross)).toBe(true);
    expect(d.rule).toBe(0);
  });
});

describe("ST-3 fixed percentage", () => {
  it("ST-3 4% of 1,234,567.89 = 49,382.72; with the reserve example of §3.2, 4% of 780,000 = 31,200.00", () => {
    // 0.04 × 1,234,567.89 = 49,382.7156. Reserve: P = 1,000,000 − 200,000 × 1.1 = 780,000 → 31,200.
    const tb = tables({ kind: "fixed_percentage" }, { spending: { baseAnnualCents: "5000000", essentialAnnualCents: "3000000" } });
    const d = decide(tb, { portfolioStart: 1_234_567.89 });
    expect(d.gross).toBeCloseTo(49_382.72, CENT);
    // A gross year: the floor is essential core + healthcare + long-term care (30,000 here).
    expect(d.spend).toBeCloseTo(30_000, CENT);
    expect(d.floor).toBe(d.spend);
    expect(d.planned).toBeCloseTo(50_000, CENT);
    const reserved = tables({ kind: "fixed_percentage" }, { spending: { longTermCare: [{ personId: "p1", reserveCents: "20000000", lastYears: 2 }] } });
    expect(decide(reserved, { t: 5, cpi: 1.1, portfolioStart: 1_000_000, yearsToDeath: [20] }).gross).toBeCloseTo(31_200, CENT);
  });

  it("ST-3 a care year releases the year's long-term care with the rule's withdrawal (gross = rate × P + L) and puts it in the floor", () => {
    // Reserve 200,000 over 2 years, death next year (d = 1): L = 200,000 × 1.1 ÷ 2 = 110,000; set
    // aside 220,000, P = 1,000,000 − 220,000 = 780,000; gross = 0.04 × 780,000 + 110,000 = 141,200;
    // floor = essential 0 + L = 110,000.
    const tb = tables({ kind: "fixed_percentage" }, { spending: { longTermCare: [{ personId: "p1", reserveCents: "20000000", lastYears: 2 }] } });
    const d = decide(tb, { t: 5, cpi: 1.1, portfolioStart: 1_000_000, yearsToDeath: [1] });
    expect(d.gross).toBeCloseTo(141_200, CENT);
    expect(d.spend).toBeCloseTo(110_000, CENT);
    expect(d.planned).toBeCloseTo(110_000, CENT);
  });
});

describe("ST-14 VPW values", () => {
  // n = max(1, 99 + 1 − age); g = s × 5.0% + (1 − s) × 1.9%; pct = g ÷ (1 − (1 + g)^−n) ÷ (1 + g).
  // Every row re-derived with 60-digit decimals (scratchpad p4-trades/deriv.py).
  const rows: Array<{ ages: number[]; share: number; pct: number; cap?: boolean; zero?: boolean }> = [
    { ages: [60], share: 0.5, pct: 4.4915 },
    { ages: [62], share: 0.5, pct: 4.6036 },
    { ages: [65], share: 0.5, pct: 4.7991 },
    { ages: [65], share: 0.6, pct: 4.9966 },
    { ages: [66], share: 0.6, pct: 5.0688 },
    { ages: [69], share: 0.6, pct: 5.3171 },
    { ages: [70], share: 0.6, pct: 5.4122 },
    { ages: [71], share: 0.6, pct: 5.5145 },
    { ages: [40], share: 0.4, pct: 3.609 },
    { ages: [65], share: 0.4, pct: 4.6049 },
    { ages: [75], share: 0.5, pct: 5.8333 },
    { ages: [88], share: 0.5, pct: 9.9739 },
    { ages: [89], share: 0.5, pct: 10, cap: true }, // raw 10.7094%
    { ages: [70, 64], share: 0.5, pct: 4.7299 },
  ];
  it.each(rows)("ST-14 ages $ages at $share stocks → $pct%", ({ ages, share, pct, cap }) => {
    const people = ages.map((age) => ({ birthYear: 2027 - age }));
    const tb = tables({ kind: "vpw" }, { people });
    const d = decide(tb, { age: ages, stockShare: share, portfolioStart: 1_000_000 });
    // gross = pct × P with P = 1,000,000: four decimals of a percent are 0.5 dollars here.
    expect(Math.abs(d.gross / 10_000 - pct)).toBeLessThan(0.00005);
    expect(d.rule).toBe(cap === true ? RULE.CAP : 0);
  });

  it("ST-14 any age with g = 0, n = 35: 1 ÷ 35 = 2.8571%", () => {
    const tb = tables({ kind: "vpw", stockRealBp: 0, bondRealBp: 0 }, { people: [{ birthYear: 1962 }] });
    const d = decide(tb, { age: [65], stockShare: 0.6, portfolioStart: 1_000_000 });
    expect(d.gross / 10_000).toBeCloseTo(2.8571, 4);
  });

  it("ST-14 the younger living person: after the younger spouse dies the older one's age sets n", () => {
    // Ages 70 and 64 at 50%: 4.7299%; with only the 70-year-old alive, n = 30 at 50% stocks.
    const tb = tables({ kind: "vpw" }, { people: [{ birthYear: 1957 }, { birthYear: 1963 }] });
    const both = decide(tb, { age: [70, 64], stockShare: 0.5, portfolioStart: 1_000_000 });
    const widow = decide(tb, { age: [70, 64], alive: [1, 0], stockShare: 0.5, portfolioStart: 1_000_000 });
    expect(both.gross / 10_000).toBeCloseTo(4.7299, 4);
    // g = 0.5 × 5% + 0.5 × 1.9% = 3.45%, n = 100 − 70 = 30: 0.0345 ÷ (1 − 1.0345^−30) ÷ 1.0345
    // = 5.222935% (50-digit decimals, scratchpad p4-trades).
    expect(widow.gross).toBeGreaterThan(both.gross);
    expect(widow.gross / 10_000).toBeCloseTo(5.2229, 4);
  });
});

describe("ST-15 floor and ceiling", () => {
  // Planned discretionary 45,000 in today's dollars, no essentials, P = 1,000,000 in the start
  // year (derived rate 4.5%), band 15% below and 20% above:
  // | P         | cpi      | raw       | lo        | hi        | D         | rule    |
  // | 1,000,000 | 1        | 45,000.00 | 38,250.00 | 54,000.00 | 45,000.00 | none    |
  // | 800,000   | 1.03     | 36,000.00 | 39,397.50 | 55,620.00 | 39,397.50 | floor   |
  // | 1,500,000 | 1.0609   | 67,500.00 | 40,579.43 | 57,288.60 | 57,288.60 | ceiling |
  // | 1,100,000 | 1.092727 | 49,500.00 | 41,796.81 | 59,007.26 | 49,500.00 | none    |
  const years = [
    { P: 1_000_000, D: 45_000, rule: 0 },
    { P: 800_000, D: 39_397.5, rule: RULE.BAND_FLOOR },
    { P: 1_500_000, D: 57_288.6, rule: RULE.BAND_CEILING },
    { P: 1_100_000, D: 49_500, rule: 0 },
  ];

  it("ST-15 the table of §3.4 (e): 45,000.00; 39,397.50 (floor); 57,288.60 (ceiling); 49,500.00", () => {
    const tb = tables({ kind: "floor_ceiling" }, { spending: { baseAnnualCents: "4500000" } });
    const state = new Float64Array(STRATEGY_STATE_LENGTH);
    years.forEach(({ P, D, rule }, t) => {
      const d = decide(tb, { t, cpi: level(1.03, t), portfolioStart: P }, state);
      expect(d.spend).toBeCloseTo(D, CENT);
      expect(d.floor).toBe(d.spend);
      expect(d.rule).toBe(rule);
    });
    expect(state[SLOT.STARTED]).toBe(1);
    expect(state[SLOT.FC_RATE]).toBeCloseTo(0.045, 15);
  });

  it("ST-15 with essentials of 50,000 beside the same 45,000 (planned core 95,000), the second row gives C = 90,897.50", () => {
    // E = 50,000 × 1.03 = 51,500; C = 51,500 + 39,397.50 = 90,897.50.
    const tb = tables({ kind: "floor_ceiling" }, { spending: { baseAnnualCents: "9500000", essentialAnnualCents: "5000000" } });
    const state = new Float64Array(STRATEGY_STATE_LENGTH);
    expect(decide(tb, { t: 0, cpi: 1, portfolioStart: 1_000_000 }, state).spend).toBeCloseTo(95_000, CENT);
    const d = decide(tb, { t: 1, cpi: 1.03, portfolioStart: 800_000 }, state);
    expect(d.spend).toBeCloseTo(90_897.5, CENT);
    expect(d.rule).toBe(RULE.BAND_FLOOR);
  });

  it("ST-15 with rateBp 400 given: the first year is 40,000.00", () => {
    // raw = 0.04 × 1,000,000 = 40,000 inside [38,250, 54,000].
    const tb = tables({ kind: "floor_ceiling", rateBp: 400 }, { spending: { baseAnnualCents: "4500000" } });
    const d = decide(tb, { t: 0, cpi: 1, portfolioStart: 1_000_000 });
    expect(d.spend).toBeCloseTo(40_000, CENT);
    expect(d.rule).toBe(0);
  });

  it("ST-15 a start year with P = 0 derives the percentage 0, so spending sits at the band's floor", () => {
    // rate 0: raw 0 < lo = 0.85 × 45,000 = 38,250.
    const tb = tables({ kind: "floor_ceiling" }, { spending: { baseAnnualCents: "4500000" } });
    const state = new Float64Array(STRATEGY_STATE_LENGTH);
    const d = decide(tb, { t: 0, cpi: 1, portfolioStart: 0 }, state);
    expect(state[SLOT.FC_RATE]).toBe(0);
    expect(d.spend).toBeCloseTo(38_250, CENT);
    expect(d.rule).toBe(RULE.BAND_FLOOR);
  });
});

describe("ST-16 phases", () => {
  // A couple: p1 retired, p2 still working in 2027 (retires 2028-07); plan and drawdown from 2027.
  const couple: SimInputOptions = {
    people: [{ birthYear: 1960 }, { birthYear: 1965, retirementMonth: "2028-07" }],
    spending: { baseAnnualCents: "6000000", essentialAnnualCents: "4000000" },
  };
  const kinds: StrategyConfigInput[] = [
    { kind: "constant_dollar" },
    { kind: "fixed_percentage" },
    { kind: "guardrails" },
    { kind: "vpw" },
    { kind: "floor_ceiling" },
  ];

  it("ST-16 transition returns the constant decision for all five kinds and leaves the state untouched", () => {
    for (const kind of kinds) {
      const tb = tables(kind, couple);
      const state = new Float64Array(STRATEGY_STATE_LENGTH);
      const d = decide(tb, { t: 0, cpi: 1, retired: [1, 0], portfolioStart: 1_500_000, wages: 80_000 }, state);
      expect(d.spend).toBeCloseTo(60_000, CENT);
      expect(d.floor).toBe(d.spend);
      expect(d.planned).toBe(d.spend);
      expect(Number.isNaN(d.gross)).toBe(true);
      expect(d.rule).toBe(0);
      expect(Array.from(state)).toEqual(Array(STRATEGY_STATE_LENGTH).fill(0));
    }
  });

  it("ST-16 guardrails and floor-and-ceiling start in the first retirement-phase year", () => {
    for (const kind of [{ kind: "guardrails" }, { kind: "floor_ceiling" }] as const) {
      const tb = tables(kind, couple);
      const state = new Float64Array(STRATEGY_STATE_LENGTH);
      decide(tb, { t: 0, cpi: 1, retired: [1, 0], portfolioStart: 1_500_000 }, state);
      expect(state[SLOT.STARTED]).toBe(0);
      const d = decide(tb, { t: 1, cpi: 1.03, retired: [1, 1], portfolioStart: 1_400_000, prevInflation: 0.03, prevPortfolioReturn: -0.1 }, state);
      expect(state[SLOT.STARTED]).toBe(1);
      // The start year spends the plan: 60,000 × 1.03 = 61,800, no rule.
      expect(d.spend).toBeCloseTo(61_800, CENT);
      expect(d.rule).toBe(0);
      if (kind.kind === "guardrails") expect(state[SLOT.X0]).toBeCloseTo(1_400_000 / 1.03, 6);
      // Floor and ceiling: discretionary 20,000 × 1.03 = 20,600 over P 1,400,000.
      else expect(state[SLOT.FC_RATE]).toBeCloseTo(20_600 / 1_400_000, 15);
    }
  });

  it("ST-16 a person who has died does not hold the household in transition", () => {
    // p2 still working but dead: every living person is retired, so the chosen rule applies.
    const tb = tables({ kind: "fixed_percentage" }, couple);
    const d = decide(tb, { t: 0, retired: [1, 0], alive: [1, 0], portfolioStart: 1_000_000 });
    expect(d.gross).toBeCloseTo(40_000, CENT);
  });

  it("ST-16 accumulation returns spend = floor = 0 with the goal as lump", () => {
    // Drawdown from plan year 2; a goal of 20,000 today in 2028 at cpi 1.03: lump 20,600.
    const tb = tables(
      { kind: "guardrails" },
      {
        people: [{ birthYear: 1965, retirementMonth: "2029-01" }],
        spending: {
          baseAnnualCents: "6000000",
          startMonth: "2029-01",
          goals: [{ id: "roof", name: "roof", year: 2028, amountCents: "2000000", dollars: "today" }],
          healthcare: [{ personId: "p1", preMedicareAnnualCents: "500000", preMedicareFrom: "2027-01", medicareFrom: "2030-01", medicareAnnualCents: "0", realGrowthBp: 0, inBase: false }],
        },
      },
    );
    expect(tb.coreShare[1]).toBe(0);
    const state = new Float64Array(STRATEGY_STATE_LENGTH);
    const d = decide(tb, { t: 1, cpi: 1.03, phase: 0, retired: [0], drawdownStart: 2, portfolioStart: 900_000 }, state);
    expect(d.spend).toBe(0);
    expect(d.floor).toBe(0);
    expect(d.lump).toBeCloseTo(20_600, CENT);
    expect(d.lumpFloor).toBe(0);
    expect(d.healthcare).toBe(0);
    expect(d.planned).toBe(0);
    expect(Number.isNaN(d.gross)).toBe(true);
    expect(Array.from(state)).toEqual(Array(STRATEGY_STATE_LENGTH).fill(0));
  });

  it("§3.3 every drawdown year: lump = lumpFloor = goals, healthcare = the HSA cap, planned = core + healthcare + care", () => {
    const tb = tables(
      { kind: "vpw" },
      {
        spending: {
          baseAnnualCents: "6000000",
          essentialAnnualCents: "3000000",
          goals: [{ id: "car", name: "car", year: 2027, amountCents: "1000000", dollars: "nominal" }],
          healthcare: [{ personId: "p1", preMedicareAnnualCents: "0", preMedicareFrom: "2027-01", medicareFrom: "2027-01", medicareAnnualCents: "700000", realGrowthBp: 0, inBase: false }],
        },
      },
    );
    const d = decide(tb, { age: [65], stockShare: 0.6, portfolioStart: 1_000_000 });
    expect(d.lump).toBe(10_000);
    expect(d.lumpFloor).toBe(10_000);
    expect(d.healthcare).toBe(7_000);
    expect(d.planned).toBe(67_000);
    // A gross year's floor: essential 30,000 + healthcare 7,000.
    expect(d.spend).toBe(37_000);
    // 4.9966% × 1,000,000 (the healthcare and the goal are not part of the rule's percentage).
    expect(d.gross / 10_000).toBeCloseTo(4.9966, 4);
  });
});

describe("C35 healthcare included in base", () => {
  it("C35 included in base: spending does not add it, the HSA cap is the entered amount; not included: both", () => {
    const entry = (inBase: boolean) => ({
      personId: "p1" as const,
      preMedicareAnnualCents: "0",
      preMedicareFrom: "2027-01",
      medicareFrom: "2027-01",
      medicareAnnualCents: "600000",
      realGrowthBp: 0,
      inBase,
    });
    for (const inBase of [true, false]) {
      const tb = tables({ kind: "constant_dollar" }, { spending: { baseAnnualCents: "4000000", healthcare: [entry(inBase)] } });
      const d = decide(tb, { t: 1, cpi: 1.02, portfolioStart: 500_000 });
      expect(d.healthcare).toBeCloseTo(6_120, 9);
      expect(d.spend).toBeCloseTo(inBase ? 40_800 : 46_920, 9);
      expect(d.planned).toBe(d.spend);
    }
  });
});
