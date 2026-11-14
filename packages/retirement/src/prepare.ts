/**
 * `prepare(input: SimInput)`: the engine's internal tables for one run (engine-and-returns §2.3 and
 * §3.2; seams C1, C12, C13, C15 to C18, C24, C25, C26, C29, C39). `SimInput` is the only boundary
 * input (C1); every thread, the inline mode and the API's single-path re-simulation call this same
 * function on it (C12), so one preparation path serves all of them. `validateInput` is the same
 * work without throwing (seams §2.4, C13).
 *
 * Money is converted from cents to float64 dollars here and nowhere else (units.ts); basis points
 * and parts per million become fractions here too. Everything a path needs that does not depend on
 * the path's draws is computed once:
 *
 * - **Accounts.** The six asset classes are mapped onto the three simulated assets by
 *   `settings.portfolio.assetClassMap` (default `DEFAULT_ASSET_CLASS_MAP`): the starting holdings
 *   are `balance × allocation × map` (`bal0`), the yearly targets `glideWeightsAt(glidePath, year) ×
 *   map` or, without a glide path, `allocation × map` every year (C29: the form's preview and the
 *   engine show the same mix). Cash accounts are 100% bills whatever their allocation says. A
 *   taxable account's bill slice starts with basis equal to its value and the rest of the basis,
 *   `max(0, basisCents − bills)`, is split across stocks and bonds by their values (C18 (b)); every
 *   other account carries basis 0. Fund costs: `fee = 1 − expenseRatioPpm / 1e6` a year, `fee^f` in a
 *   partial first year (C14, C25).
 * - **The surplus account** (C24): the largest taxable account by starting balance, else the
 *   largest cash account, ties by id (the resolver adds `synthetic:cash` when there is neither).
 * - **Flows** (flows.ts): income streams, contributions and scheduled conversions as month-share
 *   tables (C15, C16, C26, C39).
 * - **Compiles** (C12): the return model, mortality and the horizon, the tax law of the rule set,
 *   the six classes' tax drag blended per account and plan year (C17), the Social Security plan, the
 *   RMD tables, the strategy tables; the Roth seeds of tax-rmd-ss §3.7.3; the basis-reset shares at a
 *   first death (C19).
 *
 * Errors are `EngineInputError(code, message)`; a `TaxDataError` of the tax compile is rethrown as
 * one with the same code (C7). `validateInput` also checks the resolver's limits first (C13).
 */

import {
  type AssetClass,
  AssetClass as AssetClassSchema,
  type ClassWeights,
  DEFAULT_ASSET_CLASS_MAP,
  PLAN_LIMITS,
  type PlanBucket,
  type SimInput,
  type SimInputAccount,
  glideWeightsAt,
} from "@meridian/shared";
import { type PlanClock, monthIndex, planClock, yearOfMonth } from "./clock.js";
import { detPow } from "./detmath.js";
import { EngineInputError } from "./errors.js";
import {
  type ContributionTables,
  type ConversionTables,
  type IncomeTables,
  compileContributions,
  compileConversions,
  compileIncomes,
} from "./flows.js";
import { BILLS, BONDS, SIM_ASSET_COUNT, STOCKS, type ReturnModel, compileReturnModel } from "./models/index.js";
import { type CompiledMortality, compileMortality } from "./mortality.js";
import { type RngKey, seedKey } from "./rng.js";
import { type StrategyTables, prepareStrategies } from "./strategies/prepare.js";
import { type CompiledTaxLaw, type CompileWarning, type FillOptions, compileTaxLaw } from "./tax/compile.js";
import { birthMonthIndex, isEmployerPlan } from "./tax/penalties.js";
import { type RmdTables, defaultRmdTables, rmdStartAge } from "./tax/rmd.js";
import { type SsCompileWarning, type SsPlan, compileSsPlan, ssPersonInputs } from "./tax/socialSecurity.js";
import { assetClassMapRows, compileAccountTaxDrag, compileTaxDrag } from "./tax/taxDrag.js";
import { TaxDataError, type TaxData, loadTaxData } from "./tax/taxData.js";
import { type TradeMode, tradeModeOf } from "./trades.js";
import { centsToDollars } from "./units.js";
import { DATA_VERSION } from "./version.js";
import type { EngineWarning } from "./warning.js";

