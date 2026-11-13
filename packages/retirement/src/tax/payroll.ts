/**
 * Employee payroll tax (tax-rmd-ss §3.10, decision 43; seams C27; plan decision 5).
 *
 * Social Security (OASDI) tax to the wage base per worker, Medicare tax on all wages, and the
 * Additional Medicare tax on the household's wages above the filing status's threshold, on gross
 * wages before pre-tax and HSA deferrals. It is its own result line, never part of the federal
 * income tax total, and it does not depend on the withdrawal, so the loop computes it once a year
 * outside the solver (C27). The self-employment tax and the payroll exemption of HSA payroll
 * contributions are not modelled (§8.2 `payroll_detail`).
 */

import { PR, type FilingStatusIndex } from "./layout.js";

/**
 * The employee payroll tax of the period on the program record `p` at offset `o`. `wages0` and
 * `wages1` are each person's gross wages of the period (the partial first year's own amounts) and
 * `f` is the year fraction (the convention of `TI.YEAR_FRACTION`: outside (0, 1) a full year).
 * The partial year is handled here, as `federalTaxInto` handles it (seams C23): the result is
 * `f × payroll(wages / f)`, so the wage base and the Additional Medicare threshold apply at their
 * annual amounts to annualized wages. Status 0 is single, 1 married filing jointly. A negative wage
 * counts as 0. Allocates nothing.
 */
export function employeePayrollTax(p: Float64Array, o: number, wages0: number, wages1: number, status: FilingStatusIndex, f: number): number {
  const g = f > 0 && f < 1 ? f : 1;
  const w0 = (wages0 > 0 ? wages0 : 0) / g;
  const w1 = (wages1 > 0 ? wages1 : 0) / g;
  const base = p[o + PR.WAGE_BASE]!;
  const threshold = status === 1 ? p[o + PR.ADDL_MEDICARE_THR_MFJ]! : p[o + PR.ADDL_MEDICARE_THR_SINGLE]!;
  const both = w0 + w1;
  const over = both - threshold;
  const tax =
    p[o + PR.OASDI_RATE]! * ((w0 < base ? w0 : base) + (w1 < base ? w1 : base)) +
    p[o + PR.MEDICARE_RATE]! * both +
    p[o + PR.ADDL_MEDICARE_RATE]! * (over > 0 ? over : 0);
  return tax * g;
}
