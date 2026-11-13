import { describe, expect, it } from "vitest";
import { PR, progOffset } from "./layout.js";
import { employeePayrollTax } from "./payroll.js";
import { loadTaxData } from "./taxData.js";
import { pathTables } from "./testKit.js";

// tax-rmd-ss §3.10 and test I1 (§7 I); seams C27. The program record is the year's published one
// (2026: wage base 184,500; 2027: 192,300; rates 6.2%, 1.45%, 0.9% over 200,000 single and 250,000
// joint, Rev. Proc. and SSA figures of data/tax/federal-202X.json). Dollar values with cents are
// asserted within 0.005 (decision 50).

const data = loadTaxData();
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(0.005);

// Plan years 2026 to 2028 with inflation +3.0% in 2027 (J1/J2's path), so 2028 is indexed.
const t = pathTables(data, { startYear: 2026, years: 3, inflation: [0, 0.03, 0.025] });
const at = (year: number) => progOffset(year - 2026);

describe("I1 payroll tax", () => {
  it("I1 single, 2026, wages 250,000: 6.2% × 184,500 + 1.45% × 250,000 + 0.9% × 50,000 = 11,439 + 3,625 + 450 = 15,514.00", () => {
    near(employeePayrollTax(t.prog, at(2026), 250000, 0, 0, 1), 15514);
  });

  it("I1 single, 2027, wages 60,000: 3,720.00 + 870.00 = 4,590.00", () => {
    // 6.2% × 60,000 = 3,720 (below the 192,300 wage base); 1.45% × 60,000 = 870; nothing over 200,000.
    near(employeePayrollTax(t.prog, at(2027), 60000, 0, 0, 1), 4590);
  });

  it("I1 joint, 2026, wages 220,000 and 80,000: 6.2% × (184,500 + 80,000) + 1.45% × 300,000 + 0.9% × 50,000 = 16,399 + 4,350 + 450 = 21,199.00", () => {
    near(employeePayrollTax(t.prog, at(2026), 220000, 80000, 1, 1), 21199);
    // The same wages filed single (the survivor's status) cross the 200,000 threshold by 100,000: + 0.9% × 50,000 more.
    near(employeePayrollTax(t.prog, at(2026), 220000, 80000, 0, 1), 21649);
  });

  it("I1 plan year 0 with f = 2/12 and wages 20,000 (120,000 a year): (7,440 + 1,740) × 2/12 = 1,530.00", () => {
    // payroll(120,000) = 6.2% × 120,000 + 1.45% × 120,000 = 7,440 + 1,740 = 9,180; × 2/12 = 1,530.
    near(employeePayrollTax(t.prog, at(2026), 20000, 0, 0, 2 / 12), 1530);
  });

  it("I1 the partial year is scaled inside: 62,500 in three months is 250,000 a year, 15,514 × 3/12 = 3,878.50", () => {
    // Unscaled, 62,500 would be below the wage base and the threshold: 6.2% × 62,500 + 1.45% × 62,500 = 4,781.25.
    near(employeePayrollTax(t.prog, at(2026), 62500, 0, 0, 3 / 12), 3878.5);
    near(employeePayrollTax(t.prog, at(2026), 62500, 0, 0, 1), 4781.25);
  });
});

describe("payroll tax conventions", () => {
  it("f = 0 and f = 1 are a full year (the TI.YEAR_FRACTION convention); a negative wage counts as 0", () => {
    near(employeePayrollTax(t.prog, at(2026), 250000, 0, 0, 0), 15514);
    expect(employeePayrollTax(t.prog, at(2026), -5000, 0, 0, 1)).toBe(0);
    near(employeePayrollTax(t.prog, at(2026), 250000, -1, 0, 1), 15514);
  });

  it("the wage base is indexed after 2027, the Additional Medicare threshold is not: single, 2028, wages 250,000 = 16,351.00", () => {
    // J2: the 2028 wage base is 192,300 × 1.03 to the nearest 300 = 198,000. 6.2% × 198,000 = 12,276;
    // 1.45% × 250,000 = 3,625; 0.9% × (250,000 − 200,000) = 450; total 16,351.
    expect(t.prog[at(2028) + PR.WAGE_BASE]).toBe(198000);
    expect(t.prog[at(2028) + PR.ADDL_MEDICARE_THR_SINGLE]).toBe(200000);
    near(employeePayrollTax(t.prog, at(2028), 250000, 0, 0, 1), 16351);
  });
});
