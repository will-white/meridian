import { describe, expect, it } from "vitest";
import { createTradeResult, planTrades, TRADE_FULL } from "../trades.js";
import { iraLimit } from "./contributionLimits.js";
import { assertTaxInput, TaxInputError } from "./federalTax.js";
import { HW, HW_REC, progOffset, RB, RB_REC, RW, RW_REC, SO, SO_REC, SS_REC, TI, TO } from "./layout.js";
import { NOT_MODELLED, type NotModelledId } from "./notModelled.js";
import { employeePayrollTax } from "./payroll.js";
import { earlyFractionBefore59Half, birthMonthIndex, hsaWithdraw, preTaxPenaltyBase, separatedAt55 } from "./penalties.js";
import { firstRmdYear, requiredMinimumDistribution, rmdStartAge } from "./rmd.js";
import { addRothContribution, addRothConversion, rothRollYear, rothWithdraw, seedRoth } from "./rothBasis.js";
import { compileSsPlan, monthlyPayment, resetSsState, socialSecurityYear, type SsPersonInput } from "./socialSecurity.js";
import { loadTaxData } from "./taxData.js";
import { pathTables, taxInput, taxOn } from "./testKit.js";

// Test K8 (tax-rmd-ss §7 K, §8.2): one assertion per not-modelled entry, named after its id, through
// the case the design names. Where the design's pin is a case that is no longer built, the pin is
// the case that now carries the rule: short_term_sales and wash_sales_lots pin the engine's trades
// (T23's account; seams C17 replaces F2), and qcd pins D7's RMD inside the tax (G7 runs through the
// loop, step 17). loss_step_down (C19) and rebalance_lag (C17) are no longer entries. Dollar values
// with cents within 0.005; exact values with toBe.

const data = loadTaxData();
const t = pathTables(data, { startYear: 2026, years: 2 });
const S = 0;
const J = 1;
const INF = Number.POSITIVE_INFINITY;
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(0.005);
const tax = (year: number, status: 0 | 1, fields: Parameters<typeof taxInput>[0]) => taxOn(t, year, status, taxInput(fields));
const mo = (year: number, month: number) => year * 12 + month - 1;
const est = (birthYear: number, birthMonth: number, pia: number, claimAgeMonths: number, asOfYear = 2026): SsPersonInput => ({
  mode: "estimate",
  birthYear,
  birthMonth,
  monthlyAtFra: pia,
  asOfYear,
  claimAgeMonths,
});
function ssHousehold(people: SsPersonInput[], startYear = 2026) {
  const plan = compileSsPlan(people, { spousal: true, survivor: true, startYear });
  const st = new Float64Array(SS_REC);
  resetSsState(plan, st);
  return { plan, st };
}
/** One calendar year of benefits on the program table of 2026 (COLA 0), as the H cases read it. */
function ssYear(h: ReturnType<typeof ssHousehold>, year: number, wages0 = 0): Float64Array {
  const p = pathTables(data, { startYear: year, years: 1 }).prog;
  p[progOffset(0)] = 0;
  const out = new Float64Array(SO_REC);
  socialSecurityYear(h.plan, h.st, year, year * 12, 12, p, progOffset(0), INF, INF, wages0, 0, out);
  return out;
}

