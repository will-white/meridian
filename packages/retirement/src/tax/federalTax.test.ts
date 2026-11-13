import { TaxYearDetail } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { dollarsToCentsBigInt } from "../units.js";
import { assertTaxInput, computeFederalTax, effectiveMarginalRates, federalTaxInto, TaxInputError, taxYearDetail, taxYearDetailCents } from "./federalTax.js";
import { TAX_IN, TAX_OUT, TI, TO } from "./layout.js";
import { loadTaxData, TaxDataError } from "./taxData.js";
import { pathTables, taxInput, taxOn, type TaxInputName } from "./testKit.js";

// tax-rmd-ss §3.3 and §3.4; tests B, C, D, J3 and K9 (§7), and the hand-calculated tax cases HC-T1 to
// HC-T14 and HC-T16 of strategies-outputs-web §7.5. Each expected value is the design's; dollar
// values with cents are asserted within 0.005 (tax-rmd-ss decision 50), rates to 1e-6.
// "2026" and "2027" are the published rows; N_AGED = 0 unless ages say otherwise.

const data = loadTaxData();
const S = 0;
const J = 1;
const published = pathTables(data, { startYear: 2026, years: 2 });

const near = (actual: number, expected: number, label = "") =>
  expect(Math.abs(actual - expected), `${label} ${actual} vs ${expected}`).toBeLessThanOrEqual(0.005);

/** The outputs for one household-year in a published row. */
function tax(year: 2026 | 2027, status: 0 | 1, fields: Partial<Record<TaxInputName, number>>): Float64Array {
  return taxOn(published, year, status, taxInput(fields));
}

describe("B. Ordinary tax and deductions", () => {
  it("B1 single, 40, 2026, wages 100,000: 13,170.00; bracket rate 0.22, room 21,800", () => {
    // Taxable 100,000 − 16,100 = 83,900; 5,800 + 22% × (83,900 − 50,400 = 33,500).
    const r = tax(2026, S, { WAGES: 100000 });
    near(r[TO.TAXABLE_INCOME]!, 83900);
    near(r[TO.TOTAL]!, 13170.0);
    expect(r[TO.BRACKET_RATE]).toBe(0.22);
    near(r[TO.ROOM_IN_BRACKET]!, 21800);
  });

  it("B2 joint, both 45, 2026, wages 180,000: 21,940.00", () => {
    const r = tax(2026, J, { WAGES: 180000 });
    near(r[TO.TAXABLE_INCOME]!, 147800);
    near(r[TO.TOTAL]!, 21940.0);
  });

  it("B3 single, 40, 2027, wages 100,000: 12,889.50", () => {
    const r = tax(2027, S, { WAGES: 100000 });
    near(r[TO.TAXABLE_INCOME]!, 83400);
    near(r[TO.TOTAL]!, 12889.5);
  });

  it("B4 joint, both 45, 2027, wages 180,000: 21,379.00", () => {
    const r = tax(2027, J, { WAGES: 180000 });
    near(r[TO.TAXABLE_INCOME]!, 146800);
    near(r[TO.TOTAL]!, 21379.0);
  });

  it("B5 joint, both 67, 2026, pension 60,000 and pre-tax 30,000: 4,604.00", () => {
    // AGI 90,000; standard 32,200 + 2 × 1,650 = 35,500; senior 12,000; taxable 42,500; 2,480 + 12% × 17,700.
    const r = tax(2026, J, { PENSION: 60000, TRAD_DIST: 30000, N_AGED: 2 });
    near(r[TO.AGI]!, 90000);
    near(r[TO.STD_DEDUCTION]!, 35500);
    near(r[TO.SENIOR_DEDUCTION]!, 12000);
    near(r[TO.TAXABLE_INCOME]!, 42500);
    near(r[TO.TOTAL]!, 4604.0);
  });

  it("B6 (a) single, 70, pension 100,000: senior 4,500, tax 11,729.00", () => {
    const r = tax(2026, S, { PENSION: 100000, N_AGED: 1 });
    near(r[TO.SENIOR_DEDUCTION]!, 4500);
    near(r[TO.STD_DEDUCTION]!, 18150);
    near(r[TO.TAXABLE_INCOME]!, 77350);
    near(r[TO.TOTAL]!, 11729.0);
  });

  it("B6 (b) joint, one spouse 65 or over, pension 200,000: senior 3,000, tax 25,317.00", () => {
    const r = tax(2026, J, { PENSION: 200000, N_AGED: 1 });
    near(r[TO.SENIOR_DEDUCTION]!, 3000);
    near(r[TO.STD_DEDUCTION]!, 33850);
    near(r[TO.TAXABLE_INCOME]!, 163150);
    near(r[TO.TOTAL]!, 25317.0);
  });

  it("B6 (c) joint, both 70, pension 200,000: senior 6,000, tax 24,294.00", () => {
    const r = tax(2026, J, { PENSION: 200000, N_AGED: 2 });
    near(r[TO.SENIOR_DEDUCTION]!, 6000);
    near(r[TO.TAXABLE_INCOME]!, 158500);
    near(r[TO.TOTAL]!, 24294.0);
  });

  it("B6 (d) single, 70, pension 175,000: senior 0 (the phase-out ends at 175,000), tax 30,242.00", () => {
    const r = tax(2026, S, { PENSION: 175000, N_AGED: 1 });
    expect(r[TO.SENIOR_DEDUCTION]).toBe(0);
    near(r[TO.TAXABLE_INCOME]!, 156850);
    near(r[TO.TOTAL]!, 30242.0);
  });

  it("B6 (e) joint, both 70, pension 250,000: senior 0, tax 36,676.00", () => {
    const r = tax(2026, J, { PENSION: 250000, N_AGED: 2 });
    expect(r[TO.SENIOR_DEDUCTION]).toBe(0);
    near(r[TO.TAXABLE_INCOME]!, 214500);
    near(r[TO.TOTAL]!, 36676.0);
  });

  it("B7 the survivor's change of status: joint 2026 both 75 pension 80,000 is 3,404.00; single 2027 at 76 is 6,773.50", () => {
    near(tax(2026, J, { PENSION: 80000, N_AGED: 2 })[TO.TOTAL]!, 3404.0);
    // Standard 16,600 + 2,100 = 18,700; senior 6,000 − 6% × 5,000 = 5,700; taxable 55,600; 5,987 + 22% × 3,575.
    const r = tax(2027, S, { PENSION: 80000, N_AGED: 1 });
    near(r[TO.STD_DEDUCTION]!, 18700);
    near(r[TO.SENIOR_DEDUCTION]!, 5700);
    near(r[TO.TAXABLE_INCOME]!, 55600);
    near(r[TO.TOTAL]!, 6773.5);
  });

  it("B8 adjustments: single, 2026, wages 85,000, adjustments 4,400: 8,902.00", () => {
    const r = tax(2026, S, { WAGES: 85000, ADJUSTMENTS: 4400 });
    near(r[TO.AGI]!, 80600);
    near(r[TO.TAXABLE_INCOME]!, 64500);
    near(r[TO.TOTAL]!, 8902.0);
  });

  it("B9 unused deduction: single, 2026, wages 10,000: tax 0, unused 6,100, bracket rate 0, index 0, room 12,400", () => {
    const r = tax(2026, S, { WAGES: 10000 });
    expect(r[TO.TAXABLE_INCOME]).toBe(0);
    expect(r[TO.TOTAL]).toBe(0);
    near(r[TO.UNUSED_DEDUCTION]!, 6100);
    expect(r[TO.BRACKET_RATE]).toBe(0);
    expect(r[TO.BRACKET_INDEX]).toBe(0);
    near(r[TO.ROOM_IN_BRACKET]!, 12400);
  });

  it("B10 top bracket: single, 2027, wages 800,000: 244,387.00, room +Infinity", () => {
    // Taxable 783,400; 199,237.75 + 37% × 122,025.
    const r = tax(2027, S, { WAGES: 800000 });
    near(r[TO.TAXABLE_INCOME]!, 783400);
    near(r[TO.TOTAL]!, 244387.0);
    expect(r[TO.ROOM_IN_BRACKET]).toBe(Infinity);
    expect(r[TO.BRACKET_INDEX]).toBe(6);
    expect(r[TO.BRACKET_RATE]).toBe(0.37);
  });
});

