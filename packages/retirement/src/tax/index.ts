/** The tax, RMD and Social Security area (tax-rmd-ss): what the rest of the package and its users import. */

export { TaxDataError, LAW_PATHS, loadTaxData, validateTaxData, rawTaxData, fractionValue } from "./taxData.js";
export type { TaxData, TaxDataErrorCode, RawTaxData, LawPath, LawChange, LawChangeOp, IndexingRule } from "./taxData.js";
export { fraMonths, survivorFraMonths } from "./socialSecurity.js";
export { TAX_DATA_FIRST_YEAR, listTaxRuleSets, fullRetirementAgeTable, taxDataStale, pendingLimits } from "./rulesView.js";
export {
  TR, PR, TI, TO, RB, SS, SO, WN, TAX_REC, PROG_REC, TAX_IN, TAX_IN_DOLLAR_SLOTS, TAX_OUT, RB_REC, SS_REC, SO_REC, WN_REC, N_BRACKETS,
  STATUS_SINGLE, STATUS_MFJ, taxOffset, progOffset,
} from "./layout.js";
export type { FilingStatusIndex } from "./layout.js";
export {
  compileTaxLaw, fillPathTables, fillYearAtFactors, indexFloorIncrease, indexNearest, MODE_FIXED, MODE_FLOOR_INCREASE, MODE_NEAREST, MODE_WAGE,
} from "./compile.js";
export type { CompiledTaxLaw, CompileTaxLawOptions, CompileWarning, FillOptions } from "./compile.js";
export { federalTaxInto, effectiveMarginalRates, assertTaxInput, computeFederalTax, taxYearDetail, taxYearDetailCents, TaxInputError } from "./federalTax.js";
export type { FederalTaxInput, FederalTaxResult, FederalTaxLine, TaxInputErrorCode, TaxYearDetailCents } from "./federalTax.js";
