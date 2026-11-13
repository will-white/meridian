/** The tax, RMD and Social Security area (tax-rmd-ss): what the rest of the package and its users import. */

export { TaxDataError, LAW_PATHS, loadTaxData, validateTaxData, rawTaxData, fractionValue } from "./taxData.js";
export type { TaxData, TaxDataErrorCode, RawTaxData, LawPath, LawChange, LawChangeOp, IndexingRule } from "./taxData.js";
export { fraMonths, survivorFraMonths } from "./socialSecurity.js";
export { TAX_DATA_FIRST_YEAR, listTaxRuleSets, fullRetirementAgeTable, taxDataStale, pendingLimits } from "./rulesView.js";
