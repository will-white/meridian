import { describe, expect, it } from "vitest";
import { fillPathTables } from "./compile.js";
import { contributionLimitsInto } from "./contributionLimits.js";
import { federalTaxInto } from "./federalTax.js";
import { TAX_FUNCTIONS, type TaxFunctions } from "./functions.js";
import { AD_REC, CL, CL_REC, PT, PT_REC, TAX_OUT, TI, TO, TY, TY_REC, progOffset, taxOffset } from "./layout.js";
import { employeePayrollTaxInto } from "./payroll.js";
import { hsaWithdraw, preTaxPenaltyBase } from "./penalties.js";
import { requiredMinimumDistribution } from "./rmd.js";
import { rothFreeAmount, rothWithdraw } from "./rothBasis.js";
import { socialSecurityYear } from "./socialSecurity.js";
import { assetClassMapRows, blendTaxDrag, compileTaxDrag, taxableYieldsInto } from "./taxDrag.js";
import { loadTaxData } from "./taxData.js";
import { pathTables, taxInput } from "./testKit.js";

// Seams §2.5: one injectable record of the tax area's functions replaces the engine design's tax
// hooks, so the loop's tests can run on stubs written to the same slot layouts. Step 11's members
// follow the engine's hook rule (engine-and-returns §4): results in out records, never a returned
// number, because V8 boxes a double returned from a call it does not inline.

describe("TAX_FUNCTIONS (seams §2.5)", () => {
  it("holds the real functions the seams name (payroll and the limits in their out-record form), plus rothFreeAmount (C34) and taxableYieldsInto (C17, C18)", () => {
    expect(TAX_FUNCTIONS).toEqual({
      fillPathTables,
      federalTaxInto,
      rothWithdraw,
      rothFreeAmount,
      preTaxPenaltyBase,
      hsaWithdraw,
      requiredMinimumDistribution,
      socialSecurityYear,
      employeePayrollTaxInto,
      contributionLimitsInto,
      taxableYieldsInto,
    });
    for (const [name, fn] of Object.entries(TAX_FUNCTIONS)) expect(typeof fn, name).toBe("function");
    expect(Object.isFrozen(TAX_FUNCTIONS)).toBe(true);
  });

  it("a stub on the TO layout replaces one member and leaves the others real", () => {
    // A flat 20% of wages, written to the same slots federalTaxInto fills.
    const flatTaxInto: TaxFunctions["federalTaxInto"] = (_t, _o, x, r) => {
      r.fill(0);
      r[TO.TOTAL] = 0.2 * x[TI.WAGES]!;
      r[TO.INCOME_TAX] = r[TO.TOTAL]!;
    };
    const stubbed: TaxFunctions = { ...TAX_FUNCTIONS, federalTaxInto: flatTaxInto };
    const t = pathTables(loadTaxData(), { startYear: 2026, years: 1 });
    const x = taxInput({ WAGES: 100000 });
    const r = new Float64Array(TAX_OUT);
    stubbed.federalTaxInto(t.tax, taxOffset(0, 0), x, r);
    expect(r[TO.TOTAL]).toBe(20000);
    TAX_FUNCTIONS.federalTaxInto(t.tax, taxOffset(0, 0), x, r);
    expect(r[TO.TOTAL]).toBe(13170);
    expect(stubbed.employeePayrollTaxInto).toBe(employeePayrollTaxInto);
  });

  it("no allocation in 10,000 years of step 11's members through the record (yields, payroll, limits)", () => {
    const fns = TAX_FUNCTIONS;
    const t = pathTables(loadTaxData(), { startYear: 2026, years: 20, inflation: 0.03 });
    const drag = new Float64Array(AD_REC);
    blendTaxDrag(compileTaxDrag(), Float64Array.of(6839, 2632, 0, 529, 0, 0), 0, assetClassMapRows(), drag, 0);
    const ty = new Float64Array(TY_REC);
    const pt = new Float64Array(PT_REC);
    const cl = new Float64Array(CL_REC);
    const sink = new Float64Array(1);
    const run = (calls: number) => {
      for (let n = 0; n < calls; n++) {
        const o = progOffset(n % 20);
        const f = n % 20 === 0 ? 0.25 : 1;
        fns.taxableYieldsInto(drag, 0, 0.03, f, 500000 + n, 200000, 300000, 190000, ty);
        fns.employeePayrollTaxInto(t.prog, o, 120000 + n, 60000, 1, f, pt);
        fns.contributionLimitsInto(t.prog, o, 50 + (n % 20), f, true, 12 - (n % 13), cl);
        fns.contributionLimitsInto(t.prog, o, 45, f, true, 12, cl);
        sink[0] = sink[0]! + ty[TY.DIVIDENDS]! + pt[PT.TOTAL]! + cl[CL.EMPLOYEE_DEFERRAL]! + cl[CL.HSA]!;
      }
    };
    run(200_000); // warm-up: let the optimizing compiler settle
    // The smallest growth over five rounds: a round can catch a concurrent recompilation or a
    // collection under a loaded test run, but an allocation per call shows in every round (one boxed
    // double a year is about 160 KB per 10,000 years).
    let least = Infinity;
    for (let round = 0; round < 5; round++) {
      const before = process.memoryUsage().heapUsed;
      run(10_000);
      least = Math.min(least, process.memoryUsage().heapUsed - before);
    }
    expect(least).toBeLessThan(64 * 1024);
    expect(Number.isFinite(sink[0]!)).toBe(true);
  });
});
