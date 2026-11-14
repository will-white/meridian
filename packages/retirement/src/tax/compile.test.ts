import { describe, expect, it } from "vitest";
import {
  compileTaxLaw,
  fillPathTables,
  indexFloorIncrease,
  indexNearest,
  MODE_FIXED,
  MODE_FLOOR_INCREASE,
  MODE_NEAREST,
  MODE_WAGE,
} from "./compile.js";
import { N_BRACKETS, PR, PROG_REC, progOffset, RB, RB_REC, SO, SO_REC, SS, SS_REC, TAX_IN, TAX_OUT, TAX_REC, taxOffset, TI, TO, TR, WN, WN_REC } from "./layout.js";
import { loadTaxData, rawTaxData, TaxDataError, validateTaxData } from "./taxData.js";
import { dataWithLawChanges, pathTables, taxInput, taxOn } from "./testKit.js";

// tax-rmd-ss §2.8 and §3.2; tests J1, J2, J4 to J8, K5, K7 (§7 J, K) and HC-T15 re-derived
// (strategies-outputs-web §7.5, seams §10). Amounts with cents are asserted within 0.005
// (tax-rmd-ss decision 50); table entries and whole amounts exactly.

const data = loadTaxData();
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(0.005);

const S = 0;
const J = 1;
/** One record's slot for a calendar year on filled tables. */
const at = (t: { law: { startYear: number }; tax: Float64Array }, year: number, status: 0 | 1, slot: number) => t.tax[taxOffset(year - t.law.startYear, status) + slot]!;
const prog = (t: { law: { startYear: number }; prog: Float64Array }, year: number, slot: number) => t.prog[progOffset(year - t.law.startYear) + slot]!;
/** Bracket thresholds 1 to 6 of a record. */
const thresholds = (t: Parameters<typeof at>[0], year: number, status: 0 | 1) => Array.from({ length: 6 }, (_, k) => at(t, year, status, TR.THR0 + 1 + k));

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("layout.ts (tax-rmd-ss §2.8)", () => {
  it("the record sizes and the bracket slots are as designed", () => {
    expect([TAX_REC, PROG_REC, TAX_IN, TAX_OUT, RB_REC, SS_REC, SO_REC, WN_REC]).toEqual([48, 24, 24, 32, 8, 16, 10, 8]);
    expect([TR.STD, TR.LTCG0, TR.NIIT_THRESHOLD, TR.SS_BASE1, TR.LOSS_LIMIT, TR.PEN_EARLY_RATE, TR.N_BRACKETS, TR.THR0, TR.RATE0, TR.BASE0]).toEqual([0, 5, 9, 11, 16, 17, 19, 20, 28, 36]);
    expect([PR.COLA, PR.SS_SCALE, PR.WAGE_BASE, PR.DEFERRAL, PR.HSA_CATCHUP, PR.ADDL_MEDICARE_THR_MFJ, PR.CPI_FACTOR, PR.WAGE_FACTOR]).toEqual([0, 1, 4, 5, 13, 18, 19, 20]);
    expect([TI.WAGES, TI.SS_GROSS, TI.ADJUSTMENTS, TI.PEN10_BASE, TI.N_AGED, TI.YEAR_FRACTION]).toEqual([0, 13, 17, 18, 20, 21]);
    expect([TO.TOTAL, TO.AGI, TO.PROVISIONAL, TO.LOSS_CARRY_OUT, TO.ROOM_IN_BRACKET, TO.MAGI_ACA, TO.UNUSED_DEDUCTION]).toEqual([0, 7, 11, 18, 22, 25, 28]);
    expect([RB.BASIS_FREE, RB.CONV0, RB.CONV4, RB.FIRST_YEAR, SS.PIA, SS.DECEASED_FACTOR, SO.WITHHELD, SO.MONTHS_PAID, WN.CONTRIBUTION_CAPPED]).toEqual([0, 1, 5, 6, 0, 8, 6, 8, 3]);
    expect(TR.THR0 + N_BRACKETS).toBeLessThan(TR.RATE0);
    expect(TR.BASE0 + N_BRACKETS).toBeLessThan(TR.RESERVED0);
    // taxOffset(i, s) = (i × 2 + s) × 48; progOffset(i) = i × 24.
    expect([taxOffset(0, 0), taxOffset(0, 1), taxOffset(3, 1), progOffset(3)]).toEqual([0, 48, 336, 72]);
  });

  it("slot names within each record are distinct", () => {
    for (const layout of [TR, PR, TI, TO]) {
      const slots = Object.values(layout);
      expect(new Set(slots).size).toBe(slots.length);
    }
  });
});

