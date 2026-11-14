/**
 * `PathState`: everything one thread needs to simulate paths of one prepared run (engine-and-returns
 * §2.4, with the tax area's Roth layout per seams C32 and the tax area's per-path state of
 * tax-rmd-ss §2.9). It is allocated once per thread by `createPathState`, reset per path by the
 * loop, and nothing in the year loop allocates: every per-year quantity lives in a typed array or
 * a record created here.
 *
 * Money is float64 nominal dollars. Accounts hold three simulated assets at `a × 3 + j` (stocks,
 * bonds, bills); basis is kept for taxable accounts only. People are indexed 0 and 1 in the order
 * of `household.people`; arrays that the tax area's records index by person (`roth`, the SS
 * records, the per-person tax scratch) always have room for two.
 */

import { type MarketPath, createMarketPath } from "./models/index.js";
import type { PreparedRun } from "./prepare.js";
import {
  type SettleInput,
  type SpendDecision,
  type SpendingOutcome,
  STRATEGY_STATE_LENGTH,
  createSettleInput,
  createSpendDecision,
  createSpendingOutcome,
} from "./strategies/index.js";
import { type Assessment, type AssessFn, type EngineHooks, type TaxFunctions, type YearView, TAX_FUNCTIONS, createAssessment } from "./hooks.js";
import { CL_REC, HW, HW_REC, PROG_REC, PT_REC, RB_REC, RW_REC, SO_REC, SS_REC, TAX_IN, TAX_OUT, TAX_REC, TYI_REC, TY_REC, WN_REC } from "./tax/layout.js";
import { IY_REC } from "./flows.js";
import { CARRY, CARRY_REC, PP_COLUMNS, PP_REC, createAssessFn } from "./assess.js";

export { CARRY, CARRY_REC } from "./assess.js";
import { type TradeResult, createTradeResult } from "./trades.js";
import { periodMonths, periodStart } from "./clock.js";
import { type NumberKey, doubleFields } from "./doubleFields.js";
import { earlyFractionBefore59Half, earlyFractionBefore65, separatedAt55 } from "./tax/penalties.js";
import { seedRothFrom } from "./tax/rothBasis.js";

/**
 * Slots of `PathState.pathScalars`: the path's ending and lifetime sums as the loop's `endYear`
 * leaves them after each year, which `recordPath` (aggregate.ts) copies into its chunk with
 * `TypedArray.prototype.set` from one-slot views (`pathScalarViews`): it runs once per path, mostly
 * unoptimized, where reading a double field or an array element boxes the double.
 */
export const PATH_SCALAR = { END_REAL: 0, END_NOMINAL: 1, SHORTFALL_REAL: 2, TAXES_REAL: 3, SPEND_REAL: 4 } as const;
export const PATH_SCALAR_REC = 5;

/** The mutable implementation of `YearView` the loop writes. */
export type MutableYearView = { -readonly [K in keyof YearView]: YearView[K] };

/** Bits of `PathState.flags` (the chunk flags of engine-and-returns §2.5 with seams C40's bit 3). */
export const PATH_FLAG = {
  SUCCESS: 1,
  WRAPPED: 2,
  NOT_CONVERGED: 4,
  BELOW_PLAN: 8,
} as const;

export interface PathState {
  readonly run: PreparedRun;
  readonly hooks: EngineHooks;
  readonly tax: TaxFunctions;

