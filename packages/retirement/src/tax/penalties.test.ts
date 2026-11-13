import { describe, expect, it } from "vitest";
import { monthIndex, periodMonths, periodStart, planClock } from "../clock.js";
import { HW, HW_REC, TO } from "./layout.js";
import {
  MONTHS_59_HALF,
  MONTHS_65,
  birthMonthIndex,
  earlyFraction,
  earlyFractionBefore59Half,
  earlyFractionBefore65,
  hsaPenaltyShare,
  hsaWithdraw,
  isEmployerPlan,
  preTaxPenaltyBase,
  preTaxPenaltyShare,
  separatedAt55,
} from "./penalties.js";
import { loadTaxData } from "./taxData.js";
import { pathTables, taxInput, taxOn, type TaxInputName } from "./testKit.js";

// tax-rmd-ss §3.7.1, §3.7.2, §3.7.4 and tests E1, E2, E3, E9 (§7); the penalty shares of seams C33;
// HC-T16 of strategies-outputs-web §7.5 with its bases derived here. Dollar values with cents are
// asserted within 0.005 and fractions to 1e-12 (tax-rmd-ss decision 50: exact fractions to 1e-6).

const published = pathTables(loadTaxData(), { startYear: 2026, years: 2 });
const S = 0;

const near = (actual: number, expected: number, label = "") =>
  expect(Math.abs(actual - expected), `${label} ${actual} vs ${expected}`).toBeLessThanOrEqual(0.005);
const frac = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12);

function tax(year: 2026 | 2027, status: 0 | 1, fields: Partial<Record<TaxInputName, number>>): Float64Array {
  return taxOn(published, year, status, taxInput(fields));
}

/** The 12-month period of a calendar year: [the month number of its January, 12]. */
const year = (y: number) => [monthIndex(`${y}-01`), 12] as const;

/** A plan whose first year is November and December 2026 (firstYearMonths 2). */
const novemberStart = planClock({ startYear: 2026, startMonth: "2026-11", firstYearMonths: 2, endYear: 2040, stepsPerYear: 1, currency: "USD" });

describe("the month numbers (tax-rmd-ss §3.1, clock.ts)", () => {
  it("birth months, the ages in months and the plan clock's periods share one numbering", () => {
    // 2026 × 12 + 6 = 24,318 for July 2026 (§3.7.1's example), in both spellings.
    expect(monthIndex("2026-07")).toBe(24318);
    expect(birthMonthIndex(2026, 7)).toBe(24318);
    expect(MONTHS_59_HALF).toBe(59 * 12 + 6);
    expect(MONTHS_65).toBe(65 * 12);
    // A person born in January 1967 is 59½ in July 2026.
    expect(birthMonthIndex(1967, 1) + MONTHS_59_HALF).toBe(monthIndex("2026-07"));
    // The first year of November and December 2026 starts at 2026 × 12 + 10 = 24,322.
    expect(periodStart(novemberStart, 0)).toBe(24322);
    expect(periodMonths(novemberStart, 0)).toBe(2);
    expect(periodStart(novemberStart, 3)).toBe(monthIndex("2029-01"));
  });
});

