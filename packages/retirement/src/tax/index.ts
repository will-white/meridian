/** The tax, RMD and Social Security area (tax-rmd-ss): what the rest of the package and its users import. */

export { TaxDataError, LAW_PATHS, loadTaxData, validateTaxData, rawTaxData, fractionValue } from "./taxData.js";
export type { TaxData, TaxDataErrorCode, RawTaxData, LawPath, LawChange, LawChangeOp, IndexingRule } from "./taxData.js";
export { fraMonths, survivorFraMonths } from "./socialSecurity.js";
export { TAX_DATA_FIRST_YEAR, listTaxRuleSets, fullRetirementAgeTable, taxDataStale, pendingLimits } from "./rulesView.js";
export {
  TR, PR, TI, TO, RB, RW, HW, SS, SO, WN, TAX_REC, PROG_REC, TAX_IN, TAX_IN_DOLLAR_SLOTS, TAX_OUT, RB_REC, RW_REC, HW_REC, SS_REC, SO_REC, WN_REC,
  N_BRACKETS,
  STATUS_SINGLE, STATUS_MFJ, taxOffset, progOffset,
} from "./layout.js";
export type { FilingStatusIndex } from "./layout.js";
export {
  compileTaxLaw, fillPathTables, fillYearAtFactors, indexFloorIncrease, indexNearest, MODE_FIXED, MODE_FLOOR_INCREASE, MODE_NEAREST, MODE_WAGE,
} from "./compile.js";
export type { CompiledTaxLaw, CompileTaxLawOptions, CompileWarning, FillOptions } from "./compile.js";
export { federalTaxInto, effectiveMarginalRates, assertTaxInput, computeFederalTax, taxYearDetail, taxYearDetailCents, TaxInputError } from "./federalTax.js";
export type { FederalTaxInput, FederalTaxResult, FederalTaxLine, TaxInputErrorCode, TaxYearDetailCents } from "./federalTax.js";
export { MONTHS_59_HALF, MONTHS_65, monthIndex, periodStartIndex, periodMonths } from "./calendar.js";
export {
  earlyFraction, earlyFractionBefore59Half, earlyFractionBefore65, isEmployerPlan, separatedAt55, preTaxPenaltyShare, preTaxPenaltyBase,
  hsaPenaltyShare, hsaWithdraw,
} from "./penalties.js";
export {
  seedRoth, rothRollYear, addRothContribution, addRothConversion, rothFiveYearMet, rothWithdraw, rothFreeAmount, mergeRothAtDeath,
} from "./rothBasis.js";
export { compileRmdTables, defaultRmdTables, rmdStartAge, firstRmdYear, rmdDivisor, requiredMinimumDistribution } from "./rmd.js";
export type { RmdTables } from "./rmd.js";