describe("C. Taxation of Social Security", () => {
  it("C1 nothing taxable: single, benefits 20,000, pension 10,000, provisional 20,000", () => {
    const r = tax(2026, S, { SS_GROSS: 20000, PENSION: 10000 });
    near(r[TO.PROVISIONAL]!, 20000);
    expect(r[TO.TAXABLE_SS]).toBe(0);
  });

  it("C2 the 50% tier (Publication 915 Example 1): single, benefits 5,980, other income 28,990: 2,990", () => {
    const r = tax(2026, S, { SS_GROSS: 5980, WAGES: 28990 });
    near(r[TO.PROVISIONAL]!, 31980);
    near(r[TO.TAXABLE_SS]!, 2990);
  });

  it("C3 the 85% tier (Publication 915 Example 3): joint, benefits 10,000, other income 40,500: 6,275", () => {
    const r = tax(2026, J, { SS_GROSS: 10000, WAGES: 40500 });
    near(r[TO.PROVISIONAL]!, 45500);
    near(r[TO.TAXABLE_SS]!, 6275);
  });

  it("C4 (a) single, benefits 20,000, other 20,000: 2,500; (b) joint, benefits 40,000, other 50,000: 28,100", () => {
    near(tax(2026, S, { SS_GROSS: 20000, WAGES: 20000 })[TO.TAXABLE_SS]!, 2500);
    const b = tax(2026, J, { SS_GROSS: 40000, WAGES: 50000 });
    near(b[TO.PROVISIONAL]!, 70000);
    near(b[TO.TAXABLE_SS]!, 28100);
  });

  it("C5 (a) the 85% cap: single, benefits 30,000, other 80,000: 25,500", () => {
    near(tax(2026, S, { SS_GROSS: 30000, WAGES: 80000 })[TO.TAXABLE_SS]!, 25500);
  });

  it("C5 (b) tax-exempt interest counts: single, benefits 24,000, pension 12,000, tax-exempt interest 4,000", () => {
    const r = tax(2026, S, { SS_GROSS: 24000, PENSION: 12000, TAX_EXEMPT_INTEREST: 4000 });
    near(r[TO.PROVISIONAL]!, 28000);
    near(r[TO.TAXABLE_SS]!, 1500);
    near(r[TO.AGI]!, 13500);
    near(r[TO.MAGI_IRMAA]!, 17500);
    near(r[TO.MAGI_ACA]!, 40000);
  });

  it("C6 the full return of §3.3: married, both 68, 2026", () => {
    const fields = { SS_GROSS: 48000, PENSION: 20000, TRAD_DIST: 40000, INTEREST: 3000, ORD_DIV: 8000, QUAL_DIV: 6000, LT_GAIN: 12000, N_AGED: 2 };
    const r = tax(2026, J, fields);
    near(r[TO.PROVISIONAL]!, 107000);
    near(r[TO.TAXABLE_SS]!, 40800);
    near(r[TO.AGI]!, 123800);
    near(r[TO.STD_DEDUCTION]!, 35500);
    near(r[TO.SENIOR_DEDUCTION]!, 12000);
    near(r[TO.TAXABLE_INCOME]!, 76300);
    near(r[TO.PREF_INCOME]!, 18000);
    near(r[TO.ORD_TAXABLE]!, 58300);
    near(r[TO.ORD_TAX]!, 6500);
    near(r[TO.PREF_AT_0]!, 18000);
    near(r[TO.TOTAL]!, 6500.0);
    near(r[TO.MAGI_IRMAA]!, 123800);
    near(r[TO.MAGI_ACA]!, 131000);
    expect(r[TO.BRACKET_RATE]).toBe(0.12);
    near(r[TO.ROOM_IN_BRACKET]!, 42500);
    near(r[TO.ROOM_IN_LTCG0]!, 22600);
    // An extra 1,000 of pre-tax withdrawal costs 120.00 (benefits are already at the 85% cap).
    near(tax(2026, J, { ...fields, TRAD_DIST: 41000 })[TO.TOTAL]! - r[TO.TOTAL]!, 120.0);
  });

  it("C7 survivor, single, 72, 2027: 4,643.60", () => {
    // other 50,000; provisional 65,000; 30,850 capped at 25,500; AGI 75,500; senior 6,000 − 6% × 500 = 5,970;
    // taxable 50,830; ordinary 40,830; 1,280 + 12% × 28,030.
    const r = tax(2027, S, { SS_GROSS: 30000, TRAD_DIST: 40000, ORD_DIV: 4000, QUAL_DIV: 4000, LT_GAIN: 6000, N_AGED: 1 });
    near(r[TO.PROVISIONAL]!, 65000);
    near(r[TO.TAXABLE_SS]!, 25500);
    near(r[TO.AGI]!, 75500);
    near(r[TO.SENIOR_DEDUCTION]!, 5970);
    near(r[TO.TAXABLE_INCOME]!, 50830);
    near(r[TO.ORD_TAXABLE]!, 40830);
    near(r[TO.PREF_AT_0]!, 10000);
    near(r[TO.TOTAL]!, 4643.6);
  });

  it("C8 joint, 2027, one spouse 66 with benefits 24,000, the other 60 with wages 50,000, interest 2,000: 3,268.00", () => {
    const r = tax(2027, J, { SS_GROSS: 24000, WAGES: 50000, INTEREST: 2000, N_AGED: 1 });
    near(r[TO.PROVISIONAL]!, 64000);
    near(r[TO.TAXABLE_SS]!, 20400);
    near(r[TO.AGI]!, 72400);
    near(r[TO.STD_DEDUCTION]!, 34900);
    near(r[TO.SENIOR_DEDUCTION]!, 6000);
    near(r[TO.TAXABLE_INCOME]!, 31500);
    near(r[TO.TOTAL]!, 3268.0);
  });

  it("C9 effective marginal rates, single, 70, 2026: (a) 0.222; (b) 0.43142 ordinary and 0.36142 long-term gain", () => {
    const o = 0; // taxOffset(0, single) on the 2026-start tables.
    const scratchIn = new Float64Array(TAX_IN);
    const scratchOut = new Float64Array(TAX_OUT);
    const out = new Float64Array(2);

    const a = taxInput({ SS_GROSS: 30000, TRAD_DIST: 30000, N_AGED: 1 });
    const ra = tax(2026, S, { SS_GROSS: 30000, TRAD_DIST: 30000, N_AGED: 1 });
    near(ra[TO.PROVISIONAL]!, 45000);
    near(ra[TO.TAXABLE_SS]!, 13850);
    near(ra[TO.AGI]!, 43850);
    near(ra[TO.TAXABLE_INCOME]!, 19700);
    near(ra[TO.TOTAL]!, 2116.0);
    expect(ra[TO.BRACKET_RATE]).toBe(0.12);
    effectiveMarginalRates(published.tax, o, a, scratchIn, scratchOut, out);
    // $100 more: benefits +85, AGI +185, taxable +185 (AGI below 75,000, the senior deduction is whole) × 12%.
    expect(out[0]).toBeCloseTo(0.222, 6);

    const b = taxInput({ SS_GROSS: 60000, TRAD_DIST: 55000, N_AGED: 1 });
    const rb = tax(2026, S, { SS_GROSS: 60000, TRAD_DIST: 55000, N_AGED: 1 });
    near(rb[TO.TAXABLE_SS]!, 47850);
    near(rb[TO.AGI]!, 102850);
    near(rb[TO.SENIOR_DEDUCTION]!, 4329);
    near(rb[TO.TAXABLE_INCOME]!, 80371);
    near(rb[TO.TOTAL]!, 12393.62);
    effectiveMarginalRates(published.tax, o, b, scratchIn, scratchOut, out);
    // 22% × 1.85 × 1.06 = 0.43142; a gain: 22% × (1.85 × 1.06 − 1) + 15% = 22% × 0.961 + 15% = 0.36142.
    expect(out[0]).toBeCloseTo(0.43142, 6);
    expect(out[1]).toBeCloseTo(0.36142, 6);
    // The input is not written.
    expect(Array.from(b)).toEqual(Array.from(taxInput({ SS_GROSS: 60000, TRAD_DIST: 55000, N_AGED: 1 })));
  });
});