  // Per path.
  pathIndex: number;
  readonly market: MarketPath;
  /** Price level at the start of plan year t (`cpi[0] = 1`); entries after the current year are NaN until written. */
  readonly cpi: Float64Array;
  readonly deathIdx: Int16Array;
  /** Calendar year of each death, `+Infinity` for a person the household does not have (the Social Security records' convention). */
  readonly deathYear: Float64Array;
  readonly bal: Float64Array;
  readonly basis: Float64Array;
  readonly owner: Int8Array;
  /** The tax area's Roth ordering records (`RB`), one per person at `i × RB_REC` (seams C32). */
  readonly roth: Float64Array;
  /**
   * The Roth records and the carry at the start of every path (`seedRoth` of the prepared seeds;
   * the carried loss), copied whole by the loop: work done once per path runs unoptimized for most
   * of a run, where every double moved one at a time is boxed.
   */
  readonly rothStart: Float64Array;
  readonly carryStart: Float64Array;
  /** The Social Security state (`SS`) and the year's output (`SO`). */
  readonly ss: Float64Array;
  readonly so: Float64Array;
  /** The path's indexed tax table (`years × 2 × TAX_REC`) and program table (`years × PROG_REC`). */
  readonly taxTable: Float64Array;
  readonly progTable: Float64Array;
  readonly carry: Float64Array;
  /** The spending strategy's state, zeroed per path. */
  readonly strategy: Float64Array;
  /** The tax area's path warning amounts (`WN`). */
  readonly wn: Float64Array;
  /**
   * Per person, 1 while the person's Roth record rests on a contribution basis that was not
   * entered (`run.rothBasisUnknown` at the path start; a survivor takes on the decedent's flag with
   * the decedent's record, `mergeRothAtDeath`).
   */
  readonly rothBasisUnknown: Uint8Array;

  // Per year, per person (length 2).
  readonly alive: Uint8Array;
  readonly retired: Uint8Array;
  readonly age: Int16Array;
  readonly yearsToDeath: Int16Array;
  /** Share of the period before 59½ and before 65 (tax-rmd-ss §3.7.1). */
  readonly early: Float64Array;
  readonly early65: Float64Array;
  /** 1 when Form 5329's exception for separation at 55 or later applies to the person's employer plans this year. */
  readonly separated55: Uint8Array;
  /**
   * The same by person and plan year, `i × Y + t`, computed once per thread (they do not depend on
   * the path): the two early fractions, the separation flag, the pre-tax penalty share for an
   * account that is not (`× 2 + 0`) and is (`× 2 + 1`) an employer plan (the record's
   * `preTaxPenaltyBase` of one dollar), and the HSA's share (`hsaWithdraw` of one non-qualified
   * dollar). A double returned from a call TurboFan does not inline is boxed; the year loop reads
   * these tables instead.
   */
  readonly earlyTable: Float64Array;
  readonly early65Table: Float64Array;
  readonly separated55Table: Uint8Array;
  readonly preTaxShareTable: Float64Array;
  readonly hsaShareTable: Float64Array;
  readonly rothFree: Float64Array;
  readonly hsaShare: Float64Array;
  readonly ssRate: Float64Array;
  /** Scheduled conversion of each person this year (before the death skip and the cap at the pre-tax balance). */
  readonly conv: Float64Array;
  /** The conversion each person makes this year (after the death skip and the cap), the Roth record's input. */
  readonly convTake: Float64Array;
  /** Gross wages of each person this year and the employee contributions to pre-tax and HSA accounts (after the caps). */
  readonly grossWages: Float64Array;
  readonly preTaxDeferral: Float64Array;

  // Per year, per account.
  readonly value: Float64Array;
  readonly rmd: Float64Array;
  /** Contributions (after the caps) and capped overflow deposited into each account. */
  readonly deposit: Float64Array;
  readonly convOut: Float64Array;
  readonly convIn: Float64Array;
  readonly available: Float64Array;
  readonly w: Float64Array;
  readonly preTaxShare: Float64Array;
  /** The record call's realized gain and taxable yields (`TY`) per account. */
  readonly gain: Float64Array;
  readonly yields: Float64Array;
  /** Balances after the year's trades and the surplus deposit, before returns. */
  readonly afterTrades: Float64Array;
  /** Each account's flow of the trade being planned (`netOut`, read by `planTradesFrom`). */
  readonly netOut: Float64Array;
  /** Dollars the year's trades sold and bought per account (before the surplus deposit). */
  readonly sold: Float64Array;
  readonly bought: Float64Array;