/** Account treatments by index (engine-and-returns §2.1), in the order of `PlanBucket`. */
export const TREATMENT = { taxable: 0, pre_tax: 1, roth: 2, hsa: 3, cash: 4 } as const satisfies Record<PlanBucket, number>;
export type TreatmentIndex = (typeof TREATMENT)[PlanBucket];

/** Six asset classes in `AssetClass` order: the order of every six-class array here. */
const CLASSES: readonly AssetClass[] = AssetClassSchema.options;
const N_CLASSES = 6;
const BP = 10000;
/** A class weight (bp) times a map entry (bp). */
const BP2 = BP * BP;
/** The share of the portfolio in `other` above which `other_mapped_to_stocks` is raised (engine §2.6). */
const OTHER_WARNING_SHARE = 0.05;

/** A run's prepared tables. Typed arrays are shared by every path of the thread: treat them as read-only. */
export interface PreparedRun {
  /** The frozen input (the owning areas read their own blocks; `YearView.input`). */
  readonly input: SimInput;
  readonly clock: PlanClock;
  /** Y plan years, P people, A accounts. */
  readonly years: number;
  readonly personCount: number;
  readonly accountCount: number;
  readonly startYear: number;
  /** f of year 0 = `firstYearMonths / 12`. */
  readonly firstYearFraction: number;
  /** The generator key of `settings.seed`. */
  readonly key: RngKey;
  /** The effective path count (C6): the return model's, which the mortality draws stratify. */
  readonly paths: number;
  readonly model: ReturnModel;
  readonly mortality: CompiledMortality;

  // People, in the order of `household.people`.
  readonly personIds: readonly string[];
  readonly birthYear: Int16Array;
  /** Month number of the birth month (`birthMonthIndex`). */
  readonly birthIndex: Int32Array;
  /** Month number of `retirementMonth`, its calendar year, and the plan year from which `retired` is 1 (may be ≤ 0). */
  readonly retirementIndex: Int32Array;
  readonly retirementYear: Int16Array;
  readonly retiredFrom: Int16Array;
  /** Plan year of the first drawdown year: `max(0, year(spending.startMonth) − startYear)` (seams §2.2). */
  readonly drawdownStart: number;
  /** The age of each person's first RMD (`rmdStartAge`). */
  readonly rmdStartAge: Uint8Array;
  /** Roth seeds per person (tax-rmd-ss §3.7.3; `seedRoth`): the contribution basis entered, whether a funded account exists, whether any basis was not entered. */
  readonly rothBasis0: Float64Array;
  readonly rothFunded: Uint8Array;
  readonly rothBasisUnknown: Uint8Array;

  // Accounts, in the order of `accounts`.
  readonly accountIds: readonly string[];
  /** `TREATMENT` index. */
  readonly treatment: Uint8Array;
  /** Owner at the plan start: 0, 1, or −1 for a joint account. */
  readonly owner0: Int8Array;
  readonly synthetic: Uint8Array;
  /** 1 for an account of type `401k` (Form 5329 exception 01, `isEmployerPlan`). */
  readonly employerPlan: Uint8Array;
  /** Starting holdings and basis by account and simulated asset, at `a × 3 + j` (dollars). */
  readonly bal0: Float64Array;
  readonly basis0: Float64Array;
  /** Target weights on the simulated assets at `(t × A + a) × 3 + j` (fractions summing to 1): `planTrades`' target. */
  readonly weights: Float64Array;
  /** The six-class target weights at `(t × A + a) × 6 + c` (fractions), in `AssetClass` order. */
  readonly classWeights: Float64Array;
  /** The asset map as 6 × 3 fractions (`assetClassMapRows`). */
  readonly assetMap: Float64Array;
  /** Growth multiplier of the fund cost: `fee[a]` a full year, `feeFirst[a]` year 0 (`fee^f`). */
  readonly fee: Float64Array;
  readonly feeFirst: Float64Array;
  /** The account that receives surplus cash (C24). */
  readonly surplusAccount: number;
  readonly tradeMode: TradeMode;