describe("D. Capital gains, net investment income tax, losses", () => {
  it("D1 gains across the 0% and 15% bands: single, 50, 2026: 4,037.50", () => {
    const r = tax(2026, S, { WAGES: 40000, ORD_DIV: 5000, QUAL_DIV: 5000, LT_GAIN: 30000 });
    near(r[TO.AGI]!, 75000);
    near(r[TO.TAXABLE_INCOME]!, 58900);
    near(r[TO.PREF_INCOME]!, 35000);
    near(r[TO.ORD_TAXABLE]!, 23900);
    near(r[TO.PREF_AT_0]!, 25550);
    near(r[TO.PREF_AT_15]!, 9450);
    near(r[TO.ORD_TAX]!, 2620);
    near(r[TO.CG_TAX]!, 1417.5);
    near(r[TO.TOTAL]!, 4037.5);
  });

  it("D2 gains across the 15% and 20% bands, with NIIT: joint, both 50, 2026: 154,827.00", () => {
    const r = tax(2026, J, { WAGES: 532200, LT_GAIN: 200000 });
    near(r[TO.AGI]!, 732200);
    near(r[TO.TAXABLE_INCOME]!, 700000);
    near(r[TO.ORD_TAXABLE]!, 500000);
    near(r[TO.ORD_TAX]!, 112912);
    near(r[TO.PREF_AT_15]!, 113700);
    near(r[TO.PREF_AT_20]!, 86300);
    near(r[TO.INCOME_TAX]!, 147227);
    near(r[TO.NIIT]!, 7600);
    near(r[TO.TOTAL]!, 154827.0);
    expect(r[TO.LTCG_NEXT_RATE]).toBe(0.2);
  });

  it("D3 all gains at 0%: joint, both 66, 2027, interest 20,000, long-term gain 80,000: 0.00", () => {
    const r = tax(2027, J, { INTEREST: 20000, LT_GAIN: 80000, N_AGED: 2 });
    near(r[TO.AGI]!, 100000);
    near(r[TO.STD_DEDUCTION]!, 36600);
    near(r[TO.SENIOR_DEDUCTION]!, 12000);
    near(r[TO.TAXABLE_INCOME]!, 51400);
    expect(r[TO.ORD_TAXABLE]).toBe(0);
    near(r[TO.PREF_AT_0]!, 51400);
    expect(r[TO.TOTAL]).toBe(0);
  });

  it("D4 the worksheet's last line: joint, 2026, wages 131,100, long-term gain 1,900: 11,600.00, capital gains tax 228.00", () => {
    // Line 23 is 11,372 + 285 = 11,657; line 24 is bracket(100,800) = 11,600, the smaller.
    const r = tax(2026, J, { WAGES: 131100, LT_GAIN: 1900 });
    near(r[TO.TAXABLE_INCOME]!, 100800);
    near(r[TO.ORD_TAXABLE]!, 98900);
    near(r[TO.ORD_TAX]!, 11372);
    near(r[TO.TOTAL]!, 11600.0);
    near(r[TO.CG_TAX]!, 228.0);
  });

  it("D5 (a) NIIT, single 2026, wages 250,000, interest 10,000, qualified dividends 10,000, gain 30,000: 62,404.00", () => {
    const r = tax(2026, S, { WAGES: 250000, INTEREST: 10000, ORD_DIV: 10000, QUAL_DIV: 10000, LT_GAIN: 30000 });
    near(r[TO.AGI]!, 300000);
    near(r[TO.TAXABLE_INCOME]!, 283900);
    near(r[TO.ORD_TAXABLE]!, 243900);
    near(r[TO.ORD_TAX]!, 54504);
    near(r[TO.CG_TAX]!, 6000);
    near(r[TO.NII]!, 50000);
    near(r[TO.NIIT]!, 1900);
    near(r[TO.TOTAL]!, 62404.0);
  });

  it("D5 (b) wages 180,000, gain 50,000: 40,574.00", () => {
    const r = tax(2026, S, { WAGES: 180000, LT_GAIN: 50000 });
    near(r[TO.ORD_TAX]!, 31934);
    near(r[TO.CG_TAX]!, 7500);
    near(r[TO.NIIT]!, 1140);
    near(r[TO.TOTAL]!, 40574.0);
  });

  it("D5 (c) wages 500,000, gain 100,000: 158,854.25", () => {
    const r = tax(2026, S, { WAGES: 500000, LT_GAIN: 100000 });
    near(r[TO.TAXABLE_INCOME]!, 583900);
    near(r[TO.ORD_TAXABLE]!, 483900);
    near(r[TO.ORD_TAX]!, 138134.25);
    near(r[TO.PREF_AT_15]!, 61600);
    near(r[TO.PREF_AT_20]!, 38400);
    near(r[TO.NIIT]!, 3800);
    near(r[TO.TOTAL]!, 158854.25);
  });

  it("D5 (d) with a loss: wages 260,000, interest 5,000, long-term loss 10,000: NIIT 76.00", () => {
    const r = tax(2026, S, { WAGES: 260000, INTEREST: 5000, LT_GAIN: -10000 });
    near(r[TO.LOSS_USED]!, 3000);
    near(r[TO.AGI]!, 262000);
    near(r[TO.NII]!, 2000);
    near(r[TO.NIIT]!, 76.0);
  });

  it("D6 (a) single 2026, wages 60,000, long-term loss 10,000: used 3,000, carried 7,000, tax 4,660.00", () => {
    const r = tax(2026, S, { WAGES: 60000, LT_GAIN: -10000 });
    near(r[TO.LOSS_USED]!, 3000);
    near(r[TO.LOSS_CARRY_OUT]!, 7000);
    near(r[TO.AGI]!, 57000);
    near(r[TO.TAXABLE_INCOME]!, 40900);
    near(r[TO.TOTAL]!, 4660.0);
  });

  it("D6 (b) wages 60,000, gain 5,000, carry-in 7,000: net −2,000, used 2,000, carried 0, tax 4,780.00", () => {
    const r = tax(2026, S, { WAGES: 60000, LT_GAIN: 5000, LOSS_CARRY_IN: 7000 });
    near(r[TO.LOSS_USED]!, 2000);
    expect(r[TO.LOSS_CARRY_OUT]).toBe(0);
    near(r[TO.AGI]!, 58000);
    near(r[TO.TAXABLE_INCOME]!, 41900);
    near(r[TO.TOTAL]!, 4780.0);
  });

  it("D6 (c) wages 60,000, gain 12,000, carry-in 7,000: net 5,000 all at 0%, tax 5,020.00", () => {
    const r = tax(2026, S, { WAGES: 60000, LT_GAIN: 12000, LOSS_CARRY_IN: 7000 });
    near(r[TO.TAXABLE_INCOME]!, 48900);
    near(r[TO.ORD_TAXABLE]!, 43900);
    near(r[TO.PREF_AT_0]!, 5000);
    near(r[TO.TOTAL]!, 5020.0);
  });

  it("D6 (d) wages 60,000, short-term gain 4,000, long-term loss 1,000: net 3,000, preferential 0, tax 5,380.00", () => {
    const r = tax(2026, S, { WAGES: 60000, ST_GAIN: 4000, LT_GAIN: -1000 });
    expect(r[TO.PREF_INCOME]).toBe(0);
    near(r[TO.AGI]!, 63000);
    near(r[TO.TAXABLE_INCOME]!, 46900);
    near(r[TO.TOTAL]!, 5380.0);
  });

  it("D6 (e) wages 70,000, long-term gain 10,000, short-term loss 4,000: preferential 6,000, tax 7,470.00", () => {
    const r = tax(2026, S, { WAGES: 70000, LT_GAIN: 10000, ST_GAIN: -4000 });
    near(r[TO.PREF_INCOME]!, 6000);
    near(r[TO.AGI]!, 76000);
    near(r[TO.TAXABLE_INCOME]!, 59900);
    near(r[TO.ORD_TAXABLE]!, 53900);
    near(r[TO.TOTAL]!, 7470.0);
  });

  it("D7 an integrated 2027 return with an RMD: joint, ages 74 and 72: 8,123.06", () => {
    // The RMD of person A (born 1953, 74 in 2027) is 1,200,000 ÷ 25.5, the Uniform Lifetime divisor at 74.
    expect(data.uniform.divisors[74 - data.uniform.firstAge]).toBe(25.5);
    const rmd = 1200000 / 25.5;
    near(rmd, 47058.82);
    const r = tax(2027, J, { TRAD_DIST: rmd, PENSION: 18000, SS_GROSS: 62000, ORD_DIV: 6300, QUAL_DIV: 6000, INTEREST: 2500, LT_GAIN: 9000, N_AGED: 2 });
    near(r[TO.PROVISIONAL]!, 113858.82);
    near(r[TO.TAXABLE_SS]!, 52700);
    near(r[TO.AGI]!, 135558.82);
    near(r[TO.STD_DEDUCTION]!, 36600);
    near(r[TO.SENIOR_DEDUCTION]!, 12000);
    near(r[TO.TAXABLE_INCOME]!, 86958.82);
    near(r[TO.PREF_INCOME]!, 15000);
    near(r[TO.ORD_TAXABLE]!, 71958.82);
    near(r[TO.PREF_AT_0]!, 15000);
    near(r[TO.NII]!, 17800);
    expect(r[TO.NIIT]).toBe(0);
    near(r[TO.TOTAL]!, 8123.06);
    near(r[TO.ROOM_IN_BRACKET]!, 32091.18);
    near(r[TO.ROOM_IN_LTCG0]!, 15141.18);
  });
});