describe("compileTaxLaw and fillPathTables: published years (tax-rmd-ss §3.2)", () => {
  const t = pathTables(data, { startYear: 2026, years: 2 });

  it("a published year is copied verbatim, with the +Infinity sentinel and every slot fixed", () => {
    for (const year of [2026, 2027]) {
      const y = data.years.get(year)!;
      for (const [s, key] of [[S, "single"], [J, "mfj"]] as const) {
        expect(Array.from({ length: 7 }, (_, k) => at(t, year, s, TR.THR0 + k))).toEqual(y.ordinary.thresholds[key]);
        expect(Array.from({ length: 7 }, (_, k) => at(t, year, s, TR.RATE0 + k))).toEqual(y.ordinary.rates);
        expect(at(t, year, s, TR.THR0 + 7)).toBe(Infinity);
        expect(at(t, year, s, TR.STD)).toBe(y.standardDeduction[key]);
        expect(at(t, year, s, TR.AGED)).toBe(y.additionalAged[key]);
        expect(at(t, year, s, TR.LTCG0)).toBe(y.capitalGains.zeroRateMax[key]);
        expect(at(t, year, s, TR.LTCG15)).toBe(y.capitalGains.fifteenRateMax[key]);
        expect(at(t, year, s, TR.NIIT_THRESHOLD)).toBe(y.niit.threshold[key]);
        expect(at(t, year, s, TR.SENIOR_START)).toBe(y.seniorDeduction.phaseoutStart[key]);
        expect(at(t, year, s, TR.N_BRACKETS)).toBe(7);
      }
    }
    expect(t.law.taxMode.every((m) => m === MODE_FIXED)).toBe(true);
    expect(t.law.progMode.every((m) => m === MODE_FIXED)).toBe(true);
    expect([prog(t, 2026, PR.COLA), prog(t, 2027, PR.COLA)]).toEqual([0.028, 0.036]);
    expect([prog(t, 2026, PR.WAGE_BASE), prog(t, 2027, PR.WAGE_BASE)]).toEqual([184500, 192300]);
    expect([prog(t, 2027, PR.CPI_FACTOR), prog(t, 2027, PR.WAGE_FACTOR), prog(t, 2027, PR.SS_SCALE)]).toEqual([1, 1, 1]);
  });

  it("HC-T14 / A2 the tax at each bracket bound equals the cumulative amount the revenue procedure prints", () => {
    // Rev. Proc. 2025-32 §4.01 and Rev. Proc. 2026-35 §3.01 (tax-rmd-ss §2.2 table).
    const printed = {
      2026: { single: [1240, 5800, 17966, 41024, 58448, 192979.25], mfj: [2480, 11600, 35932, 82048, 116896, 206583.5] },
      2027: { single: [1280, 5987, 18549, 42357, 60349, 199237.75], mfj: [2560, 11974, 37098, 84714, 120698, 213290.5] },
    } as const;
    for (const year of [2026, 2027] as const) {
      for (const [s, key] of [[S, "single"], [J, "mfj"]] as const) {
        expect(at(t, year, s, TR.BASE0)).toBe(0);
        printed[year][key].forEach((amount, k) => near(at(t, year, s, TR.BASE0 + 1 + k), amount));
      }
    }
  });
});

describe("J1 forward indexing: +3.0% in 2027, +2.5% in 2028, -1.0% in 2029", () => {
  // F_2028 = 1.03, F_2029 = 1.03 × 1.025 = 1.05575, F_2030 = 1.05575 × 0.99 = 1.0451925 (tax-rmd-ss §3.2).
  const t = pathTables(data, { startYear: 2027, years: 4, inflation: [0.03, 0.025, -0.01, 0] });
  const tPermanent = pathTables(data, { startYear: 2027, years: 4, inflation: [0.03, 0.025, -0.01, 0], ruleSetId: "senior_deduction_permanent" });

  it("J1 the factors", () => {
    expect(prog(t, 2027, PR.CPI_FACTOR)).toBe(1);
    expect(prog(t, 2028, PR.CPI_FACTOR)).toBeCloseTo(1.03, 12);
    expect(prog(t, 2029, PR.CPI_FACTOR)).toBeCloseTo(1.05575, 12);
    expect(prog(t, 2030, PR.CPI_FACTOR)).toBeCloseTo(1.0451925, 12);
    expect(prog(t, 2030, PR.WAGE_FACTOR)).toBeCloseTo(1.0451925, 12);
  });

  it("J1 the 2028, 2029 and 2030 rows of the design's table", () => {
    // tax-rmd-ss §7 J1 (also reproduced from the data file by data.test.ts).
    const rows = {
      2028: { single: [13175, 53575, 112375, 214550, 272475, 681200], mfj: [26350, 107150, 224750, 429100, 544950, 817450], std: [17050, 34100], aged: [2150, 1750], zero: [52575, 105150], fifteen: [580050, 652600] },
      2029: { single: [13500, 54925, 115200, 219925, 279275, 698225], mfj: [27000, 109850, 230400, 439850, 558550, 837850], std: [17500, 35000], aged: [2200, 1750], zero: [53875, 107750], fifteen: [594550, 668900] },
      2030: { single: [13375, 54375, 114050, 217725, 276500, 691250], mfj: [26750, 108750, 228100, 435450, 553000, 829500], std: [17350, 34700], aged: [2150, 1750], zero: [53350, 106700], fifteen: [588650, 662200] },
    } as const;
    for (const year of [2028, 2029, 2030] as const) {
      const row = rows[year];
      expect(thresholds(t, year, S), `${year} single`).toEqual(row.single);
      expect(thresholds(t, year, J), `${year} joint`).toEqual(row.mfj);
      expect([at(t, year, S, TR.STD), at(t, year, J, TR.STD)]).toEqual(row.std);
      expect([at(t, year, S, TR.AGED), at(t, year, J, TR.AGED)]).toEqual(row.aged);
      expect([at(t, year, S, TR.LTCG0), at(t, year, J, TR.LTCG0)]).toEqual(row.zero);
      expect([at(t, year, S, TR.LTCG15), at(t, year, J, TR.LTCG15)]).toEqual(row.fifteen);
    }
  });

  it("J1 the NIIT thresholds, the Social Security bases, the loss limit and the senior deduction are the same in every year", () => {
    for (const year of [2027, 2028, 2029, 2030]) {
      expect([at(t, year, S, TR.NIIT_THRESHOLD), at(t, year, J, TR.NIIT_THRESHOLD)]).toEqual([200000, 250000]);
      expect([at(t, year, S, TR.SS_BASE1), at(t, year, S, TR.SS_BASE2), at(t, year, J, TR.SS_BASE1), at(t, year, J, TR.SS_BASE2)]).toEqual([25000, 34000, 32000, 44000]);
      expect(at(t, year, J, TR.LOSS_LIMIT)).toBe(3000);
      expect([at(t, year, S, TR.SENIOR_START), at(t, year, J, TR.SENIOR_START), at(tPermanent, year, J, TR.SENIOR_AMT)]).toEqual([75000, 150000, 6000]);
    }
    // current_law: the senior deduction ends after 2028 (senior_deduction_sunset, nominal 0 from 2029).
    expect([2027, 2028, 2029, 2030].map((y) => at(t, y, J, TR.SENIOR_AMT))).toEqual([6000, 6000, 0, 0]);
  });

  it("J1 (a) single, 40, 2028, wages 100,000: 12,628.00", () => {
    // Taxable 100,000 − 17,050 = 82,950; tax at 53,575 is 1,317.50 + 12% × 40,400 = 6,165.50; plus 22% × 29,375.
    const r = taxOn(t, 2028, S, taxInput({ WAGES: 100000 }));
    near(r[TO.TAXABLE_INCOME]!, 82950);
    near(r[TO.TOTAL]!, 12628.0);
  });

  it("J1 (b) joint, both 70, 2029, pension 90,000, current_law: 5,640.00", () => {
    // Standard 35,000 + 2 × 1,750 = 38,500; senior 0 (expired); taxable 51,500; 2,700 + 12% × 24,500.
    const r = taxOn(t, 2029, J, taxInput({ PENSION: 90000, N_AGED: 2 }));
    near(r[TO.STD_DEDUCTION]!, 38500);
    expect(r[TO.SENIOR_DEDUCTION]).toBe(0);
    near(r[TO.TOTAL]!, 5640.0);
  });

  it("J1 (c) the same under senior_deduction_permanent: 4,200.00", () => {
    // Senior 2 × 6,000; taxable 39,500; 2,700 + 12% × 12,500.
    const r = taxOn(tPermanent, 2029, J, taxInput({ PENSION: 90000, N_AGED: 2 }));
    near(r[TO.SENIOR_DEDUCTION]!, 12000);
    near(r[TO.TOTAL]!, 4200.0);
  });

  it("J1 (d) single, 68, 2030, pension 40,000, qualified dividends 5,000, long-term gain 20,000: 2,192.50", () => {
    // AGI 65,000; standard 17,350 + 2,150 = 19,500; senior 0; taxable 45,500; ordinary 20,500; all 25,000 at 0%;
    // 1,337.50 + 12% × 7,125.
    const r = taxOn(t, 2030, S, taxInput({ PENSION: 40000, ORD_DIV: 5000, QUAL_DIV: 5000, LT_GAIN: 20000, N_AGED: 1 }));
    near(r[TO.TAXABLE_INCOME]!, 45500);
    near(r[TO.PREF_AT_0]!, 25000);
    near(r[TO.TOTAL]!, 2192.5);
  });
});

