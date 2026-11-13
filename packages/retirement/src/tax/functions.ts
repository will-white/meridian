/**
 * The tax area's functions as one injectable record (seams §2.5): the year loop and `assess` call
 * the tax area through `TaxFunctions` instead of the engine design's hooks `publishedCola`,
 * `resolveTaxYear`, `federalTax`, `splitRothWithdrawal`, `rmd` and `socialSecurity`. Production
 * passes `TAX_FUNCTIONS`; a loop test passes a copy with stubs written to the same slot layouts
 * (layout.ts), for example `{ ...TAX_FUNCTIONS, federalTaxInto: flatTaxInto }`.
 *
 * Every member is pure apart from its `out` arguments, allocates nothing and never throws on finite
 * inputs. Amounts in and out are the period's (seams §2.6): the partial first year is handled inside
 * `federalTaxInto`, `employeePayrollTax`, the limit functions, `requiredMinimumDistribution`,
 * `socialSecurityYear` and `taxableYieldsInto`, so the loop never multiplies or divides by `f`.
 */

import { fillPathTables } from "./compile.js";
import { annualAdditionsLimit, employeeDeferralLimit, hsaLimit, iraLimit } from "./contributionLimits.js";
import { federalTaxInto } from "./federalTax.js";
import { hsaWithdraw, preTaxPenaltyBase } from "./penalties.js";
import { employeePayrollTax } from "./payroll.js";
import { requiredMinimumDistribution } from "./rmd.js";
import { rothFreeAmount, rothWithdraw } from "./rothBasis.js";
import { socialSecurityYear } from "./socialSecurity.js";
import { taxableYieldsInto } from "./taxDrag.js";

export interface TaxFunctions {
  /** Once per path: the indexed tax and program tables (compile.ts). */
  readonly fillPathTables: typeof fillPathTables;
  /** One household-year of federal income tax into a `TO` record (federalTax.ts). */
  readonly federalTaxInto: typeof federalTaxInto;
  /** A Roth withdrawal split by the Publication 590-B ordering into an `RW` record (rothBasis.ts). */
  readonly rothWithdraw: typeof rothWithdraw;
  /** The part of a Roth balance that leaves with no tax and no penalty (seams C34; `YearView.rothFree`). */
  readonly rothFreeAmount: typeof rothFreeAmount;
  /** The part of a pre-tax withdrawal subject to the 10% additional tax (penalties.ts). */
  readonly preTaxPenaltyBase: typeof preTaxPenaltyBase;
  /** An HSA withdrawal's taxable part and 20% penalty base into an `HW` record (penalties.ts). */
  readonly hsaWithdraw: typeof hsaWithdraw;
  /** One account's RMD for the period, × f in year 0, capped at the balance (rmd.ts; seams C36). */
  readonly requiredMinimumDistribution: typeof requiredMinimumDistribution;
  /** The period's Social Security benefits into an `SO` record, never scaled again (socialSecurity.ts; seams C21). */
  readonly socialSecurityYear: typeof socialSecurityYear;
  /** The period's employee payroll tax (payroll.ts; seams C27). */
  readonly employeePayrollTax: typeof employeePayrollTax;
  /** The period's contribution limits (contributionLimits.ts; seams C26). */
  readonly employeeDeferralLimit: typeof employeeDeferralLimit;
  readonly annualAdditionsLimit: typeof annualAdditionsLimit;
  readonly iraLimit: typeof iraLimit;
  readonly hsaLimit: typeof hsaLimit;
  /** A taxable account's dividends, interest and gain distributions into a `TY` record (taxDrag.ts; seams C17, C18). */
  readonly taxableYieldsInto: typeof taxableYieldsInto;
}

/** The real functions. */
export const TAX_FUNCTIONS: TaxFunctions = Object.freeze({
  fillPathTables,
  federalTaxInto,
  rothWithdraw,
  rothFreeAmount,
  preTaxPenaltyBase,
  hsaWithdraw,
  requiredMinimumDistribution,
  socialSecurityYear,
  employeePayrollTax,
  employeeDeferralLimit,
  annualAdditionsLimit,
  iraLimit,
  hsaLimit,
  taxableYieldsInto,
});