describe("J3 the partial year (seams C23: the scaling happens inside the function only)", () => {
  it("J3 (a) single, 40, 2026, f = 3/12, wages 25,000: 3,292.50, AGI 25,000, standard deduction 4,025", () => {
    // 13,170 × 3/12 on the annualized 100,000.
    const r = tax(2026, S, { WAGES: 25000, YEAR_FRACTION: 3 / 12 });
    near(r[TO.TOTAL]!, 3292.5);
    near(r[TO.AGI]!, 25000);
    near(r[TO.STD_DEDUCTION]!, 4025);
    expect(r[TO.BRACKET_RATE]).toBe(0.22);
  });

  it("J3 (b) f = 2/12, wages 16,666.67: 2,195.00", () => {
    near(tax(2026, S, { WAGES: 16666.67, YEAR_FRACTION: 2 / 12 })[TO.TOTAL]!, 2195.0);
  });

  it("J3 (c) f = 2/12, wages 10,000, long-term loss 8,000: loss used 500, carried 7,500, AGI 9,500, tax 776.67", () => {
    // Annualized: wages 60,000, loss 48,000: used 3,000 (× f = 500), carried 45,000 (× f = 7,500); 4,660 × 2/12.
    const r = tax(2026, S, { WAGES: 10000, LT_GAIN: -8000, YEAR_FRACTION: 2 / 12 });
    near(r[TO.LOSS_USED]!, 500);
    near(r[TO.LOSS_CARRY_OUT]!, 7500);
    near(r[TO.AGI]!, 9500);
    near(r[TO.TOTAL]!, 776.67);
  });

  it("J3 (d) the input array is bit-identical after each call; f of 0 or 1 is a full year", () => {
    for (const fields of [
      { WAGES: 25000, YEAR_FRACTION: 3 / 12 },
      { WAGES: 16666.67, YEAR_FRACTION: 2 / 12 },
      { WAGES: 10000, LT_GAIN: -8000, YEAR_FRACTION: 2 / 12 },
    ]) {
      const x = taxInput(fields);
      const before = new Uint8Array(x.buffer.slice(0));
      federalTaxInto(published.tax, 0, x, new Float64Array(TAX_OUT));
      expect(new Uint8Array(x.buffer)).toEqual(before);
    }
    expect(Array.from(tax(2026, S, { WAGES: 100000, YEAR_FRACTION: 0 }))).toEqual(Array.from(tax(2026, S, { WAGES: 100000, YEAR_FRACTION: 1 })));
  });
});