describe("J2 limits and program amounts on the J1 factors, from the 2027 file", () => {
  const t = pathTables(data, { startYear: 2027, years: 4, inflation: [0.03, 0.025, -0.01, 0] });
  const cases: Array<[string, number, [number, number, number]]> = [
    // The 2027 bases are Notice 2026-66's. F = 1.03, 1.05575, 1.0451925; floor increase
    // v = base + floor(base × (F − 1) / step) × step:
    // deferral 25,500, step 500: 765 → 1 step, 1,421.6 → 2, 1,152.4 → 2: 26,000 / 26,500 / 26,500.
    ["deferral (25,500)", PR.DEFERRAL, [26000, 26500, 26500]],
    // 8,500: 255, 473.9, 384.1 → no step.
    ["catch-up at 50 (8,500)", PR.CATCHUP50, [8500, 8500, 8500]],
    // 11,750: 352.5 → 0, 655.1 → 1, 531.0 → 1: 11,750 / 12,250 / 12,250.
    ["catch-up at 60 to 63 (11,750)", PR.CATCHUP6063, [11750, 12250, 12250]],
    // 75,000, step 1,000: 2,250 → 2, 4,181.3 → 4, 3,389.4 → 3: 77,000 / 79,000 / 78,000.
    ["annual additions (75,000)", PR.ANNUAL_ADD, [77000, 79000, 78000]],
    ["IRA (7,500)", PR.IRA, [7500, 7500, 7500]],
    ["IRA catch-up (1,100)", PR.IRA_CATCHUP, [1100, 1100, 1100]],
    ["HSA self-only (4,500), nearest $50", PR.HSA_SELF, [4650, 4750, 4700]],
    ["HSA family (9,000), nearest $50", PR.HSA_FAMILY, [9250, 9500, 9400]],
    ["wage base (192,300), nearest $300", PR.WAGE_BASE, [198000, 203100, 201000]],
    ["earnings test under FRA (25,560), nearest $120", PR.ET_UNDER, [26280, 27000, 26760]],
    ["earnings test, FRA year (67,920), nearest $120", PR.ET_FRA, [69960, 71760, 71040]],
  ];
  for (const [label, slot, expected] of cases) {
    it(`J2 ${label}`, () => {
      expect([2028, 2029, 2030].map((y) => prog(t, y, slot))).toEqual(expected);
    });
  }

  it("J2 the HSA catch-up, the payroll rates and the Additional Medicare thresholds are not indexed", () => {
    for (const y of [2028, 2029, 2030]) {
      expect([prog(t, y, PR.HSA_CATCHUP), prog(t, y, PR.OASDI_RATE), prog(t, y, PR.MEDICARE_RATE), prog(t, y, PR.ADDL_MEDICARE_RATE)]).toEqual([1000, 0.062, 0.0145, 0.009]);
      expect([prog(t, y, PR.ADDL_MEDICARE_THR_SINGLE), prog(t, y, PR.ADDL_MEDICARE_THR_MFJ)]).toEqual([200000, 250000]);
    }
  });

  it("J2 the modes follow tax/rules.json: floor increases on the price index, the wage base and earnings test to the nearest step on the wage index", () => {
    const o = progOffset(1);
    expect(t.law.progMode[o + PR.DEFERRAL]).toBe(MODE_FLOOR_INCREASE);
    expect(t.law.progMode[o + PR.HSA_SELF]).toBe(MODE_NEAREST);
    expect(t.law.progMode[o + PR.WAGE_BASE]).toBe(MODE_NEAREST | MODE_WAGE);
    expect(t.law.progMode[o + PR.ET_FRA]).toBe(MODE_NEAREST | MODE_WAGE);
    expect(t.law.progMode[o + PR.HSA_CATCHUP]).toBe(MODE_FIXED);
    expect([t.law.progStep[o + PR.ANNUAL_ADD], t.law.progStep[o + PR.WAGE_BASE], t.law.progStep[o + PR.ET_UNDER]]).toEqual([1000, 300, 120]);
  });

  it("J2 realWageGrowth moves the wage-indexed amounts only", () => {
    // W_2028 = 1 + 0.03 + 0.01 = 1.04: wage base 192,300 × 1.04 = 199,992; 199,992 / 300 = 666.64;
    // floor(666.64 + 0.5) = 667; 667 × 300 = 200,100. The deferral stays on F: 25,500 + floor(25,500 ×
    // 0.03 / 500) × 500 = 25,500 + 1 × 500 = 26,000 (Notice 2026-66's 2027 base).
    const w = pathTables(data, { startYear: 2027, years: 2, inflation: [0.03, 0], fill: { realWageGrowth: 0.01 } });
    expect(prog(w, 2028, PR.WAGE_FACTOR)).toBeCloseTo(1.04, 12);
    expect(prog(w, 2028, PR.WAGE_BASE)).toBe(200100);
    expect(prog(w, 2028, PR.DEFERRAL)).toBe(26000);
  });
});

