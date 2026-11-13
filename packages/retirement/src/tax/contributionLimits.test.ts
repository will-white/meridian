import { describe, expect, it } from "vitest";
import { compileTaxLaw } from "./compile.js";
import {
  annualAdditionsLimit,
  contributionLimit,
  contributionLimitsInto,
  employeeDeferralLimit,
  hsaLimit,
  hsaMonthsBefore65,
  iraLimit,
} from "./contributionLimits.js";
import { CL, CL_REC, progOffset } from "./layout.js";
import { birthMonthIndex } from "./penalties.js";
import { loadTaxData, rawTaxData, validateTaxData } from "./taxData.js";
import { pathTables } from "./testKit.js";

// tax-rmd-ss §3.10 and tests I2 to I5 (§7 I); seams C26. The 2026 limits are Notice 2025-67 and
// Rev. Proc. 2025-19 (deferral 24,500, catch-up 8,000, 60-to-63 catch-up 11,250, annual additions
// 72,000, IRA 7,500 + 1,100, HSA 4,400 / 8,750 + 1,000); 2027 carries the six plan limits as
// pending and has the published HSA limits of Rev. Proc. 2026-24 (4,500 / 9,000). Limits are
// whole dollars and asserted exactly; prorated values within 0.005.

const data = loadTaxData();
const t = pathTables(data, { startYear: 2026, years: 2 });
const P26 = progOffset(0);
const P27 = progOffset(1);
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(0.005);

describe("I2 deferral and annual-additions limits", () => {
  it("I2 2026 deferral limit by age: 45 is 24,500; 55 is 32,500; 61 is 35,750; 64 is 32,500; annual additions 72,000", () => {
    // 55: 24,500 + 8,000; 61: 24,500 + 11,250 (60 to 63 replaces the 50+ catch-up); 64: back to + 8,000.
    expect([45, 49, 50, 55, 59, 60, 61, 63, 64].map((age) => employeeDeferralLimit(t.prog, P26, age, 1))).toEqual([
      24500, 24500, 32500, 32500, 32500, 35750, 35750, 35750, 32500,
    ]);
    expect(annualAdditionsLimit(t.prog, P26, 1)).toBe(72000);
  });

  it("I2 plan year 0 (C26: × f): October to December 2026 at 45 is 24,500 × 3/12 = 6,125; additions 18,000", () => {
    expect(employeeDeferralLimit(t.prog, P26, 45, 3 / 12)).toBe(6125);
    expect(annualAdditionsLimit(t.prog, P26, 3 / 12)).toBe(18000);
    // f = 0 is a full year, as in TI.YEAR_FRACTION.
    expect(employeeDeferralLimit(t.prog, P26, 45, 0)).toBe(24500);
  });
});

describe("I3 IRA and HSA limits", () => {
  it("I3 IRA, 2026: 7,500 at 49 and 8,600 at 50 (no income test: ira_deduction_limits)", () => {
    expect(iraLimit(t.prog, P26, 49, 1)).toBe(7500);
    expect(iraLimit(t.prog, P26, 50, 1)).toBe(8600);
  });

  it("I3 HSA, 2026: family at 55 for a full year 9,750; self-only at 40, 4,400", () => {
    expect(hsaLimit(t.prog, P26, 55, true, 12)).toBe(9750);
    expect(hsaLimit(t.prog, P26, 40, false, 12)).toBe(4400);
    expect(hsaLimit(t.prog, P26, 54, true, 12)).toBe(8750);
  });

  it("I3 HSA self-only in the year of turning 65 in July (6 months): (4,400 + 1,000) × 6/12 = 2,700; 0 in later years", () => {
    // Born July 1961: 65 in July 2026 (month 1961 × 12 + 6 + 780 = 2026 × 12 + 6), so January to June count.
    const born = birthMonthIndex(1961, 7);
    expect(hsaMonthsBefore65(born, 2026 * 12, 12)).toBe(6);
    expect(hsaLimit(t.prog, P26, 65, false, hsaMonthsBefore65(born, 2026 * 12, 12))).toBe(2700);
    expect(hsaMonthsBefore65(born, 2027 * 12, 12)).toBe(0);
    expect(hsaLimit(t.prog, P27, 66, false, hsaMonthsBefore65(born, 2027 * 12, 12))).toBe(0);
    // Born July 1962: the whole of 2026 is before 65.
    expect(hsaMonthsBefore65(birthMonthIndex(1962, 7), 2026 * 12, 12)).toBe(12);
  });

  it("I3 HSA in a partial first year counts the period's months: 65 in November 2026, plan from October, 1 month", () => {
    // Born November 1961: 65 in November 2026. The period is October to December 2026 (3 months); only
    // October is before Medicare: (8,750 + 1,000) × 1/12 = 812.50. The design's calendar count
    // clamp(birthIndex + 780 − 12 × 2026, 0, 12) = 10 months, × f = 3/12, would give 9,750 × 10/12 × 3/12
    // = 2,031.25, allowing contributions in November and December, after Medicare starts.
    const months = hsaMonthsBefore65(birthMonthIndex(1961, 11), 2026 * 12 + 9, 3);
    expect(months).toBe(1);
    near(hsaLimit(t.prog, P26, 65, true, months), 812.5);
    // Someone far from 65 gets the whole period, which is f × the annual limit: 9,750 × 3/12 = 2,437.50.
    expect(hsaMonthsBefore65(birthMonthIndex(1970, 3), 2026 * 12 + 9, 3)).toBe(3);
    near(hsaLimit(t.prog, P26, 56, true, 3), 2437.5);
  });

  it("I3 2027: 4,500 self-only and 9,000 family (Rev. Proc. 2026-24, published)", () => {
    expect(hsaLimit(t.prog, P27, 40, false, 12)).toBe(4500);
    expect(hsaLimit(t.prog, P27, 40, true, 12)).toBe(9000);
  });
});