describe("HC-T hand-calculated tax cases (strategies-outputs-web §7.5)", () => {
  it("HC-T1 2026, joint, under 65, wages 150,000: taxable 117,800, tax 15,340.00", () => {
    // 11,600 + 22% × 17,000.
    const r = tax(2026, J, { WAGES: 150000 });
    near(r[TO.TAXABLE_INCOME]!, 117800);
    near(r[TO.TOTAL]!, 15340.0);
  });

  it("HC-T2 2026, single, under 65, ordinary 60,000: taxable 43,900, tax 5,020.00", () => {
    const r = tax(2026, S, { OTHER_ORD: 60000 });
    near(r[TO.TAXABLE_INCOME]!, 43900);
    near(r[TO.TOTAL]!, 5020.0);
  });

  it("HC-T3 2026, joint, ordinary 80,000 and long-term gains 60,000: 5,240.00 + 1,335.00 = 6,575.00", () => {
    const r = tax(2026, J, { WAGES: 80000, LT_GAIN: 60000 });
    near(r[TO.ORD_TAXABLE]!, 47800);
    near(r[TO.ORD_TAX]!, 5240.0);
    near(r[TO.PREF_AT_0]!, 51100);
    near(r[TO.PREF_AT_15]!, 8900);
    near(r[TO.CG_TAX]!, 1335.0);
    near(r[TO.TOTAL]!, 6575.0);
  });

  it("HC-T4 2026, joint, ordinary 200,000 and gains 100,000: 26,340 + 15,000 + NIIT 1,900 = 43,240.00", () => {
    const r = tax(2026, J, { WAGES: 200000, LT_GAIN: 100000 });
    near(r[TO.ORD_TAX]!, 26340);
    near(r[TO.CG_TAX]!, 15000);
    near(r[TO.NIIT]!, 1900);
    near(r[TO.TOTAL]!, 43240.0);
  });

  it("HC-T5 taxable benefits: 11,100.00 (joint 40,000 with 30,000); 3,500.00 (single 24,000 with 20,000); 25,500.00 (the 85% cap)", () => {
    near(tax(2026, J, { SS_GROSS: 40000, OTHER_ORD: 30000 })[TO.TAXABLE_SS]!, 11100.0);
    near(tax(2026, S, { SS_GROSS: 24000, OTHER_ORD: 20000 })[TO.TAXABLE_SS]!, 3500.0);
    near(tax(2026, S, { SS_GROSS: 30000, OTHER_ORD: 100000 })[TO.TAXABLE_SS]!, 25500.0);
  });

  it("HC-T6 2026, single, 67, ordinary 100,000: standard 18,150, senior 4,500, taxable 77,350, tax 11,729.00", () => {
    const r = tax(2026, S, { OTHER_ORD: 100000, N_AGED: 1 });
    near(r[TO.STD_DEDUCTION]!, 18150);
    near(r[TO.SENIOR_DEDUCTION]!, 4500);
    near(r[TO.TAXABLE_INCOME]!, 77350);
    near(r[TO.TOTAL]!, 11729.0);
  });

  it("HC-T7 2026, joint, both 68, ordinary 190,000: senior 7,200, taxable 147,300, tax 21,830.00", () => {
    const r = tax(2026, J, { OTHER_ORD: 190000, N_AGED: 2 });
    near(r[TO.SENIOR_DEDUCTION]!, 7200);
    near(r[TO.TAXABLE_INCOME]!, 147300);
    near(r[TO.TOTAL]!, 21830.0);
  });

  it("HC-T8 2027, joint, both 65, ordinary 92,000: deductions 33,200 + 3,400 + 12,000, taxable 43,400, tax 4,696.00", () => {
    const r = tax(2027, J, { OTHER_ORD: 92000, N_AGED: 2 });
    near(r[TO.STD_DEDUCTION]!, 36600);
    near(r[TO.SENIOR_DEDUCTION]!, 12000);
    near(r[TO.TAXABLE_INCOME]!, 43400);
    near(r[TO.TOTAL]!, 4696.0);
  });

  it("HC-T9 2026, single, 67, pension 40,000, benefits 24,000, qualified dividends 5,000, gains 10,000: 4,378.48", () => {
    const r = tax(2026, S, { PENSION: 40000, SS_GROSS: 24000, ORD_DIV: 5000, QUAL_DIV: 5000, LT_GAIN: 10000, N_AGED: 1 });
    near(r[TO.TAXABLE_SS]!, 20400);
    near(r[TO.AGI]!, 75400);
    near(r[TO.SENIOR_DEDUCTION]!, 5976);
    near(r[TO.TAXABLE_INCOME]!, 51274);
    near(r[TO.ORD_TAXABLE]!, 36274);
    near(r[TO.ORD_TAX]!, 4104.88);
    near(r[TO.PREF_AT_0]!, 13176);
    near(r[TO.PREF_AT_15]!, 1824);
    near(r[TO.CG_TAX]!, 273.6);
    near(r[TO.TOTAL]!, 4378.48);
  });

  it("HC-T10 2027, joint, under 65, wages 240,000, interest 10,000, qualified dividends 20,000, gains 30,000: 46,179.00", () => {
    const r = tax(2027, J, { WAGES: 240000, INTEREST: 10000, ORD_DIV: 20000, QUAL_DIV: 20000, LT_GAIN: 30000 });
    near(r[TO.TAXABLE_INCOME]!, 266800);
    near(r[TO.ORD_TAXABLE]!, 216800);
    near(r[TO.ORD_TAX]!, 36779.0);
    near(r[TO.CG_TAX]!, 7500.0);
    near(r[TO.NIIT]!, 1900.0);
    near(r[TO.TOTAL]!, 46179.0);
  });

  it("HC-T11 2027, joint, under 65, wages 600,000, gains 200,000: 133,893.00 + 36,660.00 + 7,600.00 = 178,153.00", () => {
    const r = tax(2027, J, { WAGES: 600000, LT_GAIN: 200000 });
    near(r[TO.ORD_TAXABLE]!, 566800);
    near(r[TO.ORD_TAX]!, 133893.0);
    near(r[TO.PREF_AT_15]!, 66800);
    near(r[TO.PREF_AT_20]!, 133200);
    near(r[TO.CG_TAX]!, 36660.0);
    near(r[TO.NIIT]!, 7600.0);
    near(r[TO.TOTAL]!, 178153.0);
  });

  it("HC-T12 2027, joint, both 70, pre-tax 20,000, benefits 40,000, dividends 6,000, gains 30,000: 460.00", () => {
    // The dividends are qualified: ordinary taxable income is 40,600 − 36,000 = 4,600 at 10%.
    const r = tax(2027, J, { TRAD_DIST: 20000, SS_GROSS: 40000, ORD_DIV: 6000, QUAL_DIV: 6000, LT_GAIN: 30000, N_AGED: 2 });
    near(r[TO.TAXABLE_SS]!, 33200);
    near(r[TO.TAXABLE_INCOME]!, 40600);
    near(r[TO.ORD_TAXABLE]!, 4600);
    near(r[TO.ORD_TAX]!, 460.0);
    near(r[TO.PREF_AT_0]!, 36000);
    near(r[TO.TOTAL]!, 460.0);
  });

  it("HC-T13 2029 (senior deduction expired; 2027 thresholds unindexed), joint, both 68, ordinary 100,000: 7,096.00", () => {
    // Zero inflation keeps the 2027 amounts; current_law sets the senior deduction to 0 from 2029.
    const t = pathTables(data, { startYear: 2027, years: 3, inflation: 0 });
    const r = taxOn(t, 2029, J, taxInput({ OTHER_ORD: 100000, N_AGED: 2 }));
    expect(r[TO.SENIOR_DEDUCTION]).toBe(0);
    near(r[TO.TAXABLE_INCOME]!, 63400);
    near(r[TO.TOTAL]!, 7096.0);
    // The same through the cents wrapper at an index factor of 1.
    const c = computeFederalTax({ year: 2029, filingStatus: "married_joint", ages: [68, 68], otherOrdinaryCents: 10000000n });
    expect(c.dataStatus).toBe("indexed");
    expect(c.detail.totalFederalCents).toBe(709600n);
  });

  it("HC-T14 the tax at a threshold equals the amount printed in the revenue procedure", () => {
    // Taxable income exactly at the bound: wages = bound + the standard deduction.
    const cases: Array<[2026 | 2027, 0 | 1, number, number]> = [
      [2026, J, 211400, 35932],
      [2026, J, 768700, 206583.5],
      [2026, S, 640600, 192979.25],
      [2027, J, 104050, 11974],
      [2027, J, 793650, 213290.5],
      [2027, S, 661375, 199237.75],
    ];
    for (const [year, status, bound, printed] of cases) {
      const std = data.years.get(year)!.standardDeduction[status === S ? "single" : "mfj"];
      const r = tax(year, status, { WAGES: bound + std });
      near(r[TO.TAXABLE_INCOME]!, bound);
      near(r[TO.TOTAL]!, printed, `${year} ${status} ${bound}`);
    }
  });

  it("HC-T16 the additional taxes: 10% of 16,737.50 is 1,673.75; 20% of 10,000 is 2,000.00; 2027 single 57 with 50,000 early is 3,752.00 + 5,000.00", () => {
    // The penalty bases are set directly here; penalties.ts (step 8) derives them from ages and accounts.
    near(tax(2026, S, { TRAD_DIST: 16737.5, PEN10_BASE: 16737.5 })[TO.PEN10]!, 1673.75);
    near(tax(2026, S, { HSA_TAXABLE: 10000, PEN20_BASE: 10000 })[TO.PEN20]!, 2000.0);
    // Taxable 50,000 − 16,600 = 33,400; 1,280 + 12% × 20,600 = 3,752.00; plus 10% × 50,000.
    const r = tax(2027, S, { TRAD_DIST: 50000, PEN10_BASE: 50000 });
    near(r[TO.INCOME_TAX]!, 3752.0);
    near(r[TO.PEN10]!, 5000.0);
    near(r[TO.TOTAL]!, 8752.0);
  });
});