describe("HC-T15 indexing after the last published year (re-derived, seams §10)", () => {
  it("HC-T15 2028 at 2.5% inflation: the joint standard deduction with two aged additions is 37,400.00", () => {
    // Standard deduction: 33,200 + floor(33,200 × 0.025 / 100 + 1e−9) × 100 = 33,200 + floor(8.3) × 100 = 34,000.
    // Aged addition: 1,700 + floor(1,700 × 0.025 / 50 + 1e−9) × 50 = 1,700 + floor(0.85) × 50 = 1,700.
    // Total 34,000 + 2 × 1,700 = 37,400.00 (packages/retirement/reference/sheets/hand-cases.md). The superseded
    // 37,515.00 multiplied the 2027 total by the price level unrounded (36,600 × 1.025), which C22 withdrew.
    const t = pathTables(data, { startYear: 2027, years: 2, inflation: [0.025, 0] });
    expect(at(t, 2028, J, TR.STD)).toBe(34000);
    expect(at(t, 2028, J, TR.AGED)).toBe(1700);
    const r = taxOn(t, 2028, J, taxInput({ PENSION: 100000, N_AGED: 2 }));
    near(r[TO.STD_DEDUCTION]!, 37400.0);
    // The same year's first joint bracket ends at 25,600 + floor(640 / 50) × 50 = 26,200 (was 26,240.00 unrounded).
    expect(at(t, 2028, J, TR.THR0 + 1)).toBe(26200);
  });
});

describe("§3.9.6 the COLA written into the program table", () => {
  it("published through 2027; then path inflation rounded to 0.1%, never negative, against the last level that produced one", () => {
    // P_2027 = 1, H = 1. 2028: P = 1.0244, raw 2.44% → 2.4%, H = 1.0244. 2029: P = 1.0244 × 0.99 = 1.014156,
    // raw −1.0% → 0 (H unchanged). 2030: P = 1.014156 × 1.02 = 1.03443912, raw 1.03443912 / 1.0244 − 1 = 0.98% → 1.0%.
    const t = pathTables(data, { startYear: 2026, years: 5, inflation: [0.05, 0.0244, -0.01, 0.02, 0] });
    expect([2026, 2027, 2028, 2029, 2030].map((y) => prog(t, y, PR.COLA))).toEqual([0.028, 0.036, 0.024, 0, 0.01]);
  });

  it("a plan starting after the data runs the stale years first: 2.5% for 2028 and 2029", () => {
    const t = pathTables(data, { startYear: 2029, years: 2, inflation: [0.031, 0] });
    // 2029: P_2028 = 1.025 (cola 2.5%, H = 1.025), P_2029 = 1.025² → 2.5%. 2030: π(2029) = 3.1% → 3.1%.
    expect([prog(t, 2029, PR.COLA), prog(t, 2030, PR.COLA)]).toEqual([0.025, 0.031]);
  });
});