  // Flows.
  readonly incomes: IncomeTables;
  readonly contributions: ContributionTables;
  readonly conversions: ConversionTables;

  // Tax, RMD and Social Security (C12).
  readonly taxData: TaxData;
  readonly law: CompiledTaxLaw;
  readonly fillOptions: FillOptions;
  readonly includePayrollTax: boolean;
  /** `TaxSettings.capLossCarryInCents` in dollars: the loss carried into year 0. */
  readonly lossCarryIn: number;
  /** The six classes' yield assumptions (`compileTaxDrag`) and their blend per account and plan year (`AD` at `accountDragOffset`). */
  readonly classDrag: Float64Array;
  readonly accountDrag: Float64Array;
  readonly ssPlan: SsPlan;
  readonly rmdTables: RmdTables;
  /** Basis reset at a first death (C19): the share of the gap moved for the decedent's own account and for a joint account. */
  readonly ownStepUp: number;
  readonly jointStepUp: number;

  readonly strategies: StrategyTables;

  /** The engine's run warnings (return model, mortality, asset map, first-year lumps). */
  readonly warnings: readonly EngineWarning[];
  /** The tax area's compile warnings, which `warningMessages` puts before the path warnings (C41). */
  readonly compileWarnings: ReadonlyArray<CompileWarning | SsCompileWarning>;
}

export interface InputIssue {
  readonly code: string;
  readonly message: string;
}

function fail(code: string, message: string): never {
  throw new EngineInputError(code, message);
}

/**
 * The resolver's limits (C13; `PLAN_LIMITS`, engine decision 27): accounts (synthetic ones
 * included), income streams and conversions. The horizon and the path-year cap are checked by
 * `prepare` once the horizon and the effective path count are known.
 */
export function limitIssues(input: SimInput): InputIssue[] {
  const issues: InputIssue[] = [];
  const over = (code: string, what: string, n: number, max: number) => {
    if (n > max) issues.push({ code, message: `A plan can have at most ${max} ${what}; this one has ${n}` });
  };
  over("too_many_accounts", "accounts, synthetic ones included", input.accounts.length, PLAN_LIMITS.maxAccounts);
  over("too_many_incomes", "income streams", input.incomes.length, PLAN_LIMITS.maxIncomes);
  over("too_many_conversions", "scheduled Roth conversions", input.rothConversions.length, PLAN_LIMITS.maxConversions);
  return issues;
}

/** The issue an error of `prepare` stands for, or null when it is not an input error. */
function issueOf(e: unknown): InputIssue | null {
  if (e instanceof EngineInputError || e instanceof TaxDataError) return { code: e.code, message: e.message };
  return null;
}

/**
 * `prepare()` without throwing (seams §2.4, C13): the resolver's limits, then the first input error
 * `prepare` meets, as `{ code, message }` issues; `[]` when the input can run. Anything that is not
 * an input error (an engine fault) is rethrown.
 */
export function validateInput(input: SimInput): InputIssue[] {
  const limits = limitIssues(input);
  if (limits.length > 0) return limits;
  try {
    prepare(input);
  } catch (e) {
    const issue = issueOf(e);
    if (issue !== null) return [issue];
    throw e;
  }
  return [];
}

/** Runs a tax-area compile, rethrowing a `TaxDataError` as `EngineInputError` with the same code (C7). */
function taxCompile<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof TaxDataError) throw new EngineInputError(e.code, e.message);
    throw e;
  }
}