describe("contributionLimitsInto (the loop's form, through TAX_FUNCTIONS)", () => {
  it("one call writes the four limits of one owner for the period: 61 in 2026, family HSA, a full year", () => {
    // I2 and I3: deferral 24,500 + 11,250 = 35,750; additions 72,000; IRA 7,500 + 1,100 = 8,600; HSA 8,750 + 1,000 = 9,750.
    const out = new Float64Array(CL_REC).fill(-1);
    contributionLimitsInto(t.prog, P26, 61, 1, true, 12, out);
    expect([out[CL.EMPLOYEE_DEFERRAL], out[CL.ANNUAL_ADDITIONS], out[CL.IRA], out[CL.HSA]]).toEqual([35750, 72000, 8600, 9750]);
  });

  it("year 0 of October to December 2026 at 45: every limit × 3/12 (6,125; 18,000; 1,875) and the HSA by its months (2,187.50)", () => {
    const out = new Float64Array(CL_REC);
    contributionLimitsInto(t.prog, P26, 45, 3 / 12, true, 3, out);
    expect([out[CL.EMPLOYEE_DEFERRAL], out[CL.ANNUAL_ADDITIONS], out[CL.IRA]]).toEqual([6125, 18000, 1875]);
    // 8,750 × 3/12 = 2,187.50 (no catch-up at 45).
    near(out[CL.HSA]!, 2187.5);
  });
});

describe("I4 contributionLimit (cents, for the resolver)", () => {
  it("I4 (2026, 51, employer_plan) 3250000n; (2026, 61, employer_plan) 3575000n; (2026, 50, ira) 860000n; (2026, 55, hsa_family) 975000n; (2026, 40, hsa_family) 875000n", () => {
    expect(contributionLimit(2026, 51, "employer_plan")).toBe(3250000n);
    expect(contributionLimit(2026, 61, "employer_plan")).toBe(3575000n);
    expect(contributionLimit(2026, 50, "ira")).toBe(860000n);
    expect(contributionLimit(2026, 55, "hsa_family")).toBe(975000n);
    expect(contributionLimit(2026, 40, "hsa_family")).toBe(875000n);
  });

  it("I4 2025 and 2028 give null (outside the published years)", () => {
    expect(contributionLimit(2025, 51, "employer_plan")).toBeNull();
    expect(contributionLimit(2028, 51, "employer_plan")).toBeNull();
  });

  it("I4 a non-integer year or a negative age is a caller fault", () => {
    expect(() => contributionLimit(2026.5, 51, "ira")).toThrow(RangeError);
    expect(() => contributionLimit(2026, -1, "ira")).toThrow(RangeError);
  });
});

describe("I5 pending limits", () => {
  it("I5 contributionLimit(2027, 45, employer_plan) is 2450000n (the carried 2026 amount) and (2027, 40, hsa_family) 900000n (published)", () => {
    expect(contributionLimit(2027, 45, "employer_plan")).toBe(2450000n);
    expect(contributionLimit(2027, 40, "hsa_family")).toBe(900000n);
    expect(contributionLimit(2027, 50, "ira")).toBe(860000n);
  });

  it("I5 compiling a plan that covers 2027 raises limits_pending naming 2027 and the six fields; with an empty pending it does not", () => {
    const w = compileTaxLaw(data, { startYear: 2026, years: 3, ruleSetId: "current_law" }).warnings.filter((x) => x.code === "limits_pending");
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain("2027");
    for (const f of ["employeeDeferral", "catchUp50", "catchUp60to63", "annualAdditions", "ira", "iraCatchUp50"]) expect(w[0]!.message).toContain(f);

    const raw = structuredClone(rawTaxData());
    (raw.years["tax/federal-2027.json"] as { contributionLimits: { pending: string[] } }).contributionLimits.pending = [];
    const fixture = validateTaxData(raw);
    expect(compileTaxLaw(fixture, { startYear: 2026, years: 3, ruleSetId: "current_law" }).warnings.map((x) => x.code)).not.toContain("limits_pending");
  });
});
