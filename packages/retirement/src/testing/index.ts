/**
 * @meridian/retirement/testing: test doubles on the real slot layouts and the SimInput builder
 * (engine-and-returns §4.3; seams C1, C30).
 */

export { account, buildSimInput, cashAccount, incomeStream } from "./simInput.js";
export type { PersonOptions, SimInputOptions } from "./simInput.js";
export {
  DEFAULT_STUB_ORDER,
  bracketTaxInto,
  fixedContributionLimitsInto,
  fixedSocialSecurity,
  flatPayrollTaxInto,
  flatTaxInto,
  noPayrollTaxInto,
  noRmd,
  noSocialSecurity,
  noTaxInto,
  orderWithdrawals,
  rmdByDivisor,
  stubHooks,
  stubTaxFunctions,
  unlimitedContributionsInto,
} from "./stubs.js";
export type { StubTaxOptions } from "./stubs.js";
export { R3_STOCK_BP, R4_RETURN_MODEL, referenceR1Input, referenceR2Input, referenceR3Input, referenceR4Input } from "./referenceScenarios.js";
export { BENCH_MODELS, benchWorkloadInput } from "./benchWorkload.js";