describe("SS_SCALE: law changes and the plan's adjustment", () => {
  it("ss_shortfall_2033 pays 78% from 2033; ssAdjustment multiplies from its year", () => {
    const t = pathTables(data, { startYear: 2030, years: 5, ruleSetId: "ss_shortfall_2033", ssAdjustment: { fromYear: 2031, factor: 0.9 } });
    const scale = [2030, 2031, 2032, 2033, 2034].map((y) => prog(t, y, PR.SS_SCALE));
    expect(scale[0]).toBe(1);
    expect(scale[1]).toBe(0.9);
    expect(scale[2]).toBe(0.9);
    expect(scale[3]).toBeCloseTo(0.78 * 0.9, 15);
    expect(scale[4]).toBeCloseTo(0.702, 15);
  });
});

describe("J4 law changes", () => {
  it("J4 (a) rates_plus_2pts_2031: 2030 keeps the published rates, 2031 has 0.12 to 0.39", () => {
    const t = pathTables(data, { startYear: 2026, years: 6, ruleSetId: "rates_plus_2pts_2031" });
    const rates = (y: number) => Array.from({ length: 7 }, (_, k) => at(t, y, J, TR.RATE0 + k));
    expect(rates(2030)).toEqual([0.1, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37]);
    rates(2031).forEach((r, k) => expect(r).toBeCloseTo([0.12, 0.14, 0.24, 0.26, 0.34, 0.37, 0.39][k]!, 12));
    expect([at(t, 2031, J, TR.LTCG_RATE1), at(t, 2031, J, TR.LTCG_RATE2)]).toEqual([0.15, 0.2]);
  });

  it("J4 (a) a fixture shifting from 2026: joint wages 180,000 gives 24,896.00 and D1 gives 4,515.50 (the gains rates do not move)", () => {
    const fx = dataWithLawChanges(
      { shift_2026: { label: "Fixture", illustrative: true, description: "Every ordinary rate 2 points higher from 2026.", ops: [{ op: "shiftOrdinaryRates", fromYear: 2026, delta: 0.02 }] } },
      [{ id: "shift_2026_fixture", label: "Fixture", lawChanges: ["shift_2026"] }],
    );
    const t = pathTables(fx, { startYear: 2026, years: 1, ruleSetId: "shift_2026_fixture" });
    // B2 is 21,940 on taxable 147,800; every rate 2 points higher adds 2% × 147,800 = 2,956.
    near(taxOn(t, 2026, J, taxInput({ WAGES: 180000 }))[TO.TOTAL]!, 24896.0);
    // D1: ordinary 23,900 = 12% × 12,400 + 14% × 11,500; gains 15% × 9,450 = 1,417.50 (the 0% band takes 25,550).
    near(taxOn(t, 2026, S, taxInput({ WAGES: 40000, ORD_DIV: 5000, QUAL_DIV: 5000, LT_GAIN: 30000 }))[TO.TOTAL]!, 4515.5);
  });

  it("J4 (b) freezeIndexing 2028 to 2030 with 3% a year: 2028 to 2030 equal 2027, and 2031 has F = 1.03", () => {
    const fx = dataWithLawChanges(
      { freeze_fixture: { label: "Fixture", illustrative: true, description: "No indexing 2028 to 2030.", ops: [{ op: "freezeIndexing", fromYear: 2028, toYear: 2030 }] } },
      [{ id: "freeze_fixture", label: "Fixture", lawChanges: ["freeze_fixture"] }],
    );
    const t = pathTables(fx, { startYear: 2027, years: 5, ruleSetId: "freeze_fixture", inflation: 0.03 });
    const record = (y: number, s: 0 | 1) => Array.from(t.tax.subarray(taxOffset(y - 2027, s), taxOffset(y - 2027, s) + TAX_REC));
    for (const y of [2028, 2029, 2030]) {
      expect(record(y, J), String(y)).toEqual(record(2027, J));
      expect(record(y, S), String(y)).toEqual(record(2027, S));
      expect(prog(t, y, PR.CPI_FACTOR)).toBe(1);
    }
    expect(Array.from(t.law.frozen)).toEqual([0, 1, 1, 1, 0]);
    expect(prog(t, 2031, PR.CPI_FACTOR)).toBeCloseTo(1.03, 12);
    expect([at(t, 2031, J, TR.THR0 + 1), at(t, 2031, J, TR.THR0 + 2), at(t, 2031, J, TR.STD)]).toEqual([26350, 107150, 34100]);
    // The wage index is not frozen: W_2031 = 1.03^4.
    expect(prog(t, 2031, PR.WAGE_FACTOR)).toBeCloseTo(1.03 * 1.03 * 1.03 * 1.03, 12);

    // A freeze before a late start: plan from 2030, 2028 frozen. F_2028 = 1 (frozen), F_2029 = 1.025 (π(2028) is the
    // stale 2.5%), F_2030 = 1.025 × 1.025 = 1.050625 (π(2029) stale too), against 1.025³ = 1.076890625 unfrozen.
    const late = dataWithLawChanges(
      { freeze_2028: { label: "Fixture", illustrative: true, description: "No indexing in 2028.", ops: [{ op: "freezeIndexing", fromYear: 2028, toYear: 2028 }] } },
      [{ id: "freeze_2028", label: "Fixture", lawChanges: ["freeze_2028"] }],
    );
    const tl = pathTables(late, { startYear: 2030, years: 1, ruleSetId: "freeze_2028" });
    expect(Array.from(tl.law.preStartFrozen)).toEqual([1, 0]);
    expect(prog(tl, 2030, PR.CPI_FACTOR)).toBeCloseTo(1.050625, 12);
    expect(prog(pathTables(data, { startYear: 2030, years: 1 }), 2030, PR.CPI_FACTOR)).toBeCloseTo(1.076890625, 12);
  });

  it("J4 (c) replaceSchedule from 2027 halving the standard deduction: single, 2027, wages 100,000 gives 14,715.50", () => {
    const fx = dataWithLawChanges(
      {
        half_std_fixture: {
          label: "Fixture",
          illustrative: true,
          description: "Standard deduction halved from 2027.",
          ops: [{ op: "replaceSchedule", fromYear: 2027, table: { standardDeduction: { single: 8300, mfj: 16600 } } }],
        },
      },
      [{ id: "half_std_fixture", label: "Fixture", lawChanges: ["half_std_fixture"] }],
    );
    const t = pathTables(fx, { startYear: 2026, years: 3, ruleSetId: "half_std_fixture", inflation: [0, 0.03, 0] });
    // Taxable 91,700; 5,987 + 22% × 39,675.
    near(taxOn(t, 2027, S, taxInput({ WAGES: 100000 }))[TO.TOTAL]!, 14715.5);
    expect(at(t, 2026, S, TR.STD)).toBe(16100);
    // Indexed like the base: 16,600 + floor(16,600 × 0.03 / 100 + 1e−9) × 100 = 16,600 + 400 = 17,000 joint in 2028.
    expect([at(t, 2028, S, TR.STD), at(t, 2028, J, TR.STD)]).toEqual([8500, 17000]);
  });

  it("J4 (d) setValue capitalGains.netLossLimit to 5,000 from 2030, nominal: 2029 has 3,000 and 2030 has 5,000", () => {
    const fx = dataWithLawChanges(
      {
        loss_fixture: {
          label: "Fixture",
          illustrative: true,
          description: "A larger loss limit from 2030.",
          ops: [{ op: "setValue", path: "capitalGains.netLossLimit", value: 5000, fromYear: 2030, dollars: "nominal" }],
        },
      },
      [{ id: "loss_fixture", label: "Fixture", lawChanges: ["loss_fixture"] }],
    );
    const t = pathTables(fx, { startYear: 2029, years: 2, ruleSetId: "loss_fixture", inflation: 0.03 });
    expect([at(t, 2029, S, TR.LOSS_LIMIT), at(t, 2030, S, TR.LOSS_LIMIT), at(t, 2030, J, TR.LOSS_LIMIT)]).toEqual([3000, 5000, 5000]);
  });

  it("J4 a base-dollar setValue stays indexed, a nominal one does not", () => {
    // Joint standard deduction set to 40,000 from 2028: base → 40,000 + floor(40,000 × 0.03 / 100 + 1e−9) × 100 = 41,200;
    // nominal → 40,000 as written.
    const fx = dataWithLawChanges(
      {
        std_base: { label: "Fixture", illustrative: true, description: "Base dollars.", ops: [{ op: "setValue", path: "standardDeduction", value: { single: 20000, mfj: 40000 }, fromYear: 2028 }] },
        std_nominal: { label: "Fixture", illustrative: true, description: "Nominal.", ops: [{ op: "setValue", path: "standardDeduction", value: { single: 20000, mfj: 40000 }, fromYear: 2028, dollars: "nominal" }] },
      },
      [
        { id: "std_base", label: "Fixture", lawChanges: ["std_base"] },
        { id: "std_nominal", label: "Fixture", lawChanges: ["std_nominal"] },
      ],
    );
    const base = pathTables(fx, { startYear: 2027, years: 2, ruleSetId: "std_base", inflation: 0.03 });
    const nominal = pathTables(fx, { startYear: 2027, years: 2, ruleSetId: "std_nominal", inflation: 0.03 });
    expect([at(base, 2028, S, TR.STD), at(base, 2028, J, TR.STD)]).toEqual([20600, 41200]);
    expect([at(nominal, 2028, S, TR.STD), at(nominal, 2028, J, TR.STD)]).toEqual([20000, 40000]);
  });
});

