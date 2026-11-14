/**
 * The tax area's functions as one injectable record (seams §2.5): the year loop and `assess` call
 * the tax area through `TaxFunctions` instead of the engine design's hooks `publishedCola`,
 * `resolveTaxYear`, `federalTax`, `splitRothWithdrawal`, `rmd` and `socialSecurity`. Production
 * passes `TAX_FUNCTIONS`; a loop test passes a copy with stubs written to the same slot layouts
 * (layout.ts), for example `{ ...TAX_FUNCTIONS, federalTaxInto: flatTaxInto }`.
 *
 * Every member is pure apart from its `out` arguments, allocates nothing and never throws on finite
 * inputs. Amounts in and out are the period's (seams §2.6): the partial first year is handled inside
 * `federalTaxInto`, `employeePayrollTaxInto`, `contributionLimitsInto`, `requiredMinimumDistribution`,
 * `socialSecurityYear` and `taxableYieldsInto`, so the loop never multiplies or divides by `f`.
 *
 * No member takes or returns a double (the engine's hook rule, engine-and-returns §4 and the
 * zero-allocation budget of §3.15): V8 boxes a double passed to or returned from a call it does not
 * inline, a heap number each time. Results go to out records or arrays, amounts come from arrays or
 * input records, and the year fraction comes as the period's months (`periodMonths / 12` is the
 * loop's f). Each member keeps its role's name and holds the record form of the function: step 11
 * made the payroll tax and the limits out-record forms (`employeePayrollTaxInto`,
 * `contributionLimitsInto`, whose scalar wages and f are now read from arrays and months:
 * `employeePayrollTaxFrom`, `contributionLimitsFrom`); `requiredMinimumDistribution`,
 * `rothFreeAmount` and `preTaxPenaltyBase` write their number into an array
 * (`requiredMinimumDistributionInto`, `rothFreeAmountInto`, `preTaxPenaltyBaseInto`);
 * `rothWithdraw`, `hsaWithdraw`, `socialSecurityYear` and `taxableYieldsInto` read their amounts
 * from arrays or a record (`rothWithdrawFrom`, `hsaWithdrawFrom`, `socialSecurityYearFrom`,
 * `taxableYieldsFrom`). The scalar functions of the same names stay in their modules for previews
 * and tests, and give the same numbers.
 */

import { fillPathTables } from "./compile.js";
import { contributionLimitsFrom } from "./contributionLimits.js";
import { federalTaxInto } from "./federalTax.js";
import { hsaWithdrawFrom, preTaxPenaltyBaseInto } from "./penalties.js";
import { employeePayrollTaxFrom } from "./payroll.js";
import { requiredMinimumDistributionInto } from "./rmd.js";
import { rothFreeAmountInto, rothWithdrawFrom } from "./rothBasis.js";
import { socialSecurityYearFrom } from "./socialSecurity.js";
import { taxableYieldsFrom } from "./taxDrag.js";

export interface TaxFunctions {
  /** Once per path: the indexed tax and program tables (compile.ts). */
  readonly fillPathTables: typeof fillPathTables;
  /** One household-year of federal income tax into a `TO` record (federalTax.ts). */
  readonly federalTaxInto: typeof federalTaxInto;
  /** A Roth withdrawal split by the Publication 590-B ordering into an `RW` record (rothBasis.ts). */
  readonly rothWithdraw: typeof rothWithdrawFrom;
  /** The part of a Roth balance that leaves with no tax and no penalty (seams C34; `YearView.rothFree`). */
  readonly rothFreeAmount: typeof rothFreeAmountInto;
  /** The part of a pre-tax withdrawal subject to the 10% additional tax (penalties.ts). */
  readonly preTaxPenaltyBase: typeof preTaxPenaltyBaseInto;
  /** An HSA withdrawal's taxable part and 20% penalty base into an `HW` record (penalties.ts). */
  readonly hsaWithdraw: typeof hsaWithdrawFrom;
  /** One account's RMD for the period, × f in year 0, capped at the balance (rmd.ts; seams C36). */
  readonly requiredMinimumDistribution: typeof requiredMinimumDistributionInto;
  /** The period's Social Security benefits into an `SO` record, never scaled again (socialSecurity.ts; seams C21). */
  readonly socialSecurityYear: typeof socialSecurityYearFrom;
  /** The period's employee payroll tax into a `PT` record (payroll.ts; seams C27). */
  readonly employeePayrollTaxInto: typeof employeePayrollTaxFrom;
  /** One owner's contribution limits for the period into a `CL` record (contributionLimits.ts; seams C26). */
  readonly contributionLimitsInto: typeof contributionLimitsFrom;
  /** A taxable account's dividends, interest and gain distributions into a `TY` record (taxDrag.ts; seams C17, C18). */
  readonly taxableYieldsInto: typeof taxableYieldsFrom;
}

/** The real functions. */
export const TAX_FUNCTIONS: TaxFunctions = Object.freeze({
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