describe("E2 earlyFraction (§3.7.1)", () => {
  it("E2 born January 1967 (59½ in July 2026, index 24,318): 1 for 2025, 0.5 for 2026, 0 for 2027", () => {
    const birth = birthMonthIndex(1967, 1);
    expect(birth + MONTHS_59_HALF).toBe(24318);
    // (24,318 − 24,300) / 12 = 1.5 → 1; (24,318 − 24,312) / 12 = 0.5; (24,318 − 24,324) / 12 < 0 → 0.
    expect(earlyFractionBefore59Half(birth, ...year(2025))).toBe(1);
    expect(earlyFractionBefore59Half(birth, ...year(2026))).toBe(0.5);
    expect(earlyFractionBefore59Half(birth, ...year(2027))).toBe(0);
  });

  it("E2 born September 1967 (59½ in March 2027): 2/12 for 2027", () => {
    // 1967 × 12 + 8 + 714 = 24,326 = March 2027; (24,326 − 24,324) / 12 = 2/12.
    const birth = birthMonthIndex(1967, 9);
    expect(birth + MONTHS_59_HALF).toBe(monthIndex("2027-03"));
    frac(earlyFractionBefore59Half(birth, ...year(2027)), 2 / 12);
  });

  it("E2 a first year of November and December 2026: born June 1967 gives 0.5, born March 1967 gives 0", () => {
    const start = periodStart(novemberStart, 0);
    const months = periodMonths(novemberStart, 0);
    // June 1967 + 714 months = December 2026 (24,323): (24,323 − 24,322) / 2 = 0.5.
    expect(earlyFractionBefore59Half(birthMonthIndex(1967, 6), start, months)).toBe(0.5);
    // March 1967 + 714 = September 2026 (24,320), before the period: 0.
    expect(earlyFractionBefore59Half(birthMonthIndex(1967, 3), start, months)).toBe(0);
  });

  it("E2 HSA: born July 1961 (65 in July 2026) gives 0.5 for 2026", () => {
    // 1961 × 12 + 6 + 780 = 24,318 = July 2026.
    expect(earlyFractionBefore65(birthMonthIndex(1961, 7), ...year(2026))).toBe(0.5);
    expect(earlyFractionBefore65(birthMonthIndex(1961, 7), ...year(2025))).toBe(1);
    expect(earlyFractionBefore65(birthMonthIndex(1961, 7), ...year(2027))).toBe(0);
  });

  it("E2 the threshold month itself is not early; a degenerate period is a step", () => {
    // The age is reached at the start of its month: a period starting in that month has fraction 0.
    expect(earlyFraction(24318, 24318, 12)).toBe(0);
    expect(earlyFraction(24319, 24318, 12)).toBe(1 / 12);
    expect(earlyFraction(24330, 24318, 12)).toBe(1);
    expect(earlyFraction(24319, 24318, 0)).toBe(1);
    expect(earlyFraction(24318, 24318, 0)).toBe(0);
  });
});

describe("E1 an early pre-tax withdrawal (§3.7.2)", () => {
  // Single, 55 all year, 2026: born June 1971, so 59½ is December 2030 and 2026 is wholly early.
  const birthYear = 1971;
  const early = earlyFractionBefore59Half(birthMonthIndex(birthYear, 6), ...year(2026));

  it("E1 from an IRA: AGI 70,000; taxable 53,900; 6,570 + 10% × 20,000 = 8,570.00", () => {
    expect(early).toBe(1);
    const base = preTaxPenaltyBase(20000, early, isEmployerPlan("ira"), separatedAt55(birthYear, 2026, 2026));
    expect(base).toBe(20000);
    // 53,900 − 50,400 = 3,500 in the 22% bracket: 5,800 + 770 = 6,570.
    const r = tax(2026, S, { WAGES: 50000, TRAD_DIST: 20000, PEN10_BASE: base });
    near(r[TO.AGI]!, 70000);
    near(r[TO.TAXABLE_INCOME]!, 53900);
    near(r[TO.INCOME_TAX]!, 6570);
    near(r[TO.PEN10]!, 2000);
    near(r[TO.TOTAL]!, 8570.0);
  });

  it("E1 from a 401k after retiring in 2026 at 55: base 0, total 6,570.00", () => {
    expect(separatedAt55(birthYear, 2026, 2026)).toBe(true);
    const base = preTaxPenaltyBase(20000, early, isEmployerPlan("401k"), separatedAt55(birthYear, 2026, 2026));
    expect(base).toBe(0);
    near(tax(2026, S, { WAGES: 50000, TRAD_DIST: 20000, PEN10_BASE: base })[TO.TOTAL]!, 6570.0);
  });
});