describe("K9 the cents boundary (computeFederalTax)", () => {
  it("K9 computeFederalTax on D1 returns 403750n, on C9(b) 1239362n, on D7 812306n", () => {
    const d1 = computeFederalTax({ year: 2026, filingStatus: "single", ages: [50], wagesCents: 4000000n, ordinaryDividendsCents: 500000n, qualifiedDividendsCents: 500000n, longTermGainCents: 3000000n });
    expect(d1.detail.totalFederalCents).toBe(403750n);
    const c9b = computeFederalTax({ year: 2026, filingStatus: "single", ages: [70], socialSecurityCents: 6000000n, traditionalDistributionsCents: 5500000n });
    expect(c9b.detail.totalFederalCents).toBe(1239362n);
    expect(c9b.marginalOrdinaryRate).toBeCloseTo(0.43142, 6);
    expect(c9b.marginalGainRate).toBeCloseTo(0.36142, 6);
    const d7 = computeFederalTax({
      year: 2027,
      filingStatus: "married_joint",
      ages: [74, 72],
      traditionalDistributionsCents: 4705882n,
      pensionCents: 1800000n,
      socialSecurityCents: 6200000n,
      ordinaryDividendsCents: 630000n,
      qualifiedDividendsCents: 600000n,
      taxableInterestCents: 250000n,
      longTermGainCents: 900000n,
    });
    expect(d7.detail.totalFederalCents).toBe(812306n);
    expect(d7.roomInBracketCents).toBe(3209118n);
    expect(d7.roomAtZeroGainsCents).toBe(1514118n);
  });

  it("K9 toCents: 20,325.2032… is 2032520n, 1.005 is 101n, −1,234.565 is −123457n (units.ts, C38)", () => {
    expect(dollarsToCentsBigInt(20325.2032)).toBe(2032520n);
    expect(dollarsToCentsBigInt(1.005)).toBe(101n);
    expect(dollarsToCentsBigInt(-1234.565)).toBe(-123457n);
  });

  it("computeFederalTax: B1 in cents, the published status, null room in the top bracket, the worksheet lines", () => {
    const b1 = computeFederalTax({ year: 2026, filingStatus: "single", ages: [40], wagesCents: 10000000n });
    expect(b1.dataVersion).toBe(data.dataVersion);
    expect(b1.dataStatus).toBe("published");
    expect(b1.detail.totalFederalCents).toBe(1317000n);
    expect(b1.detail.taxableIncomeCents).toBe(8390000n);
    expect(b1.detail.bracketRateBp).toBe(2200);
    expect(b1.detail.filingStatus).toBe("single");
    expect(b1.roomInBracketCents).toBe(2180000n);
    expect(b1.unusedDeductionCents).toBe(0n);
    expect(b1.marginalOrdinaryRate).toBeCloseTo(0.22, 9);
    const line = (form: string, ln: string) => b1.lines.find((l) => l.form === form && l.line === ln)?.cents;
    expect(line("Form 1040", "16")).toBe(1317000n);
    expect(line("QDCG Tax Worksheet", "5")).toBe(8390000n);
    const b10 = computeFederalTax({ year: 2027, filingStatus: "single", ages: [40], wagesCents: 80000000n });
    expect(b10.detail.totalFederalCents).toBe(24438700n);
    expect(b10.roomInBracketCents).toBeNull();
  });

  it("computeFederalTax: indexed years use the factor, rule sets apply, bad input is refused", () => {
    // 2028 at F = 1.03 (J1's row): single wages 100,000 gives J1 (a)'s 12,628.00.
    expect(computeFederalTax({ year: 2028, filingStatus: "single", ages: [40], indexFactor: 1.03, wagesCents: 10000000n }).detail.totalFederalCents).toBe(1262800n);
    // J1 (b)/(c) at F = 1.05575: 5,640.00 under current law, 4,200.00 with the senior deduction kept.
    const j1b = { year: 2029, filingStatus: "married_joint" as const, ages: [70, 70], indexFactor: 1.05575, pensionCents: 9000000n };
    expect(computeFederalTax(j1b).detail.totalFederalCents).toBe(564000n);
    expect(computeFederalTax({ ...j1b, ruleSetId: "senior_deduction_permanent" }).detail.totalFederalCents).toBe(420000n);

    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e as { code?: string };
      }
      throw new Error("no throw");
    };
    expect(err(() => computeFederalTax({ year: 2026, filingStatus: "single", ages: [40], ordinaryDividendsCents: 100n, qualifiedDividendsCents: 200n })).code).toBe("qualified_exceeds_ordinary");
    expect(err(() => computeFederalTax({ year: 2026, filingStatus: "married_joint", ages: [40] })).code).toBe("tax_input_invalid");
    expect(err(() => computeFederalTax({ year: 2025, filingStatus: "single", ages: [40] }))).toBeInstanceOf(TaxInputError);
    const unknown = err(() => computeFederalTax({ year: 2026, filingStatus: "single", ages: [40], ruleSetId: "no_such_rules" }));
    expect(unknown).toBeInstanceOf(TaxDataError);
    expect(unknown.code).toBe("unknown_rule_set");
  });
});