describe("J5 stale data", () => {
  it("J5 a plan starting in 2029: F_2028 = 1.025, F_2029 = 1.050625, joint 12% threshold 26,850, warning tax_data_stale", () => {
    // 25,600 + floor(25,600 × 0.050625 / 50 + 1e−9) × 50 = 25,600 + floor(25.92) × 50 = 26,850.
    const t = pathTables(data, { startYear: 2029, years: 1 });
    expect(prog(t, 2029, PR.CPI_FACTOR)).toBeCloseTo(1.050625, 12);
    expect(at(t, 2029, J, TR.THR0 + 1)).toBe(26850);
    expect(t.law.warnings.map((w) => w.code)).toContain("tax_data_stale");
    expect(t.law.warnings.find((w) => w.code === "tax_data_stale")!.message).toMatch(/2029.*2027.*2\.5%/);
    expect(t.law.preStartFrozen).toHaveLength(1);
  });

  it("J5 no stale warning when the plan starts in a published year", () => {
    expect(pathTables(data, { startYear: 2027, years: 3 }).law.warnings.map((w) => w.code)).not.toContain("tax_data_stale");
  });
});

describe("compile warnings (tax-rmd-ss §3.11)", () => {
  it("limits_pending names a year's pending fields whenever the plan reaches that year (a fixture: the bundled 2027 file has none since Notice 2026-66)", () => {
    for (const [startYear, years] of [[2026, 1], [2026, 2], [2027, 1]] as const) {
      expect(compileTaxLaw(data, { startYear, years, ruleSetId: "current_law" }).warnings).toEqual([]);
    }
    const six = ["employeeDeferral", "catchUp50", "catchUp60to63", "annualAdditions", "ira", "iraCatchUp50"];
    const raw = structuredClone(rawTaxData());
    (raw.years["tax/federal-2027.json"] as { contributionLimits: { pending: string[] } }).contributionLimits.pending = [...six];
    const pending = validateTaxData(raw);
    expect(compileTaxLaw(pending, { startYear: 2026, years: 1, ruleSetId: "current_law" }).warnings).toEqual([]);
    for (const [startYear, years] of [[2026, 2], [2027, 1], [2030, 3]] as const) {
      const w = compileTaxLaw(pending, { startYear, years, ruleSetId: "current_law" }).warnings.filter((x) => x.code === "limits_pending");
      expect(w).toHaveLength(1);
      expect(w[0]!.message).toContain("2027");
      for (const field of six) expect(w[0]!.message).toContain(field);
    }
  });

  it("rmd_joint_table_unavailable when the joint table is the empty fallback", () => {
    const raw = structuredClone(rawTaxData());
    (raw.joint as { rows: unknown[] }).rows = [];
    const codes = compileTaxLaw(validateTaxData(raw), { startYear: 2026, years: 1, ruleSetId: "current_law" }).warnings.map((w) => w.code);
    expect(codes).toEqual(["rmd_joint_table_unavailable"]);
  });
});