describe("E3 separation at 55 (Form 5329 exception 01)", () => {
  // Born 1970; retirementMonth 2026-03 is in the year of 56 (1970 + 56). A 30,000 withdrawal in 2027
  // at 57: 59½ is in 2029 or 2030 whatever the birth month, so 2027 is wholly early.
  const early2027 = earlyFractionBefore59Half(birthMonthIndex(1970, 12), ...year(2027));

  it("E3 in 2027 at 57: a 401k's base is 0; an IRA's is 30,000 (additional tax 3,000)", () => {
    expect(early2027).toBe(1);
    const sep = separatedAt55(1970, 2026, 2027);
    expect(sep).toBe(true);
    expect(preTaxPenaltyBase(30000, early2027, isEmployerPlan("401k"), sep)).toBe(0);
    const iraBase = preTaxPenaltyBase(30000, early2027, isEmployerPlan("ira"), sep);
    expect(iraBase).toBe(30000);
    near(tax(2027, S, { TRAD_DIST: 30000, PEN10_BASE: iraBase })[TO.PEN10]!, 3000.0);
  });

  it("E3 retired in 2023 at 53: the 401k base is 30,000", () => {
    // 2023 < 1970 + 55 = 2025: the separation came before the year of 55.
    expect(separatedAt55(1970, 2023, 2027)).toBe(false);
    expect(preTaxPenaltyBase(30000, early2027, true, separatedAt55(1970, 2023, 2027))).toBe(30000);
  });

  it("E3 a withdrawal in 2025, before retiring in 2026: base 30,000", () => {
    const early2025 = earlyFractionBefore59Half(birthMonthIndex(1970, 12), ...year(2025));
    expect(separatedAt55(1970, 2026, 2025)).toBe(false);
    expect(preTaxPenaltyBase(30000, early2025, true, separatedAt55(1970, 2026, 2025))).toBe(30000);
  });

  it("E3 retiring in the calendar year of 55 counts; only a 401k is an employer plan", () => {
    expect(separatedAt55(1970, 2025, 2025)).toBe(true);
    expect(separatedAt55(1970, 2024, 2025)).toBe(false);
    expect(isEmployerPlan("401k")).toBe(true);
    for (const t of ["ira", "roth", "hsa", "brokerage", undefined]) expect(isEmployerPlan(t)).toBe(false);
  });
});

describe("C33 the penalty shares", () => {
  it("C33 born September 1967, 2027: attained age 60, yet 2/12 of the year is early (tier 7, partial penalty)", () => {
    // The order's old test "under 60" would call this owner not early (2027 − 1967 = 60). The share is
    // (24,326 − 24,324) / 12 = 2/12, so 6,000 withdrawn from an IRA has a base of 1,000.
    const e = earlyFractionBefore59Half(birthMonthIndex(1967, 9), ...year(2027));
    frac(preTaxPenaltyShare(e, false, false), 2 / 12);
    near(preTaxPenaltyBase(6000, e, false, false), 1000);
    // A 401k after separation at 55 is penalty-free whatever the age (tier 4).
    expect(preTaxPenaltyShare(e, true, separatedAt55(1967, 2023, 2027))).toBe(0);
    expect(preTaxPenaltyShare(1, true, true)).toBe(0);
    // The share is the base per dollar.
    for (const amount of [1, 2500, 16737.5]) expect(preTaxPenaltyBase(amount, e, false, false)).toBe(amount * preTaxPenaltyShare(e, false, false));
    expect(preTaxPenaltyBase(0, 1, false, false)).toBe(0);
    expect(preTaxPenaltyBase(-10, 1, false, false)).toBe(0);
  });

  it("C33 the HSA share is the early fraction before 65: born July 1961 gives 0.5 in 2026", () => {
    const e65 = earlyFractionBefore65(birthMonthIndex(1961, 7), ...year(2026));
    expect(hsaPenaltyShare(e65)).toBe(0.5);
    expect(hsaPenaltyShare(earlyFractionBefore65(birthMonthIndex(1961, 7), ...year(2027)))).toBe(0);
  });
});