describe("taxYearDetail (seams C37)", () => {
  it("is a valid TaxYearDetail whose parts add up to their totals in cents", () => {
    for (const [year, status, fields, payroll] of [
      [2026, J, { SS_GROSS: 48000, PENSION: 20000, TRAD_DIST: 40000, INTEREST: 3000, ORD_DIV: 8000, QUAL_DIV: 6000, LT_GAIN: 12000, N_AGED: 2 }, 0],
      [2026, S, { WAGES: 500000, LT_GAIN: 100000, PEN10_BASE: 1234.567, TRAD_DIST: 1234.567 }, 22950.333],
      [2027, J, { TRAD_DIST: 1200000 / 25.5, PENSION: 18000, SS_GROSS: 62000, ORD_DIV: 6300, QUAL_DIV: 6000, INTEREST: 2500, LT_GAIN: 9000, N_AGED: 2 }, 0],
    ] as const) {
      const x = taxInput(fields);
      const r = tax(year, status, fields);
      const d = TaxYearDetail.parse(taxYearDetail(x, r, status, payroll));
      const n = (s: string) => BigInt(s);
      expect(n(d.incomeTaxCents)).toBe(n(d.ordinaryTaxCents) + n(d.capitalGainsTaxCents));
      expect(n(d.totalFederalCents)).toBe(n(d.incomeTaxCents) + n(d.niitCents) + n(d.earlyPenaltyCents) + n(d.hsaPenaltyCents));
      expect(n(d.taxableIncomeCents)).toBe(n(d.ordinaryTaxableCents) + n(d.gainsAt0Cents) + n(d.gainsAt15Cents) + n(d.gainsAt20Cents));
      expect(d.totalFederalCents).toBe(dollarsToCentsBigInt(r[TO.TOTAL]!).toString());
      expect(d.payrollTaxCents).toBe(dollarsToCentsBigInt(payroll).toString());
      expect(d.filingStatus).toBe(status === S ? "single" : "married_joint");
    }
    const c6 = taxYearDetailCents(tax(2026, J, { SS_GROSS: 48000, PENSION: 20000, TRAD_DIST: 40000, INTEREST: 3000, ORD_DIV: 8000, QUAL_DIV: 6000, LT_GAIN: 12000, N_AGED: 2 }), J, 0);
    expect([c6.totalFederalCents, c6.agiCents, c6.magiAcaCents, c6.bracketRateBp, c6.nextGainRateBp]).toEqual([650000n, 12380000n, 13100000n, 1200, 0]);
  });
});