describe("J6 errors", () => {
  it("J6 an unknown rule set id throws TaxDataError('unknown_rule_set')", () => {
    const e = thrown(() => compileTaxLaw(data, { startYear: 2026, years: 3, ruleSetId: "no_such_rules" }));
    expect(e).toBeInstanceOf(TaxDataError);
    expect((e as TaxDataError).code).toBe("unknown_rule_set");
  });

  it("J6 a setValue that makes the thresholds descend throws TaxDataError('law_change_invalid')", () => {
    const fx = dataWithLawChanges(
      {
        descending: {
          label: "Fixture",
          illustrative: true,
          description: "Thresholds out of order from 2029.",
          ops: [
            {
              op: "setValue",
              path: "ordinary.thresholds",
              value: { single: [0, 50000, 40000, 105700, 201775, 256225, 640600], mfj: [0, 24800, 100800, 211400, 403550, 512450, 768700] },
              fromYear: 2029,
            },
          ],
        },
      },
      [{ id: "descending_fixture", label: "Fixture", lawChanges: ["descending"] }],
    );
    // Loads (the loader does not apply law changes); compiling a plan that reaches 2029 refuses.
    expect(compileTaxLaw(fx, { startYear: 2026, years: 3, ruleSetId: "descending_fixture" }).years).toBe(3);
    const e = thrown(() => compileTaxLaw(fx, { startYear: 2026, years: 4, ruleSetId: "descending_fixture" }));
    expect(e).toBeInstanceOf(TaxDataError);
    expect((e as TaxDataError).code).toBe("law_change_invalid");
    expect((e as Error).message).toMatch(/descending_fixture, tax year 2029: ordinary\.thresholds\.single/);
  });

  it("J6 a setValue whose value has the wrong shape, or a 0% gains band taxed, is law_change_invalid", () => {
    const fx = dataWithLawChanges(
      {
        shape: { label: "Fixture", illustrative: true, description: "A number where a pair is needed.", ops: [{ op: "setValue", path: "niit.threshold", value: 100000, fromYear: 2026 }] },
        zero_band: { label: "Fixture", illustrative: true, description: "Taxing the 0% band.", ops: [{ op: "setValue", path: "capitalGains.rates", value: [0.05, 0.15, 0.2], fromYear: 2026 }] },
      },
      [
        { id: "shape_fixture", label: "Fixture", lawChanges: ["shape"] },
        { id: "zero_band_fixture", label: "Fixture", lawChanges: ["zero_band"] },
      ],
    );
    for (const id of ["shape_fixture", "zero_band_fixture"]) {
      const e = thrown(() => compileTaxLaw(fx, { startYear: 2026, years: 1, ruleSetId: id }));
      expect((e as TaxDataError).code, id).toBe("law_change_invalid");
    }
  });

  it("a plan before the first tax year or with no years is a caller fault (RangeError)", () => {
    expect(() => compileTaxLaw(data, { startYear: 2025, years: 3, ruleSetId: "current_law" })).toThrow(RangeError);
    expect(() => compileTaxLaw(data, { startYear: 2026, years: 0, ruleSetId: "current_law" })).toThrow(RangeError);
    const law = compileTaxLaw(data, { startYear: 2026, years: 3, ruleSetId: "current_law" });
    expect(() => fillPathTables(law, new Float64Array(2), { chainedCpiWedge: 0, realWageGrowth: 0 }, new Float64Array(3 * 2 * TAX_REC), new Float64Array(3 * PROG_REC))).toThrow(RangeError);
  });
});

