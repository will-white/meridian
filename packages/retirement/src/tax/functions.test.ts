import { describe, expect, it } from "vitest";
import { runsInOwnFile } from "../testIsolation.js";
import { fillPathTables } from "./compile.js";
import { contributionLimitsFrom } from "./contributionLimits.js";
import { federalTaxInto } from "./federalTax.js";
import { TAX_FUNCTIONS, type TaxFunctions } from "./functions.js";
import { AD_REC, CL, CL_REC, PT, PT_REC, TAX_OUT, TI, TO, TY, TYI, TYI_REC, TY_REC, progOffset, taxOffset } from "./layout.js";
import { employeePayrollTaxFrom } from "./payroll.js";
import { hsaWithdrawFrom, preTaxPenaltyBaseInto } from "./penalties.js";
import { requiredMinimumDistributionInto } from "./rmd.js";
import { rothFreeAmountInto, rothWithdrawFrom } from "./rothBasis.js";
import { socialSecurityYearFrom } from "./socialSecurity.js";
import { assetClassMapRows, blendTaxDrag, compileTaxDrag, taxableYieldsFrom } from "./taxDrag.js";
import { loadTaxData } from "./taxData.js";
import { pathTables, taxInput } from "./testKit.js";

// Seams §2.5: one injectable record of the tax area's functions replaces the engine design's tax
// hooks, so the loop's tests can run on stubs written to the same slot layouts. Every member follows
// the engine's hook rule (engine-and-returns §4): results in out records, never a returned number,
// and amounts read from arrays, never passed as doubles, because V8 boxes a double that crosses a
// call it does not inline (step 11 made the payroll tax and the limits out-record forms; the
// zero-GC work of engine-and-returns §3.15 the rest, functions.ts).

describe("TAX_FUNCTIONS (seams §2.5)", () => {
  it("holds the real functions the seams name in their record forms, plus rothFreeAmount (C34) and taxableYieldsInto (C17, C18)", () => {
    expect(TAX_FUNCTIONS).toEqual({
      fillPathTables,
      federalTaxInto,
      rothWithdraw: rothWithdrawFrom,
      rothFreeAmount: rothFreeAmountInto,
      preTaxPenaltyBase: preTaxPenaltyBaseInto,
      hsaWithdraw: hsaWithdrawFrom,
      requiredMinimumDistribution: requiredMinimumDistributionInto,
      socialSecurityYear: socialSecurityYearFrom,
      employeePayrollTaxInto: employeePayrollTaxFrom,
      contributionLimitsInto: contributionLimitsFrom,
      taxableYieldsInto: taxableYieldsFrom,
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
    expect(stubbed.employeePayrollTaxInto).toBe(employeePayrollTaxFrom);
  });

  it("no allocation in 10,000 years of step 11's members through the record (yields, payroll, limits)", ({ skip }) => {
    if (!runsInOwnFile(import.meta.url, expect.getState().testPath)) skip(); // a heap check means something only in its own file (testIsolation.ts)
    const fns = TAX_FUNCTIONS;
    const t = pathTables(loadTaxData(), { startYear: 2026, years: 20, inflation: 0.03 });
    const drag = new Float64Array(AD_REC);
    blendTaxDrag(compileTaxDrag(), Float64Array.of(6839, 2632, 0, 529, 0, 0), 0, assetClassMapRows(), drag, 0);
    const ty = new Float64Array(TY_REC);
    const pt = new Float64Array(PT_REC);
    const cl = new Float64Array(CL_REC);
    const tyIn = Float64Array.of(0.03, 1, 500000, 200000, 300000, 190000);
    const wages = Float64Array.of(120000, 60000);
    const sink = new Float64Array(1);
    expect(TYI_REC).toBe(6);
    const run = (calls: number) => {
      for (let n = 0; n < calls; n++) {
        const o = progOffset(n % 20);
        const months = n % 20 === 0 ? 3 : 12;
        tyIn[TYI.YEAR_FRACTION] = months / 12;
        tyIn[TYI.STOCK] = 500000 + n;
        wages[0] = 120000 + n;
        fns.taxableYieldsInto(drag, 0, tyIn, 0, ty);
        fns.employeePayrollTaxInto(t.prog, o, wages, 0, 1, months, pt);
        fns.contributionLimitsInto(t.prog, o, 50 + (n % 20), months, true, 12 - (n % 13), cl);
        fns.contributionLimitsInto(t.prog, o, 45, months, true, 12, cl);
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