  // Per year, flows.
  readonly streamAmounts: Float64Array;
  readonly iy: Float64Array;
  readonly employee: Float64Array;
  readonly employer: Float64Array;
  /** Per contribution: the employee amount kept after the caps (the Roth record's input for a Roth contribution). */
  readonly employeeKept: Float64Array;
  /** Limits per person (`CL`) and the deferral limit without catch-up, at `i × CL_REC`. */
  readonly limits: Float64Array;
  readonly limitsBase: Float64Array;
  /** Per person and limit group: employee and employer totals, and the scale each is cut to. */
  readonly groupEmployee: Float64Array;
  readonly groupEmployer: Float64Array;
  readonly scaleEmployee: Float64Array;
  readonly scaleEmployer: Float64Array;
  /** Per person: the HSA limit (after a married couple's sharing), its catch-up part, its family part, the amounts entered (capContributions). */
  readonly hsaLimit: Float64Array;
  readonly hsaCatchUp: Float64Array;
  readonly hsaFamily: Float64Array;
  readonly hsaWanted: Float64Array;
  readonly payroll: Float64Array;
  /**
   * The first drawdown year's months before `spending.startMonth` (flows.ts `PreStart`; the Stage
   * A review's engine-01): their stream amounts and income record, the Social Security state copied
   * before the year's call and its record, their contributions, payroll and the tax input and
   * output of their income alone.
   */
  readonly preAmounts: Float64Array;
  readonly preIncome: Float64Array;
  readonly preSs: Float64Array;
  readonly preSo: Float64Array;
  readonly preEmployee: Float64Array;
  readonly preEmployer: Float64Array;
  readonly prePayroll: Float64Array;
  readonly preTaxIn: Float64Array;
  readonly preTaxOut: Float64Array;

  // Per year, the tax input assembly (assess.ts).
  /** Per-person scratch (seams F1): `PP_REC` slots for person 0, person 1 and the household, summed into the `TI` slots. */
  readonly ppFixed: Float64Array;
  readonly pp: Float64Array;
  readonly taxIn: Float64Array;
  /** Roth withdrawal split of each person in the last evaluation (`RW`), the HSA split (`HW`) and a scratch Roth record. */
  readonly rw: Float64Array;
  readonly hw: Float64Array;
  readonly rothScratch: Float64Array;
  /** One-record outputs of `taxableYieldsInto`, `rothWithdraw` and `hsaWithdraw`, copied per account or person. */
  readonly tyScratch: Float64Array;
  readonly rwScratch: Float64Array;
  readonly hwScratch: Float64Array;
  readonly rothW: Float64Array;
  readonly hsaW: Float64Array;
  /** Per person: the year's qualified medical spending shared to the person's HSA withdrawal (assess.ts). */
  readonly hsaQualified: Float64Array;
  /** The input record of the taxable yields of one account (`TYI`; assess.ts). */
  readonly tyIn: Float64Array;
  /** The surplus deposited this year (one slot, `depositAtWeightsFrom`'s input). */
  readonly surplusDeposit: Float64Array;
  readonly trade: TradeResult;
  readonly zeroW: Float64Array;