describe("J7 the chained-CPI wedge", () => {
  it("J7 0.0025 on J1's inflation: joint 22% threshold 106,900 in 2028 and 109,300 in 2029; joint standard deduction 34,100 in 2028", () => {
    // F_2028 = 1.03 × 0.9975 = 1.027425: 104,050 + floor(2,853.57 / 50) × 50 = 106,900.
    // F_2029 = 1.027425 × 1.025 × 0.9975 = 1.0504779…: 104,050 + floor(5,252.22 / 50) × 50 = 109,300.
    // Joint standard deduction 2028: 33,200 + floor(910.51 / 100) × 100 = 34,100.
    const t = pathTables(data, { startYear: 2027, years: 3, inflation: [0.03, 0.025, 0], fill: { chainedCpiWedge: 0.0025 } });
    expect(prog(t, 2028, PR.CPI_FACTOR)).toBeCloseTo(1.027425, 12);
    expect([at(t, 2028, J, TR.THR0 + 2), at(t, 2029, J, TR.THR0 + 2)]).toEqual([106900, 109300]);
    expect(at(t, 2028, J, TR.STD)).toBe(34100);
    // The wedge does not touch the wage index.
    expect(prog(t, 2028, PR.WAGE_FACTOR)).toBeCloseTo(1.03, 12);
  });
});

describe("J8 the rounding guard", () => {
  it("J8 base 20,000, factor 1.15, step 50 gives 23,000 (the float quotient is 59.999999999999964)", () => {
    expect((20000 * (1.15 - 1)) / 50).toBe(59.999999999999964);
    expect(Math.floor((20000 * (1.15 - 1)) / 50)).toBe(59);
    expect(indexFloorIncrease(20000, 1.15, 50)).toBe(23000);
  });

  it("nearest rounding: floor(value × factor / step + 0.5) × step", () => {
    // 4,500 × 1.03 = 4,635 → 92.7 + 0.5 → 93 × 50 = 4,650 (J2's 2028 HSA self-only limit).
    expect(indexNearest(4500, 1.03, 50)).toBe(4650);
    expect(indexNearest(192300, 1.05575, 300)).toBe(203100);
  });
});

describe("K5 the structural identities survive indexing", () => {
  it("K5 for random F in [0.7, 5]: single thresholds 1 to 5 are half the joint ones, the joint standard deduction twice the single, the single 0% maximum half the joint", () => {
    let seed = 0x9e3779b9;
    const rand = () => {
      // xorshift32, deterministic.
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed / 4294967296;
    };
    const law = compileTaxLaw(data, { startYear: 2027, years: 2, ruleSetId: "current_law" });
    const tax = new Float64Array(2 * 2 * TAX_REC);
    const pr = new Float64Array(2 * PROG_REC);
    for (let n = 0; n < 2000; n++) {
      const F = 0.7 + 4.3 * rand();
      fillPathTables(law, new Float64Array([F - 1, 0]), { chainedCpiWedge: 0, realWageGrowth: 0 }, tax, pr);
      const s = taxOffset(1, 0);
      const j = taxOffset(1, 1);
      for (let k = 1; k <= 5; k++) expect(tax[s + TR.THR0 + k]! * 2).toBe(tax[j + TR.THR0 + k]!);
      expect(tax[s + TR.STD]! * 2).toBe(tax[j + TR.STD]!);
      expect(tax[s + TR.LTCG0]! * 2).toBe(tax[j + TR.LTCG0]!);
      for (let k = 1; k < 7; k++) expect(tax[j + TR.THR0 + k]!).toBeGreaterThan(tax[j + TR.THR0 + k - 1]!);
    }
  });
});

describe("K7 determinism of the path tables (L5)", () => {
  it("K7 one path filled alone, inside a batch, and twice gives the same bytes", () => {
    const years = 60;
    const law = compileTaxLaw(data, { startYear: 2026, years, ruleSetId: "rates_plus_2pts_2031" });
    const opts = { chainedCpiWedge: 0.001, realWageGrowth: 0.005 };
    let seed = 12345;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const paths = Array.from({ length: 16 }, () => Float64Array.from({ length: years }, () => -0.04 + 0.12 * rand()));
    const taxSize = years * 2 * TAX_REC;
    const progSize = years * PROG_REC;
    const bytes = (a: Float64Array) => Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

    const aloneTax = new Float64Array(taxSize);
    const aloneProg = new Float64Array(progSize);
    fillPathTables(law, paths[7]!, opts, aloneTax, aloneProg);

    // A batch reusing one pair of buffers, as a thread does.
    const tax = new Float64Array(taxSize);
    const pr = new Float64Array(progSize);
    let batchTax: number[] = [];
    let batchProg: number[] = [];
    for (let k = 0; k < paths.length; k++) {
      fillPathTables(law, paths[k]!, opts, tax, pr);
      if (k === 7) {
        batchTax = bytes(tax);
        batchProg = bytes(pr);
      }
    }
    expect(batchTax).toEqual(bytes(aloneTax));
    expect(batchProg).toEqual(bytes(aloneProg));

    // A batch into views of one large buffer.
    const bigTax = new Float64Array(paths.length * taxSize);
    const bigProg = new Float64Array(paths.length * progSize);
    paths.forEach((p, k) => fillPathTables(law, p, opts, bigTax.subarray(k * taxSize, (k + 1) * taxSize), bigProg.subarray(k * progSize, (k + 1) * progSize)));
    expect(bytes(bigTax.subarray(7 * taxSize, 8 * taxSize))).toEqual(bytes(aloneTax));
    expect(bytes(bigProg.subarray(7 * progSize, 8 * progSize))).toEqual(bytes(aloneProg));

    // Twice into the same buffers.
    fillPathTables(law, paths[7]!, opts, tax, pr);
    expect(bytes(tax)).toEqual(bytes(aloneTax));
    expect(bytes(pr)).toEqual(bytes(aloneProg));
    expect(aloneTax.some((v) => Number.isNaN(v))).toBe(false);
  });
});