describe("E9 HSA withdrawals (§3.7.4)", () => {
  const out = new Float64Array(HW_REC);

  it("E9 10,000 with 6,000 of qualified medical at 60, single 2026, wages 50,000: 4,300 + 800 = 5,100.00", () => {
    hsaWithdraw(10000, 6000, 1, out);
    expect(out[HW.TAXABLE]).toBe(4000);
    expect(out[HW.PENALTY_BASE]).toBe(4000);
    // AGI 54,000; taxable 37,900; 1,240 + 12% × 25,500 = 4,300; 20% × 4,000 = 800.
    const r = tax(2026, S, { WAGES: 50000, HSA_TAXABLE: out[HW.TAXABLE]!, PEN20_BASE: out[HW.PENALTY_BASE]! });
    near(r[TO.AGI]!, 54000);
    near(r[TO.TAXABLE_INCOME]!, 37900);
    near(r[TO.INCOME_TAX]!, 4300);
    near(r[TO.PEN20]!, 800);
    near(r[TO.TOTAL]!, 5100.0);
  });

  it("E9 at 66 with pension 50,000: standard 18,150, senior 6,000, taxable 29,850; 3,334.00, no additional tax", () => {
    hsaWithdraw(10000, 6000, 0, out);
    expect(out[HW.TAXABLE]).toBe(4000);
    expect(out[HW.PENALTY_BASE]).toBe(0);
    // 54,000 − 18,150 − 6,000 = 29,850; 1,240 + 12% × 17,450 = 3,334.
    const r = tax(2026, S, { PENSION: 50000, HSA_TAXABLE: out[HW.TAXABLE]!, PEN20_BASE: out[HW.PENALTY_BASE]!, N_AGED: 1 });
    near(r[TO.STD_DEDUCTION]!, 18150);
    near(r[TO.SENIOR_DEDUCTION]!, 6000);
    near(r[TO.TAXABLE_INCOME]!, 29850);
    near(r[TO.PEN20]!, 0);
    near(r[TO.TOTAL]!, 3334.0);
  });

  it("E9 in the year of turning 65 in July (earlyFrac65 0.5): base 2,000", () => {
    hsaWithdraw(10000, 6000, earlyFractionBefore65(birthMonthIndex(1961, 7), ...year(2026)), out);
    expect(out[HW.TAXABLE]).toBe(4000);
    expect(out[HW.PENALTY_BASE]).toBe(2000);
  });

  it("E9 a withdrawal within the qualified spending is not taxable", () => {
    hsaWithdraw(6000, 6000, 1, out);
    expect([out[HW.TAXABLE], out[HW.PENALTY_BASE]]).toEqual([0, 0]);
    hsaWithdraw(2000, 6000, 1, out);
    expect([out[HW.TAXABLE], out[HW.PENALTY_BASE]]).toEqual([0, 0]);
  });
});

describe("HC-T16 the additional taxes, with the bases derived by penalties.ts", () => {
  it("HC-T16 pre-tax 16,737.50 at 50: 1,673.75; HSA non-medical 10,000 at 60: 2,000.00; 2027 single 57 with 50,000 early: 3,752.00 + 5,000.00", () => {
    // At 50 and at 57 all of the year is before 59½; at 60 all of it is before 65.
    const at50 = earlyFractionBefore59Half(birthMonthIndex(1976, 1), ...year(2026));
    const at57 = earlyFractionBefore59Half(birthMonthIndex(1970, 1), ...year(2027));
    const at60 = earlyFractionBefore65(birthMonthIndex(1966, 1), ...year(2026));
    expect([at50, at57, at60]).toEqual([1, 1, 1]);
    const base10 = preTaxPenaltyBase(16737.5, at50, false, false);
    near(tax(2026, S, { TRAD_DIST: 16737.5, PEN10_BASE: base10 })[TO.PEN10]!, 1673.75);
    const out = new Float64Array(HW_REC);
    hsaWithdraw(10000, 0, at60, out);
    near(tax(2026, S, { HSA_TAXABLE: out[HW.TAXABLE]!, PEN20_BASE: out[HW.PENALTY_BASE]! })[TO.PEN20]!, 2000.0);
    // Taxable 50,000 − 16,600 = 33,400; 1,280 + 12% × 20,600 = 3,752.00; plus 10% × 50,000.
    const r = tax(2027, S, { TRAD_DIST: 50000, PEN10_BASE: preTaxPenaltyBase(50000, at57, false, false) });
    near(r[TO.INCOME_TAX]!, 3752.0);
    near(r[TO.PEN10]!, 5000.0);
    near(r[TO.TOTAL]!, 8752.0);
  });
});