function weightsOf(w: ClassWeights, out: Float64Array, off: number): void {
  for (let c = 0; c < N_CLASSES; c++) out[off + c] = w[CLASSES[c]!];
}

const CASH_WEIGHTS: ClassWeights = { us_stock: 0, intl_stock: 0, bonds: 0, cash: BP, real_estate: 0, other: 0 };

function checkHousehold(input: SimInput): void {
  const people = input.household.people;
  const ids = new Set(people.map((p) => p.id));
  if (ids.size !== people.length) fail("household_invalid", "two people of the household have the same id");
  const status = people.length === 2 ? "married_joint" : "single";
  if (input.household.filingStatus !== status) {
    fail("household_invalid", `a household of ${people.length} files ${status}, not ${input.household.filingStatus} (L2)`);
  }
}

/**
 * Builds the run's tables from the frozen input. Throws `EngineInputError` with the codes of the
 * module comments (and those of `planClock`, `compileMortality`, `compileReturnModel`,
 * `prepareStrategies`, `ssPersonInputs`, the flows and the tax compile).
 */
export function prepare(input: SimInput): PreparedRun {
  const limits = limitIssues(input);
  if (limits.length > 0) fail(limits[0]!.code, limits[0]!.message);
  if (input.data.version !== DATA_VERSION) {
    fail("data_version_mismatch", `the input was frozen for data version ${input.data.version}; this engine carries ${DATA_VERSION}`);
  }
  checkHousehold(input);
  const clock = planClock(input.plan);
  const Y = clock.years;
  const startYear = clock.startYear;
  const f = clock.firstYearFraction;
  const settings = input.settings;
  const people = input.household.people;
  const P = people.length;

  // Mortality decides the horizon; the plan's end year must be that horizon (the resolver computes it so, C28).
  const mortality = compileMortality(
    people.map((p) => ({ birthYear: p.birthYear, longevity: p.longevity })),
    { startYear, firstYearMonths: clock.firstYearMonths },
  );
  if (mortality.years !== Y) {
    fail("plan_invalid", `the plan ends in ${input.plan.endYear}, but the household's last possible year is ${startYear + mortality.years - 1}`);
  }

  const key = seedKey(settings.seed);
  const model = compileReturnModel(settings.returnModel, {
    key,
    years: Y,
    firstYearMonths: clock.firstYearMonths,
    requestedPaths: settings.paths,
    allFixedLongevity: mortality.allFixed,
  });
  if (model.paths * Y > PLAN_LIMITS.maxPathYears) {
    fail("path_years_too_many", `${model.paths} paths of ${Y} years exceed the engine's ${PLAN_LIMITS.maxPathYears} path-years; lower the path count`);
  }

  // People.
  const personIndex = (id: string, where: string): number => {
    const i = people.findIndex((p) => p.id === id);
    if (i < 0) fail("person_missing", `${where} names ${id}, who is not in the household`);
    return i;
  };
  const birthYear = new Int16Array(P);
  const birthIndex = new Int32Array(P);
  const retirementIndex = new Int32Array(P);
  const retirementYear = new Int16Array(P);
  const retiredFrom = new Int16Array(P);
  const rmdAge = new Uint8Array(P);
  const rmdTables = defaultRmdTables();
  people.forEach((p, i) => {
    birthYear[i] = p.birthYear;
    birthIndex[i] = birthMonthIndex(p.birthYear, p.birthMonth);
    retirementIndex[i] = monthIndex(p.retirementMonth);
    retirementYear[i] = yearOfMonth(retirementIndex[i]!);
    retiredFrom[i] = retirementYear[i]! - startYear;
    rmdAge[i] = rmdStartAge(p.birthYear, rmdTables);
  });
  const drawdownFrom = yearOfMonth(monthIndex(input.spending.startMonth)) - startYear;
  const drawdownStart = drawdownFrom > 0 ? drawdownFrom : 0;

  // Accounts.
  const accounts = input.accounts;
  const A = accounts.length;
  const accountIndex = new Map<string, number>();
  accounts.forEach((a, i) => {
    if (accountIndex.has(a.id)) fail("account_invalid", `two accounts have the id ${a.id}`);
    accountIndex.set(a.id, i);
  });
  const mapConfig = settings.portfolio.assetClassMap ?? DEFAULT_ASSET_CLASS_MAP;
  const assetMap = assetClassMapRows(mapConfig);
  const mapBp = new Float64Array(N_CLASSES * SIM_ASSET_COUNT);
  CLASSES.forEach((c, i) => {
    for (let j = 0; j < SIM_ASSET_COUNT; j++) mapBp[i * SIM_ASSET_COUNT + j] = mapConfig[c][j]!;
  });

  const treatment = new Uint8Array(A);
  const owner0 = new Int8Array(A);
  const synthetic = new Uint8Array(A);
  const employerPlan = new Uint8Array(A);
  const bal0 = new Float64Array(A * SIM_ASSET_COUNT);
  const basis0 = new Float64Array(A * SIM_ASSET_COUNT);
  const classWeights = new Float64Array(Y * A * N_CLASSES);
  const weights = new Float64Array(Y * A * SIM_ASSET_COUNT);
  const fee = new Float64Array(A);
  const feeFirst = new Float64Array(A);
  const w6 = new Float64Array(N_CLASSES);
  const classStart = new Float64Array(N_CLASSES);
  let totalStart = 0;
  let targetIntl = false;

  // Six-class weights (bp) onto the simulated assets as fractions: Σ_c w_c × map_cj / 10^8.
  const toAssets = (w: Float64Array, scale: number, out: Float64Array, off: number) => {
    for (let j = 0; j < SIM_ASSET_COUNT; j++) {
      let s = 0;
      for (let c = 0; c < N_CLASSES; c++) s += w[c]! * mapBp[c * SIM_ASSET_COUNT + j]!;
      out[off + j] = (scale * s) / BP2;
    }
  };

  accounts.forEach((acct: SimInputAccount, a) => {
    const bucket = acct.bucket;
    treatment[a] = TREATMENT[bucket];
    const owner = acct.owner === "joint" ? -1 : personIndex(acct.owner, `the account ${acct.id}`);
    if (owner < 0 && (bucket === "pre_tax" || bucket === "roth" || bucket === "hsa")) {
      fail("owner_required", `the ${bucket} account ${acct.id} needs one owner; it cannot be joint`);
    }
    owner0[a] = owner;
    synthetic[a] = acct.synthetic ? 1 : 0;
    employerPlan[a] = isEmployerPlan(acct.type) ? 1 : 0;
    const isCash = bucket === "cash";
    const balance = centsToDollars(acct.balanceCents);
    totalStart += balance;

    // Starting holdings: the current mix (a cash account is all bills, engine §3.2).
    weightsOf(isCash ? CASH_WEIGHTS : acct.allocation, w6, 0);
    toAssets(w6, balance, bal0, a * SIM_ASSET_COUNT);
    for (let c = 0; c < N_CLASSES; c++) classStart[c] = classStart[c]! + (balance * w6[c]!) / BP;

    if (bucket === "taxable") {
      // C18 (b): the bill slice at value; the rest of the basis over stocks and bonds by value.
      const o = a * SIM_ASSET_COUNT;
      const basis = acct.basisCents === undefined ? 0 : centsToDollars(acct.basisCents);
      const bills = bal0[o + BILLS]!;
      const stocks = bal0[o + STOCKS]!;
      const bonds = bal0[o + BONDS]!;
      const rest = basis > bills ? basis - bills : 0;
      basis0[o + BILLS] = bills;
      const sb = stocks + bonds;
      if (sb > 0) {
        basis0[o + STOCKS] = bonds === 0 ? rest : (rest * stocks) / sb;
        basis0[o + BONDS] = stocks === 0 ? rest : (rest * bonds) / sb;
      }
    }

    // Yearly targets (C29): the glide path's weights through the shared glideWeightsAt, else the allocation.
    const glide = isCash ? undefined : acct.glidePath;
    for (let t = 0; t < Y; t++) {
      let w: ClassWeights;
      if (isCash) w = CASH_WEIGHTS;
      else if (glide === undefined || glide.length === 0) w = acct.allocation;
      else {
        try {
          w = glideWeightsAt(glide, startYear + t);
        } catch (e) {
          if (e instanceof RangeError) fail("glide_order", `the glide path of ${acct.id}: ${e.message}`);
          throw e;
        }
      }
      weightsOf(w, w6, 0);
      if (w6[1]! > 0) targetIntl = true;
      const k = t * A + a;
      for (let c = 0; c < N_CLASSES; c++) classWeights[k * N_CLASSES + c] = w6[c]! / BP;
      toAssets(w6, 1, weights, k * SIM_ASSET_COUNT);
    }

    // C25: the fund cost on the growth factor, fee^f in a partial first year (C14).
    const cost = acct.expenseRatioPpm / 1_000_000;
    fee[a] = 1 - cost;
    feeFirst[a] = cost === 0 ? 1 : f < 1 ? detPow(1 - cost, f) : 1 - cost;
  });

  // C24: the largest taxable account by starting balance, else the largest cash account; ties by id.
  const largest = (bucket: PlanBucket): number => {
    let best = -1;
    for (let a = 0; a < A; a++) {
      const acct = accounts[a]!;
      if (acct.bucket !== bucket) continue;
      if (best < 0) {
        best = a;
        continue;
      }
      const b = accounts[best]!;
      const diff = BigInt(acct.balanceCents) - BigInt(b.balanceCents);
      if (diff > 0n || (diff === 0n && acct.id < b.id)) best = a;
    }
    return best;
  };
  let surplusAccount = largest("taxable");
  if (surplusAccount < 0) surplusAccount = largest("cash");
  if (surplusAccount < 0) {
    fail("surplus_account_missing", "the plan has no taxable or cash account to receive surplus cash (the resolver adds synthetic:cash)");
  }

  // Roth seeds (tax-rmd-ss §3.7.3) and each person's conversion target (C39: the Roth account with
  // the largest starting balance, ties by id). A synthetic Roth account is new: its basis is known to be 0.
  const rothBasis0 = new Float64Array(P);
  const rothFunded = new Uint8Array(P);
  const rothBasisUnknown = new Uint8Array(P);
  const rothTarget = new Int16Array(P).fill(-1);
  accounts.forEach((acct, a) => {
    if (acct.bucket !== "roth") return;
    const i = owner0[a]!;
    if (acct.rothContributionBasisCents !== undefined) rothBasis0[i] = rothBasis0[i]! + centsToDollars(acct.rothContributionBasisCents);
    else if (!acct.synthetic) rothBasisUnknown[i] = 1;
    if (!acct.synthetic && BigInt(acct.balanceCents) > 0n) rothFunded[i] = 1;
    const best = rothTarget[i]!;
    if (best < 0) rothTarget[i] = a;
    else {
      const b = accounts[best]!;
      const diff = BigInt(acct.balanceCents) - BigInt(b.balanceCents);
      if (diff > 0n || (diff === 0n && acct.id < b.id)) rothTarget[i] = a;
    }
  });

  const incomes = compileIncomes(input, clock);
  const contributions = compileContributions(input, clock, incomes, accountIndex, owner0);
  const conversions = compileConversions(input, clock, rothTarget);

  // Tax, tax drag, Social Security (C12).
  const taxData = loadTaxData();
  if (startYear < taxData.firstTaxYear) {
    fail("start_year_unsupported", `the plan starts in ${startYear}, before ${taxData.firstTaxYear}, the first year of the tax data`);
  }
  const adj = input.socialSecurity.adjustment;
  const law = taxCompile(() =>
    compileTaxLaw(taxData, {
      startYear,
      years: Y,
      ruleSetId: settings.taxRuleSet,
      ssAdjustment: adj === undefined ? undefined : { fromYear: adj.fromYear, factor: adj.factorBp / BP },
    }),
  );
  const classDrag = taxCompile(() => compileTaxDrag(taxData, settings.tax.taxDrag));
  const accountDrag = compileAccountTaxDrag(classDrag, classWeights, assetMap, Y, A);
  const ssPeople = ssPersonInputs(input);
  let ssPlan: SsPlan;
  try {
    ssPlan = compileSsPlan(ssPeople, { spousal: input.socialSecurity.spousal, survivor: input.socialSecurity.survivor, startYear }, taxData);
  } catch (e) {
    if (e instanceof RangeError) fail("social_security_invalid", e.message);
    throw e;
  }
  const stepUp = taxData.drag.basisStepUp;
  const communityProperty = stepUp.communityPropertyStates.includes(input.household.state);

  const strategies = prepareStrategies(input, clock);

  // Engine warnings (engine-and-returns §2.6, §5).
  const warnings: EngineWarning[] = [...model.warnings, ...mortality.warnings];
  const intlRow = mapConfig.intl_stock;
  if ((classStart[1]! > 0 || targetIntl) && intlRow[0] > 0) {
    warnings.push({
      code: "intl_modelled_as_us",
      message: "International stock earns the simulated US stock return: the record has no international series, so neither diversification nor currency risk is modelled.",
    });
  }
  const otherRow = mapConfig.other;
  if (totalStart > 0 && classStart[5]! / totalStart > OTHER_WARNING_SHARE && otherRow[0] === BP) {
    warnings.push({
      code: "other_mapped_to_stocks",
      message: `Holdings classed as other (${Math.round((classStart[5]! / totalStart) * 100)}% of the portfolio) are modelled as stocks; the asset map in the run settings can model them otherwise.`,
    });
  }
  if (f < 1 && (input.spending.goals.some((g) => g.year === startYear) || input.rothConversions.some((c) => c.year === startYear))) {
    warnings.push({
      code: "first_year_lump",
      message: "A conversion or one-off goal dated in the rest of this year is taxed as if it repeated at that pace, which overstates its tax.",
    });
  }

  return {
    input,
    clock,
    years: Y,
    personCount: P,
    accountCount: A,
    startYear,
    firstYearFraction: f,
    key,
    paths: model.paths,
    model,
    mortality,
    personIds: people.map((p) => p.id),
    birthYear,
    birthIndex,
    retirementIndex,
    retirementYear,
    retiredFrom,
    drawdownStart,
    rmdStartAge: rmdAge,
    rothBasis0,
    rothFunded,
    rothBasisUnknown,
    accountIds: accounts.map((a) => a.id),
    treatment,
    owner0,
    synthetic,
    employerPlan,
    bal0,
    basis0,
    weights,
    classWeights,
    assetMap,
    fee,
    feeFirst,
    surplusAccount,
    tradeMode: tradeModeOf(settings.portfolio.taxableRebalance),
    incomes,
    contributions,
    conversions,
    taxData,
    law,
    fillOptions: { chainedCpiWedge: settings.tax.chainedCpiWedgeBp / BP, realWageGrowth: settings.tax.realWageGrowthBp / BP },
    includePayrollTax: settings.tax.includePayrollTax,
    lossCarryIn: centsToDollars(settings.tax.capLossCarryInCents),
    classDrag,
    accountDrag,
    ssPlan,
    rmdTables,
    ownStepUp: stepUp.ownAccount,
    jointStepUp: communityProperty ? stepUp.jointAccountCommunityProperty : stepUp.jointAccount,
    strategies,
    warnings,
    compileWarnings: [...law.warnings, ...ssPlan.warnings],
  };
}
