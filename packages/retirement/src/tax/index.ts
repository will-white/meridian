/** The tax, RMD and Social Security area (tax-rmd-ss): what the rest of the package and its users import. */

export { TaxDataError, LAW_PATHS, loadTaxData, validateTaxData, rawTaxData, fractionValue } from "./taxData.js";
export type { TaxData, TaxDataErrorCode, RawTaxData, LawPath, LawChange, LawChangeOp, IndexingRule } from "./taxData.js";
export {
  fraMonths, survivorFraMonths, compileSsRules, defaultSsRules, floorDime, floorDollar, roundCola, retirementFactor, spousalFactor, survivorFactor,
  compileSsPlan, ssPersonInputs, resetSsState, monthlyPayment, socialSecurityYear, socialSecurityYearMonthLoop, socialSecurityParts,
  socialSecurityPreview, socialSecurityPreviewView, SS_RULES, ssRuleVerification,
} from "./socialSecurity.js";
export type {
  SsRules, SsMode, SsPersonInput, SsPerson, SsPlan, SsCompileWarning, SsPreview, SsPreviewPerson, SsPreviewClaimAge, SsRule, SsRuleVerification,
} from "./socialSecurity.js";
export {
  TAX_DATA_FIRST_YEAR, listTaxRuleSets, fullRetirementAgeTable, taxDataStale, pendingLimits, buildRulesView, federalTaxPreview,
} from "./rulesView.js";
export { contributionLimit, employeeDeferralLimit, annualAdditionsLimit, iraLimit, hsaLimit, hsaMonthsBefore65 } from "./contributionLimits.js";
export type { ContributionLimitKind } from "./contributionLimits.js";
export { employeePayrollTax } from "./payroll.js";
export {
  TAX_DRAG_CLASSES, BLEND_STOCK, BLEND_BOND, compileTaxDrag, assetClassMapRows, blendTaxDrag, compileAccountTaxDrag, taxableYieldsInto,
} from "./taxDrag.js";
export type { TaxDragOverrides } from "./taxDrag.js";
export {
  PATH_WARNING_CODES, PATH_WARNING_SLOTS, resetPathWarnings, noteWarning, createWarningTotals, addPathWarnings, mergeWarningTotals, warningMessages,
} from "./warnings.js";
export type { PathWarningCode, WarningTotals } from "./warnings.js";
export { NOT_MODELLED } from "./notModelled.js";
export type { NotModelledEntry, NotModelledId } from "./notModelled.js";
export { TAX_FUNCTIONS } from "./functions.js";
export type { TaxFunctions } from "./functions.js";
export {
  TR, PR, TI, TO, RB, RW, HW, SS, SO, WN, TAX_REC, PROG_REC, TAX_IN, TAX_IN_DOLLAR_SLOTS, TAX_OUT, RB_REC, RW_REC, HW_REC, SS_REC, SO_REC, WN_REC,
  N_BRACKETS, TD, TD_REC, AD, AD_REC, TY, TY_REC, INTEREST_NONE, INTEREST_PRIOR_BILL_PLUS_SPREAD, INTEREST_BILL_RETURN,
  STATUS_SINGLE, STATUS_MFJ, taxOffset, progOffset, accountDragOffset,
} from "./layout.js";
export type { FilingStatusIndex } from "./layout.js";
export {
  compileTaxLaw, fillPathTables, fillYearAtFactors, indexFloorIncrease, indexNearest, MODE_FIXED, MODE_FLOOR_INCREASE, MODE_NEAREST, MODE_WAGE,
} from "./compile.js";
export type { CompiledTaxLaw, CompileTaxLawOptions, CompileWarning, FillOptions } from "./compile.js";
export { federalTaxInto, effectiveMarginalRates, assertTaxInput, computeFederalTax, taxYearDetail, taxYearDetailCents, TaxInputError } from "./federalTax.js";
export type { FederalTaxInput, FederalTaxResult, FederalTaxLine, TaxInputErrorCode, TaxYearDetailCents } from "./federalTax.js";
export {
  MONTHS_59_HALF, MONTHS_65, birthMonthIndex, earlyFraction, earlyFractionBefore59Half, earlyFractionBefore65, isEmployerPlan, separatedAt55, preTaxPenaltyShare, preTaxPenaltyBase,
  hsaPenaltyShare, hsaWithdraw,
} from "./penalties.js";
export {
  seedRoth, rothRollYear, addRothContribution, addRothConversion, rothFiveYearMet, rothWithdraw, rothFreeAmount, mergeRothAtDeath,
} from "./rothBasis.js";
export { compileRmdTables, defaultRmdTables, rmdStartAge, firstRmdYear, rmdDivisor, requiredMinimumDistribution } from "./rmd.js";
export type { RmdTables } from "./rmd.js";