  // The year's scalars (assess.ts reads them).
  t: number;
  year: number;
  f: number;
  status: 0 | 1;
  drawdown: boolean;
  periodStart: number;
  periodMonths: number;
  /** The bill return the bond interest is set from (seams C18). */
  billRef: number;
  need: number;
  cashIncome: number;
  employeeTotal: number;
  employerTotal: number;
  contributionExcess: number;
  payrollTotal: number;
  rmdTotal: number;
  convTotal: number;
  qualifiedMedical: number;
  nAged: number;
  /**
   * Accumulation years: the tax and other charges with no RMD and no withdrawal (wages pay them).
   * The first drawdown year with months before `spending.startMonth`: the tax on those months'
   * income alone (they pay it, engine-01); 0 in other drawdown years.
   */
  taxBaseline: number;
  otherBaseline: number;
  /**
   * The first drawdown year: the take-home of its months before `spending.startMonth` (their
   * stream income and benefits less their employee contributions and payroll tax), which stays
   * out of the year's net (engine-01); 0 otherwise.
   */
  preStartCash: number;
  /** The first drawdown year: the federal tax on the income of its months before `spending.startMonth` alone; 0 otherwise. */
  preStartTax: number;
  /** Hook calls of `assess` this year. */
  calls: number;
  /** Start balances (sum) and the stock share of the year's targets weighted by them (C40). */
  portfolio: number;
  stockShare: number;
  ssTotal: number;
  availableTotal: number;
  withdrawn: number;
  /** `YEAR_FLAG` bits of the year (loop.ts). */
  yearFlags: number;
  afterTotal: number;
  endTotal: number;
  /** Bill and cash interest taxed this year (earned last year) and earned this year (taxed next year). */
  interestIn: number;
  interestOut: number;

  // The hooks' records.
  readonly view: MutableYearView;
  readonly decision: SpendDecision;
  readonly outcome: SpendingOutcome;
  /** The inputs of the year's need and settlement (`fillNeedsFor`, `settleSpendingFor`). */
  readonly settle: SettleInput;
  readonly record: Assessment;
  readonly baseline: Assessment;
  readonly assess: AssessFn;

  // Path results.
  flags: number;
  failIdx: number;
  endIdx: number;
  endNominal: number;
  endReal: number;
  shortfallReal: number;
  taxesReal: number;
  payrollReal: number;
  spendReal: number;
  /** Scheduled conversions skipped because the person had died (warning `conversion_after_death`). */
  conversionsSkipped: number;
  /** Years of the path whose gross-up stopped with a surplus beyond the tolerance (warning `grossup_not_converged`, a count of path-years). */
  notConvergedYears: number;
  /** `endReal`, `endNominal`, `shortfallReal`, `taxesReal` and `spendReal` as of the last year simulated (`PATH_SCALAR`), and a one-slot view of each. */
  readonly pathScalars: Float64Array;
  readonly pathScalarViews: readonly Float64Array[];
  /** End-of-year portfolio, nominal and in today's dollars, and funded spending in today's dollars (NaN in accumulation years and after the path's end). */
  readonly totalNominal: Float64Array;
  readonly totalReal: Float64Array;
  readonly spendingReal: Float64Array;
}

/** `PathState` with its fields writable: what its constructor assigns. */
type PathStateFields = { -readonly [K in keyof PathState]: PathState[K] };

/**
 * The state's fields, one `this.x = …` assignment each. A constructor, not an object literal: V8
 * builds a literal of 128 properties or more as a dictionary and, once it is fast again, gives
 * every field the tagged representation, so each double written to one (`ps.f`, `ps.portfolio`,
 * `ps.employeeTotal`, …) is a new heap number. A constructor's fields keep the representation of
 * what is stored in them (small integer, double, object), V8 reserves them in the object from the
 * count of `this.x` assignments, and a double field is written in place.
 */