describe("assertTaxInput (tests and previews only)", () => {
  it("accepts a valid record and refuses negative amounts, non-finite slots, qualified above ordinary, a bad N_AGED or f", () => {
    expect(() => assertTaxInput(taxInput({ WAGES: 1, ST_GAIN: -5, LT_GAIN: -5, N_AGED: 2, YEAR_FRACTION: 0.25 }))).not.toThrow();
    const code = (fields: Partial<Record<TaxInputName, number>>) => {
      try {
        assertTaxInput(taxInput(fields));
      } catch (e) {
        return (e as TaxInputError).code;
      }
      return "ok";
    };
    expect(code({ WAGES: -1 })).toBe("tax_input_invalid");
    expect(code({ LOSS_CARRY_IN: -1 })).toBe("tax_input_invalid");
    expect(code({ INTEREST: Number.NaN })).toBe("tax_input_invalid");
    expect(code({ ORD_DIV: 10, QUAL_DIV: 11 })).toBe("qualified_exceeds_ordinary");
    expect(code({ N_AGED: 3 })).toBe("tax_input_invalid");
    expect(code({ N_AGED: 0.5 })).toBe("tax_input_invalid");
    expect(code({ YEAR_FRACTION: 1.5 })).toBe("tax_input_invalid");
    expect(() => assertTaxInput(new Float64Array(TI.YEAR_FRACTION))).toThrow(TaxInputError);
  });
});
