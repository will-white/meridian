/**
 * Employee payroll tax (tax-rmd-ss §3.10, decision 43; seams C27; plan decision 5).
 *
 * Social Security (OASDI) tax to the wage base per worker, Medicare tax on all wages, and the
 * Additional Medicare tax on the household's wages above the filing status's threshold, on gross
 * wages before pre-tax and HSA deferrals. It is its own result line, never part of the federal
 * income tax total, and it does not depend on the withdrawal, so the loop computes it once a year
 * outside the solver (C27). The self-employment tax and the payroll exemption of HSA payroll
 * contributions are not modelled (§8.2 `payroll_detail`).
 *
 * The loop calls `employeePayrollTaxInto` through `TAX_FUNCTIONS` (an out record, never a returned
 * number: the engine's hook rule, engine-and-returns §4); `employeePayrollTax` is the scalar form
 * of tax-rmd-ss §4.1 for previews and tests.
 */

import { PR, PT, PT_REC, type FilingStatusIndex } from "./layout.js";

/**
 * The employee payroll tax of the period on the program record `p` at offset `o`, into `out`
 * (`PT`). `wages0` and `wages1` are each person's gross wages of the period (the partial first
 * year's own amounts) and `f` is the year fraction (the convention of `TI.YEAR_FRACTION`: outside
 * (0, 1) a full year). The partial year is handled here, as `federalTaxInto` handles it (seams
 * C23): each part is `f × part(wages / f)`, so the wage base and the Additional Medicare threshold
 * apply at their annual amounts to annualized wages. Status 0 is single, 1 married filing jointly.
 * A negative wage counts as 0. Allocates nothing.
 */
export function employeePayrollTaxInto(p: Float64Array, o: number, wages0: number, wages1: number, status: FilingStatusIndex, f: number, out: Float64Array): void {
  WAGES[0] = wages0;
  WAGES[1] = wages1;
  FRACTION[0] = f > 0 && f < 1 ? f : 1;
  payrollTax(p, o, WAGES, 0, status, FRACTION, out);
}

/**
 * `employeePayrollTaxInto` with the wages read from `wages[wagesOff]` and `wages[wagesOff + 1]` and
 * the year fraction given as the period's months (1 to 12; 12 is a full year): the form the year
 * loop calls through `TAX_FUNCTIONS.employeePayrollTaxInto`. A double passed to a call V8 does not
 * inline is boxed (two heap numbers a working year); this form takes none, and `periodMonths / 12`
 * is the loop's f, so the operations and the values are the same.
 */
export function employeePayrollTaxFrom(p: Float64Array, o: number, wages: Float64Array, wagesOff: number, status: FilingStatusIndex, periodMonths: number, out: Float64Array): void {
  FRACTION[0] = periodMonths > 0 && periodMonths < 12 ? periodMonths / 12 : 1;
  payrollTax(p, o, wages, wagesOff, status, FRACTION, out);
}

/** Scratch: the wages of the scalar form and the year fraction `g` of the call in progress. */
const WAGES = new Float64Array(2);
const FRACTION = new Float64Array(1);

/** The computation of both forms, with the year fraction in `fraction[0]` (in (0, 1], already normalized). */
function payrollTax(p: Float64Array, o: number, wages: Float64Array, wagesOff: number, status: FilingStatusIndex, fraction: Float64Array, out: Float64Array): void {
  const g = fraction[0]!;
  const wages0 = wages[wagesOff]!;
  const wages1 = wages[wagesOff + 1]!;
  const w0 = (wages0 > 0 ? wages0 : 0) / g;
  const w1 = (wages1 > 0 ? wages1 : 0) / g;
  const base = p[o + PR.WAGE_BASE]!;
  const threshold = status === 1 ? p[o + PR.ADDL_MEDICARE_THR_MFJ]! : p[o + PR.ADDL_MEDICARE_THR_SINGLE]!;
  const both = w0 + w1;
  const over = both - threshold;
  const oasdi = p[o + PR.OASDI_RATE]! * ((w0 < base ? w0 : base) + (w1 < base ? w1 : base)) * g;
  const medicare = p[o + PR.MEDICARE_RATE]! * both * g;
  const additional = over > 0 ? p[o + PR.ADDL_MEDICARE_RATE]! * over * g : 0;
  out[PT.OASDI] = oasdi;
  out[PT.MEDICARE] = medicare;
  out[PT.ADDITIONAL_MEDICARE] = additional;
  out[PT.TOTAL] = oasdi + medicare + additional;
}

const SCRATCH = new Float64Array(PT_REC);

/** `PT.TOTAL` of `employeePayrollTaxInto` (the scalar form of tax-rmd-ss §4.1, with the year fraction `f`). */
export function employeePayrollTax(p: Float64Array, o: number, wages0: number, wages1: number, status: FilingStatusIndex, f: number): number {
  employeePayrollTaxInto(p, o, wages0, wages1, status, f, SCRATCH);
  return SCRATCH[PT.TOTAL]!;
}