const PathStateObject = function PathStateObject(this: PathStateFields, run: PreparedRun, hooks: EngineHooks, tax: TaxFunctions, view: MutableYearView): void {
  const Y = run.years;
  const A = run.accountCount;
  const P = run.personCount;
  const S = run.incomes.count;
  const C = run.contributions.count;
  const person = () => new Float64Array(2);
  const perAccount = () => new Float64Array(A);
  this.run = run;
  this.hooks = hooks;
  this.tax = tax;
  this.pathIndex = 0;
  this.market = createMarketPath(Y);
  this.cpi = new Float64Array(Y + 1);
  this.deathIdx = new Int16Array(P);
  this.deathYear = new Float64Array(2);
  this.bal = new Float64Array(A * 3);
  this.basis = new Float64Array(A * 3);
  this.owner = new Int8Array(A);
  this.roth = new Float64Array(2 * RB_REC);
  this.rothStart = new Float64Array(2 * RB_REC);
  this.ss = new Float64Array(SS_REC);
  this.so = new Float64Array(SO_REC);
  this.taxTable = new Float64Array(Y * 2 * TAX_REC);
  this.progTable = new Float64Array(Y * PROG_REC);
  this.carry = new Float64Array(CARRY_REC);
  this.carryStart = new Float64Array(CARRY_REC);
  this.strategy = new Float64Array(STRATEGY_STATE_LENGTH);
  this.wn = new Float64Array(WN_REC);
  this.rothBasisUnknown = new Uint8Array(2);
  this.alive = new Uint8Array(P);
  this.retired = new Uint8Array(P);
  this.age = new Int16Array(P);
  this.yearsToDeath = new Int16Array(P);
  this.early = person();
  this.early65 = person();
  this.separated55 = new Uint8Array(2);
  this.earlyTable = new Float64Array(P * Y);
  this.early65Table = new Float64Array(P * Y);
  this.separated55Table = new Uint8Array(P * Y);
  this.preTaxShareTable = new Float64Array(P * Y * 2);
  this.hsaShareTable = new Float64Array(P * Y);
  this.rothFree = new Float64Array(P);
  this.hsaShare = new Float64Array(P);
  this.ssRate = new Float64Array(P);
  this.conv = person();
  this.convTake = person();
  this.grossWages = person();
  this.preTaxDeferral = person();
  this.value = perAccount();
  this.rmd = perAccount();
  this.deposit = perAccount();
  this.convOut = perAccount();
  this.convIn = perAccount();
  this.available = perAccount();
  this.w = perAccount();
  this.preTaxShare = perAccount();
  this.gain = perAccount();
  this.yields = new Float64Array(A * TY_REC);
  this.afterTrades = new Float64Array(A * 3);
  this.netOut = perAccount();
  this.sold = perAccount();
  this.bought = perAccount();
  this.streamAmounts = new Float64Array(S);
  this.iy = new Float64Array(IY_REC);
  this.employee = new Float64Array(C);
  this.employer = new Float64Array(C);
  this.employeeKept = new Float64Array(C);
  this.limits = new Float64Array(2 * CL_REC);
  this.limitsBase = new Float64Array(2 * CL_REC);
  this.groupEmployee = new Float64Array(2 * 4);
  this.groupEmployer = new Float64Array(2 * 4);
  this.scaleEmployee = new Float64Array(2 * 4);
  this.scaleEmployer = new Float64Array(2 * 4);
  this.hsaLimit = new Float64Array(2);
  this.hsaCatchUp = new Float64Array(2);
  this.hsaFamily = new Float64Array(2);
  this.hsaWanted = new Float64Array(2);
  this.payroll = new Float64Array(PT_REC);
  this.preAmounts = new Float64Array(S);
  this.preIncome = new Float64Array(IY_REC);
  this.preSs = new Float64Array(SS_REC);
  this.preSo = new Float64Array(SO_REC);
  this.preEmployee = new Float64Array(C);
  this.preEmployer = new Float64Array(C);
  this.prePayroll = new Float64Array(PT_REC);
  this.preTaxIn = new Float64Array(TAX_IN);
  this.preTaxOut = new Float64Array(TAX_OUT);
  this.ppFixed = new Float64Array(PP_COLUMNS * PP_REC);
  this.pp = new Float64Array(PP_COLUMNS * PP_REC);
  this.taxIn = new Float64Array(TAX_IN);
  this.rw = new Float64Array(2 * RW_REC);
  this.hw = new Float64Array(2 * HW_REC);
  this.rothScratch = new Float64Array(RB_REC);
  this.tyScratch = new Float64Array(TY_REC);
  this.rwScratch = new Float64Array(RW_REC);
  this.hwScratch = new Float64Array(HW_REC);
  this.rothW = person();
  this.hsaW = person();
  this.hsaQualified = person();
  this.tyIn = new Float64Array(TYI_REC);
  this.surplusDeposit = new Float64Array(1);
  this.trade = createTradeResult();
  this.zeroW = perAccount();
  this.t = 0;
  this.year = run.startYear;
  this.f = run.firstYearFraction;
  this.status = 0;
  this.drawdown = false;
  this.periodStart = 0;
  this.periodMonths = 12;
  this.billRef = 0;
  this.need = 0;
  this.cashIncome = 0;
  this.employeeTotal = 0;
  this.employerTotal = 0;
  this.contributionExcess = 0;
  this.payrollTotal = 0;
  this.rmdTotal = 0;
  this.convTotal = 0;
  this.qualifiedMedical = 0;
  this.nAged = 0;
  this.taxBaseline = 0;
  this.otherBaseline = 0;
  this.preStartCash = 0;
  this.preStartTax = 0;
  this.calls = 0;
  this.portfolio = 0;
  this.stockShare = 0;
  this.ssTotal = 0;
  this.availableTotal = 0;
  this.withdrawn = 0;
  this.yearFlags = 0;
  this.afterTotal = 0;
  this.endTotal = 0;
  this.interestIn = 0;
  this.interestOut = 0;
  this.view = view;
  this.decision = createSpendDecision();
  this.outcome = createSpendingOutcome();
  this.settle = createSettleInput();
  this.record = createAssessment();
  this.baseline = createAssessment();
  this.assess = () => undefined;
  this.flags = 0;
  this.failIdx = -1;
  this.endIdx = 0;
  this.endNominal = 0;
  this.endReal = 0;
  this.shortfallReal = 0;
  this.taxesReal = 0;
  this.payrollReal = 0;
  this.spendReal = 0;
  this.conversionsSkipped = 0;
  this.notConvergedYears = 0;
  this.pathScalars = new Float64Array(PATH_SCALAR_REC);
  this.pathScalarViews = Array.from({ length: PATH_SCALAR_REC }, (_, k) => this.pathScalars.subarray(k, k + 1));
  this.totalNominal = new Float64Array(Y);
  this.totalReal = new Float64Array(Y);
  this.spendingReal = new Float64Array(Y);
} as unknown as new (run: PreparedRun, hooks: EngineHooks, tax: TaxFunctions, view: MutableYearView) => PathStateFields;