const PINS: Record<NotModelledId, () => void> = {
  tax_table_rounding: () => {
    // B1: single, 40, 2026, wages 100,000: 5,800 + 22% × 33,500 = 13,170.00 exactly, from the rate schedule.
    expect(tax(2026, S, { WAGES: 100000 })[TO.TOTAL]).toBe(13170);
  },
  itemized_deductions: () => {
    // B5: joint, both 67, 2026, pension 60,000 and pre-tax 30,000: AGI 90,000 − standard 35,500 − senior
    // 12,000 = 42,500; 4,604.00. The input record has no itemized-deduction slot.
    const r = tax(2026, J, { PENSION: 60000, TRAD_DIST: 30000, N_AGED: 2 });
    expect([r[TO.AGI], r[TO.STD_DEDUCTION], r[TO.SENIOR_DEDUCTION], r[TO.TAXABLE_INCOME]]).toEqual([90000, 35500, 12000, 42500]);
    near(r[TO.TOTAL]!, 4604);
    expect(Object.keys(TI).some((k) => /ITEMIZ/.test(k))).toBe(false);
  },
  amt: () => {
    // D2: joint, both 50, 2026, wages 532,200, gain 200,000: income tax 147,227 + NIIT 7,600 = 154,827.00, no AMT term.
    const r = tax(2026, J, { WAGES: 532200, LT_GAIN: 200000 });
    near(r[TO.INCOME_TAX]!, 147227);
    near(r[TO.NIIT]!, 7600);
    near(r[TO.TOTAL]!, 154827);
    expect(r[TO.TOTAL]).toBe(r[TO.INCOME_TAX]! + r[TO.NIIT]! + r[TO.PEN10]! + r[TO.PEN20]!);
  },
  credits: () => {
    // B9: single, 2026, wages 10,000: taxable income 0, tax 0 (never negative), 6,100 of the deduction unused.
    const r = tax(2026, S, { WAGES: 10000 });
    expect(r[TO.TOTAL]).toBe(0);
    expect(r[TO.UNUSED_DEDUCTION]).toBe(6100);
  },
  other_deductions: () => {
    // B6(a): single, 70, pension 100,000: standard 16,100 + 2,050 = 18,150 only; senior 4,500; 11,729.00.
    const r = tax(2026, S, { PENSION: 100000, N_AGED: 1 });
    expect(r[TO.STD_DEDUCTION]).toBe(18150);
    near(r[TO.SENIOR_DEDUCTION]!, 4500);
    near(r[TO.TOTAL]!, 11729);
  },
  special_gain_rates: () => {
    // D5(c): single, 2026, wages 500,000, gain 100,000: 61,600 at 15% and 38,400 at 20% only:
    // capital-gains tax 9,240 + 7,680 = 16,920; total 158,854.25.
    const r = tax(2026, S, { WAGES: 500000, LT_GAIN: 100000 });
    near(r[TO.PREF_AT_15]!, 61600);
    near(r[TO.PREF_AT_20]!, 38400);
    near(r[TO.CG_TAX]!, 16920);
    near(r[TO.TOTAL]!, 158854.25);
  },
  loss_character: () => {
    // D6(b): single, 2026, wages 60,000, gain 5,000, carry-in 7,000 (long-term): net −2,000, used 2,000,
    // carried out 0; AGI 58,000; 4,780.00.
    const r = tax(2026, S, { WAGES: 60000, LT_GAIN: 5000, LOSS_CARRY_IN: 7000 });
    expect([r[TO.LOSS_USED], r[TO.LOSS_CARRY_OUT], r[TO.AGI]]).toEqual([2000, 0, 58000]);
    near(r[TO.TOTAL]!, 4780);
  },
  short_term_sales: () => {
    // The engine's trade has one realized gain, which assess puts in LT_GAIN (seams §2.6: ST_GAIN = 0).
    // T23's account: selling 130,000 of stock held at 700,000 with basis 300,000 realizes 74,285.71.
    const out = createTradeResult();
    planTrades(Float64Array.of(700000, 300000, 0), Float64Array.of(300000, 290000, 0), 0, Float64Array.of(0.6, 0.4, 0), 0, 50000, TRADE_FULL, true, false, out);
    expect(Object.keys(out)).toEqual(["realizedGain", "valueAfter", "sell", "buy", "post"]);
    near(out.realizedGain, 74285.71);
  },
  pretax_basis: () => {
    // E1: single, 55 all year, 2026, wages 50,000, IRA withdrawal 20,000: the full 20,000 is income;
    // AGI 70,000; 6,570 + 10% × 20,000 = 8,570.00.
    const base = preTaxPenaltyBase(20000, 1, false, false);
    const r = tax(2026, S, { WAGES: 50000, TRAD_DIST: 20000, PEN10_BASE: base });
    expect(r[TO.AGI]).toBe(70000);
    near(r[TO.TOTAL]!, 8570);
  },
  ira_deduction_limits: () => {
    // I3: the IRA limit at 50 is 8,600 whatever the household earns: the function takes no income.
    expect(iraLimit(t.prog, progOffset(0), 50, 1)).toBe(8600);
    expect(iraLimit.length).toBe(4);
  },
  penalty_exceptions: () => {
    // E3: born 1970, retired March 2026 (the year of 56); 30,000 in 2027 at 57: base 0 from a 401(k)
    // (exception 01, the one modelled), 30,000 from an IRA (no other exception applies).
    const sep = separatedAt55(1970, 2026, 2027);
    expect(sep).toBe(true);
    expect(preTaxPenaltyBase(30000, 1, true, sep)).toBe(0);
    expect(preTaxPenaltyBase(30000, 1, false, sep)).toBe(30000);
  },
  beneficiary_ira: () => {
    // G6: B (born 1958) owns the combined 900,000 from 1 January 2031 as her own (the spousal rollover):
    // 73 in 2031, 900,000 ÷ 26.5 = 33,962.26. A survivor under 59½ pays the 10% on an IRA withdrawal.
    near(requiredMinimumDistribution(900000, 2031 - 1958, rmdStartAge(1958), -1), 33962.26);
    const early = earlyFractionBefore59Half(birthMonthIndex(1980, 1), 2031 * 12, 12);
    expect(preTaxPenaltyBase(10000, early, false, false)).toBe(10000);
  },
  roth_401k_ordering: () => {
    // E5(d): 2027, age 50, BASIS_FREE 30,000, CONV0 20,000 (2023), CONV2 15,000 (2025); 60,000 out:
    // 30,000 from basis, 30,000 from conversions; taxable 0; base 30,000 (the IRA ordering for all Roth money).
    const st = new Float64Array(RB_REC);
    addRothContribution(st, 0, 30000, 2015);
    for (let y = 2023; y <= 2027; y++) {
      if (y > 2023) rothRollYear(st, 0);
      if (y === 2023) addRothConversion(st, 0, 20000, y);
      if (y === 2025) addRothConversion(st, 0, 15000, y);
    }
    const out = new Float64Array(RW_REC);
    rothWithdraw(st, 0, 60000, 1, 2027, out);
    expect([out[RW.TAXABLE], out[RW.PENALTY_BASE], out[RW.FROM_BASIS], out[RW.FROM_CONVERSIONS]]).toEqual([0, 30000, 30000, 30000]);
  },
  roth_history: () => {
    // E6: no Roth before the plan; a first conversion of 40,000 in 2027 starts the clock; in 2030 at 61
    // all 50,000 is withdrawn: 10,000 of earnings are taxable (2030 is before 2032), base 0.
    const st = new Float64Array(RB_REC);
    seedRoth(st, 0, 0, false, 2027);
    addRothConversion(st, 0, 40000, 2027);
    for (let y = 2028; y <= 2030; y++) rothRollYear(st, 0);
    expect(st[RB.FIRST_YEAR]).toBe(2027);
    const out = new Float64Array(RW_REC);
    rothWithdraw(st, 0, 50000, 0, 2030, out);
    expect([out[RW.TAXABLE], out[RW.PENALTY_BASE]]).toEqual([10000, 0]);
  },
  hsa_shoebox: () => {
    // E9: 10,000 out with 6,000 of the same year's medical costs: 4,000 taxable, all of it penalized before 65.
    const out = new Float64Array(HW_REC);
    hsaWithdraw(10000, 6000, 1, out);
    expect([out[HW.TAXABLE], out[HW.PENALTY_BASE]]).toEqual([4000, 4000]);
  },
  rmd_first_year_deferral: () => {
    // G3: born 1953, the first RMD is taken in 2026, the year of 73, not by 1 April 2027.
    expect(firstRmdYear(1953)).toBe(2026);
    expect(requiredMinimumDistribution(100000, 72, rmdStartAge(1953), -1)).toBe(0);
    near(requiredMinimumDistribution(100000, 73, rmdStartAge(1953), -1), 3773.58);
  },
  rmd_still_working: () => {
    // G3: born 1960: 0 in 2034 (74), balance ÷ 24.6 in 2035, whether or not the owner still works.
    expect(requiredMinimumDistribution(100000, 74, rmdStartAge(1960), -1)).toBe(0);
    near(requiredMinimumDistribution(100000, 75, rmdStartAge(1960), -1), 100000 / 24.6);
  },
  qcd: () => {
    // D7: the RMD 1,200,000 ÷ 25.5 = 47,058.82 at 74 is ordinary income in full: AGI 135,558.82, 8,123.06.
    const rmd = requiredMinimumDistribution(1200000, 74, rmdStartAge(1953), 72);
    near(rmd, 47058.82);
    const r = tax(2027, J, { TRAD_DIST: rmd, PENSION: 18000, SS_GROSS: 62000, ORD_DIV: 6300, QUAL_DIV: 6000, INTEREST: 2500, LT_GAIN: 9000, N_AGED: 2 });
    near(r[TO.AGI]!, 135558.82);
    near(r[TO.TOTAL]!, 8123.06);
  },
  inherited_accounts: () => {
    // G6: had B been born in 1960 (71 in 2031) she takes nothing until 2035, on her own start age of 75:
    // the spousal rollover is the only inheritance modelled, so no ten-year or beneficiary schedule applies.
    expect(rmdStartAge(1960)).toBe(75);
    expect(requiredMinimumDistribution(900000, 2031 - 1960, 75, -1)).toBe(0);
    near(requiredMinimumDistribution(900000, 2035 - 1960, 75, -1), 900000 / 24.6);
  },
  ss_family_maximum: () => {
    // H7(b) with the worker at full retirement age: worker 2,400 and spouse 600 + 600 = 1,200, together
    // 3,600 = 150% of the worker's PIA, the lowest value the family maximum can take, paid unreduced.
    const h = ssHousehold([est(1960, 1, 2400, 804), est(1962, 1, 600, 804)]);
    const total = monthlyPayment(h.plan, h.st, 0, mo(2029, 1), INF, INF) + monthlyPayment(h.plan, h.st, 1, mo(2029, 1), INF, INF);
    expect(total).toBe(3600);
  },
  ss_wage_indexing: () => {
    // H9: a PIA of 2,000 as of 2025 is carried by the 2.8% COLA only: 2,056.00 at a 2026 start.
    expect(ssHousehold([est(1962, 1, 2000, 804, 2025)]).plan.people[0]!.piaAtStart).toBe(2056);
  },
  ss_month_rules: () => {
    // H11: born June 1964, claim at 62 (June 2026): 2026 pays 7 × 1,400 = 9,800, the birth month included.
    const out = ssYear(ssHousehold([est(1964, 6, 2000, 744)]), 2026);
    expect([out[SO.BENEFIT], out[SO.MONTHS_PAID]]).toEqual([9800, 7]);
  },
  ss_earnings_test_detail: () => {
    // H10(a): born January 1963, 2026, wages 40,000: the annual test withholds (40,000 − 24,480) ÷ 2 = 7,760
    // of 16,800, wages spread evenly (no monthly test in the first year).
    const out = ssYear(ssHousehold([est(1963, 1, 2000, 744)]), 2026, 40000);
    expect([out[SO.WITHHELD], out[SO.BENEFIT]]).toEqual([7760, 9040]);
  },
  ss_other_benefits: () => {
    // H8(c): the deceased (born January 1970) dies at the end of 2030 before claiming; the survivor, born
    // January 1971, is 60 in January 2031 and the widow(er)'s benefit starts at once: 2,000 × 143/200 = 1,430.
    const h = ssHousehold([est(1970, 1, 2000, 804), est(1971, 1, 0, 804)]);
    expect(monthlyPayment(h.plan, h.st, 1, mo(2031, 1), 2030, INF)).toBe(1430);
  },
  ss_receiving_spousal: () => {
    // H14: a person receiving 1,500 is given an own PIA backed out of it (1,500 ÷ 7/10); a monthlyAtFra
    // of 2,100 is used unchanged. No spousal part is separated out of the amount received.
    const base = { mode: "receiving" as const, birthYear: 1962, birthMonth: 1, monthly: 1500, asOfYear: 2026, startedIndex: mo(2024, 1) };
    const o = { spousal: true, survivor: true, startYear: 2026 };
    expect(compileSsPlan([{ ...base, monthlyAtFra: 2100 }], o).people[0]!.piaAtStart).toBe(2100);
    expect(compileSsPlan([base], o).people[0]!.piaAtStart).toBeCloseTo(1500 / 0.7, 9);
  },
  nq_annuity_nii: () => {
    // D5(a): single, 2026, wages 250,000, interest 10,000, qualified dividends 10,000, gain 30,000: NII
    // 50,000 (interest, dividends, rent and gains), NIIT 1,900, total 62,404.00. An annuity's 20,000
    // more (PENSION) adds nothing to NII.
    const fields = { WAGES: 250000, INTEREST: 10000, ORD_DIV: 10000, QUAL_DIV: 10000, LT_GAIN: 30000 };
    const r = tax(2026, S, fields);
    expect(r[TO.NII]).toBe(50000);
    near(r[TO.NIIT]!, 1900);
    near(r[TO.TOTAL]!, 62404);
    expect(tax(2026, S, { ...fields, PENSION: 20000 })[TO.NII]).toBe(50000);
  },
  rental_detail: () => {
    // The RENTAL input is net rental income and must not be negative (no passive losses).
    const x = taxInput({ RENTAL: -1000 });
    expect(() => assertTaxInput(x)).toThrow(TaxInputError);
  },
  wash_sales_lots: () => {
    // Average cost per account and simulated asset (T23): 130,000 of stock sold at the average basis
    // fraction 300,000 / 700,000 realizes 130,000 × 4/7 = 74,285.71; the stock basis falls by 130,000 × 3/7.
    const bal = Float64Array.of(700000, 300000, 0);
    const basis = Float64Array.of(300000, 290000, 0);
    const out = createTradeResult();
    planTrades(bal, basis, 0, Float64Array.of(0.6, 0.4, 0), 0, 50000, TRADE_FULL, true, true, out);
    near(out.realizedGain, (130000 * 4) / 7);
    near(basis[0]!, 300000 - (130000 * 3) / 7);
  },
  payment_timing: () => {
    // J3(a): single, 40, 2026, f = 3/12, wages 25,000: the period's tax 13,170 × 3/12 = 3,292.50, paid in the year.
    near(tax(2026, S, { WAGES: 25000, YEAR_FRACTION: 3 / 12 })[TO.TOTAL]!, 3292.5);
  },
  payroll_detail: () => {
    // I1: single, 2026, wages 250,000: 15,514.00 on gross wages; no HSA payroll exemption, no self-employment tax.
    near(employeePayrollTax(t.prog, progOffset(0), 250000, 0, 0, 1), 15514);
  },
  state_irmaa_aca: () => {
    // C5(b): single, 2026, benefits 24,000, pension 12,000, tax-exempt interest 4,000: the MAGI figures
    // exist (IRMAA 17,500; ACA 17,500 + 22,500 = 40,000) and the total has no state, IRMAA or ACA term.
    const r = tax(2026, S, { SS_GROSS: 24000, PENSION: 12000, TAX_EXEMPT_INTEREST: 4000 });
    expect([r[TO.MAGI_IRMAA], r[TO.MAGI_ACA]]).toEqual([17500, 40000]);
    expect(r[TO.TOTAL]).toBe(r[TO.INCOME_TAX]! + r[TO.NIIT]! + r[TO.PEN10]! + r[TO.PEN20]!);
  },
};

describe("K8 pins of the not-modelled list (tax-rmd-ss §8.2)", () => {
  it("K8 every entry has a unique id, a label and an effect, and exactly one pin", () => {
    const ids = NOT_MODELLED.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(PINS).sort());
    for (const e of NOT_MODELLED) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.effect.length).toBeGreaterThan(0);
    }
    expect(ids).not.toContain("loss_step_down");
    expect(ids).not.toContain("rebalance_lag");
  });

  for (const entry of NOT_MODELLED) {
    it(`K8 ${entry.id}`, PINS[entry.id]);
  }
});
