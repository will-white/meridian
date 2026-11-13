/**
 * @meridian/retirement: the pure retirement engine (L1; engine-and-returns decision 1).
 *
 * No I/O and no clock anywhere under src/ except src/node; no Math.random, Date or
 * implementation-approximated Math function anywhere (engine-and-returns §3.14; the root ESLint
 * block and determinism.test.ts enforce it). Money is float64 dollars inside and integer cents at
 * the boundary, converted only through units.ts.
 */

export { ENGINE_VERSION, DATA_VERSION, DATA_CHECKSUM } from "./version.js";
export { centsToDollars, dollarsToCents, dollarsToCentsBigInt } from "./units.js";
export { detExp, detLog, detPow, powInt } from "./detmath.js";
export { selfTest } from "./selftest.js";
export { PURPOSE, counterWord, invNorm, seedKey, threefry2x32, uniformAt, uniformFromWords } from "./rng.js";
export type { Purpose, RngKey } from "./rng.js";
export { CHOLESKY_MIN_PIVOT, cholesky, covarianceFrom } from "./models/cholesky.js";
export { lognormalFromArithmetic, lognormalFromGeometric } from "./models/lognormal.js";
export type { LogParams } from "./models/lognormal.js";
export {
  BILLS,
  BONDS,
  CONSERVATIVE_GEOMETRIC_MEANS_BP,
  MAX_MEAN_BLOCK_YEARS,
  MAX_PLAN_YEARS,
  MIN_COMPLETE_COHORTS,
  SIM_ASSET_COUNT,
  STOCKS,
  US_SERIES,
  bootstrapIndices,
  cohortFor,
  compileParametricCore,
  compileReturnModel,
  conservativePresetParams,
  createMarketPath,
  customParams,
  estimateLogMoments,
  firstYearFraction,
  historicalPresetParams,
  innovationVolatilities,
  parametricStep,
  partialYearFactor,
  planCohorts,
} from "./models/index.js";
export type {
  Cohort,
  CohortPlan,
  LogMoments,
  MarketPath,
  ParametricCore,
  ParametricLogParams,
  ReturnModel,
  ReturnModelOptions,
  ReturnSeries,
} from "./models/index.js";
export {
  LIFE_TABLES,
  Q_SCALE,
  aliveInYear,
  buildLifeTables,
  calendarDeathProbability,
  compileMortality,
  deathIndexFromCdf,
  fillDeathCdf,
  lifeTableFor,
  tableFromLx,
  tableFromQx,
} from "./mortality.js";
export type { CompiledMortality, LifeTable, LifeTableId, LifeTables, MortalityPerson, MortalityPlan } from "./mortality.js";
export type { EngineWarning } from "./warning.js";
export { CASH_TOL } from "./constants.js";
export { TRADE_FLOWS_ONLY, TRADE_FULL, createTradeResult, depositAtWeights, planTrades, tradeModeOf } from "./trades.js";
export type { TradeMode, TradeResult } from "./trades.js";
export { monthIndex, monthsInPeriod, periodMonths, periodStart, planClock, yearOfMonth, yearShare } from "./clock.js";
export type { PlanClock } from "./clock.js";
export {
  RULE,
  RULE_EVENTS,
  SLOT,
  STRATEGY,
  STRATEGY_STATE_LENGTH,
  createPlannedYear,
  createSpendDecision,
  createSpendingOutcome,
  decideSpending,
  everyLivingRetired,
  fillNeeds,
  plannedYear,
  plannedYearOf,
  prepareStrategies,
  ruleEvents,
  settleSpending,
} from "./strategies/index.js";
export type {
  FloorCeilingParams,
  GuardrailParams,
  PlannedInput,
  PlannedYear,
  SpendDecision,
  SpendingOutcome,
  SpendingView,
  StrategyIndex,
  StrategyTables,
} from "./strategies/index.js";
export { EngineInputError, EngineInvariantError, EngineRuntimeError } from "./errors.js";
export type { EngineRuntimeCode } from "./errors.js";
export {
  TAX_DATA_FIRST_YEAR, TaxDataError, fullRetirementAgeTable, listTaxRuleSets, loadTaxData, pendingLimits, taxDataStale, buildRulesView, federalTaxPreview,
  contributionLimit, NOT_MODELLED,
} from "./tax/index.js";
export type { TaxData, TaxDataErrorCode, ContributionLimitKind, NotModelledEntry, NotModelledId } from "./tax/index.js";
export {
  TD, TD_REC, AD, AD_REC, TY, TY_REC, INTEREST_NONE, INTEREST_PRIOR_BILL_PLUS_SPREAD, INTEREST_BILL_RETURN, accountDragOffset,
  employeeDeferralLimit, annualAdditionsLimit, iraLimit, hsaLimit, hsaMonthsBefore65, employeePayrollTax,
  TAX_DRAG_CLASSES, BLEND_STOCK, BLEND_BOND, compileTaxDrag, assetClassMapRows, blendTaxDrag, compileAccountTaxDrag, taxableYieldsInto,
  WN, WN_REC, PATH_WARNING_CODES, PATH_WARNING_SLOTS, resetPathWarnings, noteWarning, createWarningTotals, addPathWarnings, mergeWarningTotals, warningMessages,
  TAX_FUNCTIONS,
} from "./tax/index.js";
export type { TaxDragOverrides, PathWarningCode, WarningTotals, TaxFunctions } from "./tax/index.js";
export {
  TR, PR, TI, TO, TAX_REC, PROG_REC, TAX_IN, TAX_OUT, taxOffset, progOffset,
  compileTaxLaw, fillPathTables, federalTaxInto, effectiveMarginalRates, assertTaxInput, computeFederalTax, taxYearDetail, TaxInputError,
} from "./tax/index.js";
export type { CompiledTaxLaw, CompileTaxLawOptions, FillOptions, FederalTaxInput, FederalTaxResult, FilingStatusIndex, TaxInputErrorCode } from "./tax/index.js";
export {
  RB, RB_REC, RW, RW_REC, HW, HW_REC, MONTHS_59_HALF, MONTHS_65, birthMonthIndex,
  earlyFraction, earlyFractionBefore59Half, earlyFractionBefore65, isEmployerPlan, separatedAt55, preTaxPenaltyShare, preTaxPenaltyBase,
  hsaPenaltyShare, hsaWithdraw,
  seedRoth, rothRollYear, addRothContribution, addRothConversion, rothFiveYearMet, rothWithdraw, rothFreeAmount, mergeRothAtDeath,
  compileRmdTables, defaultRmdTables, rmdStartAge, firstRmdYear, rmdDivisor, requiredMinimumDistribution,
  SS, SS_REC, SO, SO_REC,
  fraMonths, survivorFraMonths, compileSsRules, defaultSsRules, floorDime, floorDollar, roundCola, retirementFactor, spousalFactor, survivorFactor,
  compileSsPlan, ssPersonInputs, resetSsState, monthlyPayment, socialSecurityYear, socialSecurityYearMonthLoop, socialSecurityParts,
  socialSecurityPreview, socialSecurityPreviewView, SS_RULES, ssRuleVerification,
} from "./tax/index.js";
export type { RmdTables } from "./tax/index.js";
export type {
  SsRules, SsMode, SsPersonInput, SsPerson, SsPlan, SsCompileWarning, SsPreview, SsPreviewPerson, SsPreviewClaimAge, SsRule, SsRuleVerification,
} from "./tax/index.js";