/** The state's money and fraction scalars, which get their double form when the state is made (doubleFields.ts). */
const STATE_DOUBLES = [
  "f", "billRef", "need", "cashIncome", "employeeTotal", "employerTotal", "contributionExcess", "payrollTotal", "rmdTotal", "convTotal",
  "qualifiedMedical", "taxBaseline", "otherBaseline", "preStartCash", "preStartTax", "portfolio", "stockShare", "ssTotal", "availableTotal",
  "withdrawn", "afterTotal", "endTotal", "interestIn", "interestOut", "endNominal", "endReal", "shortfallReal", "taxesReal", "payrollReal", "spendReal",
] as const satisfies readonly NumberKey<PathStateFields>[];

/** The view's money and fraction scalars (doubleFields.ts). */
const VIEW_DOUBLES = [
  "yearFraction", "cpi", "portfolioStart", "wages", "guaranteedIncome", "otherIncome", "stockShare", "prevPortfolioReturn", "prevInflation", "prevFundedSpend",
] as const satisfies readonly NumberKey<MutableYearView>[];

/** Allocates the state of one thread for `run`. `tax` defaults to the real functions; tests pass stubs. */
export function createPathState(run: PreparedRun, hooks: EngineHooks, tax: TaxFunctions = TAX_FUNCTIONS): PathState {
  const Y = run.years;
  const A = run.accountCount;
  const P = run.personCount;
  const view: MutableYearView = {
    pathIndex: 0,
    t: 0,
    year: run.startYear,
    yearFraction: run.firstYearFraction,
    cpi: 1,
    cpiSeries: new Float64Array(0),
    phase: 0,
    filingStatus: 0,
    personCount: P,
    alive: new Uint8Array(0),
    retired: new Uint8Array(0),
    age: new Int16Array(0),
    birthYear: run.birthYear,
    yearsToDeath: new Int16Array(0),
    accountCount: A,
    treatment: run.treatment,
    owner: new Int8Array(0),
    balance: new Float64Array(0),
    rmd: new Float64Array(0),
    available: new Float64Array(0),
    preTaxPenaltyShare: new Float64Array(0),
    portfolioStart: 0,
    wages: 0,
    guaranteedIncome: 0,
    otherIncome: 0,
    socialSecurity: new Float64Array(0),
    rothFree: new Float64Array(0),
    hsaPenaltyShare: new Float64Array(0),
    prevPortfolioReturn: Number.NaN,
    prevInflation: Number.NaN,
    prevFundedSpend: Number.NaN,
    stockShare: 0,
    drawdownStart: run.drawdownStart,
    strategies: run.strategies,
    input: run.input,
  };
  doubleFields(view, VIEW_DOUBLES);
  const ps = doubleFields(new PathStateObject(run, hooks, tax, view), STATE_DOUBLES);
  // The view shares the state's arrays (the hooks read them through it).
  view.cpiSeries = ps.cpi;
  view.alive = ps.alive;
  view.retired = ps.retired;
  view.age = ps.age;
  view.yearsToDeath = ps.yearsToDeath;
  view.owner = ps.owner;
  view.balance = ps.value;
  view.rmd = ps.rmd;
  view.available = ps.available;
  view.preTaxPenaltyShare = ps.preTaxShare;
  view.socialSecurity = ps.ssRate;
  view.rothFree = ps.rothFree;
  view.hsaPenaltyShare = ps.hsaShare;
  ps.assess = createAssessFn(ps);
  for (let i = 0; i < P; i++) seedRothFrom(ps.rothStart, i * RB_REC, run.rothBasis0, i, run.rothFunded[i] === 1, run.startYear);
  ps.carryStart[CARRY.LOSS] = run.lossCarryIn;
  // The penalty fractions and shares by person and plan year (tax-rmd-ss §3.7.1, seams C33).
  const hw = new Float64Array(HW_REC);
  const oneDollar = Float64Array.of(1);
  const noQualified = Float64Array.of(0);
  const early65At = new Float64Array(1);
  for (let i = 0; i < P; i++) {
    for (let t = 0; t < Y; t++) {
      const k = i * Y + t;
      const start = periodStart(run.clock, t);
      const months = periodMonths(run.clock, t);
      const early = earlyFractionBefore59Half(run.birthIndex[i]!, start, months);
      const early65 = earlyFractionBefore65(run.birthIndex[i]!, start, months);
      const separated = separatedAt55(run.birthYear[i]!, run.retirementYear[i]!, run.startYear + t);
      ps.earlyTable[k] = early;
      ps.early65Table[k] = early65;
      ps.separated55Table[k] = separated ? 1 : 0;
      tax.preTaxPenaltyBase(1, early, false, separated, ps.preTaxShareTable, k * 2);
      tax.preTaxPenaltyBase(1, early, true, separated, ps.preTaxShareTable, k * 2 + 1);
      early65At[0] = early65;
      tax.hsaWithdraw(oneDollar, noQualified, early65At, 0, hw);
      ps.hsaShareTable[k] = hw[HW.PENALTY_BASE]!;
    }
  }
  return ps;
}
