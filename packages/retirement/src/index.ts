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
export { EngineInputError, EngineInvariantError, EngineRuntimeError } from "./errors.js";
export type { EngineRuntimeCode } from "./errors.js";
export { TAX_DATA_FIRST_YEAR, TaxDataError, fullRetirementAgeTable, listTaxRuleSets, loadTaxData, pendingLimits, taxDataStale } from "./tax/index.js";
export type { TaxData, TaxDataErrorCode } from "./tax/index.js";
export {
  TR, PR, TI, TO, TAX_REC, PROG_REC, TAX_IN, TAX_OUT, taxOffset, progOffset,
  compileTaxLaw, fillPathTables, federalTaxInto, effectiveMarginalRates, assertTaxInput, computeFederalTax, taxYearDetail, TaxInputError,
} from "./tax/index.js";
export type { CompiledTaxLaw, CompileTaxLawOptions, FillOptions, FederalTaxInput, FederalTaxResult, FilingStatusIndex, TaxInputErrorCode } from "./tax/index.js";
