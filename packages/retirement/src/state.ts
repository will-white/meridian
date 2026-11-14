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
import { type SpendDecision, type SpendingOutcome, STRATEGY_STATE_LENGTH, createSpendDecision, createSpendingOutcome } from "./strategies/index.js";
import { type Assessment, type AssessFn, type EngineHooks, type TaxFunctions, type YearView, TAX_FUNCTIONS, createAssessment } from "./hooks.js";
import { CL_REC, HW, HW_REC, PROG_REC, PT_REC, RB_REC, RW_REC, SO_REC, SS_REC, TAX_IN, TAX_REC, TY_REC, WN_REC } from "./tax/layout.js";
import { IY_REC } from "./flows.js";
import { CARRY_REC, PP_COLUMNS, PP_REC, createAssessFn } from "./assess.js";

export { CARRY, CARRY_REC } from "./assess.js";
import { type TradeResult, createTradeResult } from "./trades.js";
import { periodMonths, periodStart } from "./clock.js";
import { earlyFractionBefore59Half, earlyFractionBefore65, separatedAt55 } from "./tax/penalties.js";

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
  /** Limits per person (`CL`) and the deferral limit without catch-up, at `i × CL_REC`. */
  readonly limits: Float64Array;
  readonly limitsBase: Float64Array;
  /** Per person and limit group: employee and employer totals, and the scale each is cut to. */
  readonly groupEmployee: Float64Array;
  readonly groupEmployer: Float64Array;
  readonly scaleEmployee: Float64Array;
  readonly scaleEmployer: Float64Array;
  readonly payroll: Float64Array;

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
  /** Accumulation years: the tax and other charges with no RMD and no withdrawal (wages pay them). */
  taxBaseline: number;
  otherBaseline: number;
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
  /** End-of-year portfolio, nominal and in today's dollars, and funded spending in today's dollars (NaN in accumulation years and after the path's end). */
  readonly totalNominal: Float64Array;
  readonly totalReal: Float64Array;
  readonly spendingReal: Float64Array;
}

/** Allocates the state of one thread for `run`. `tax` defaults to the real functions; tests pass stubs. */
export function createPathState(run: PreparedRun, hooks: EngineHooks, tax: TaxFunctions = TAX_FUNCTIONS): PathState {
  const Y = run.years;
  const A = run.accountCount;
  const P = run.personCount;
  const S = run.incomes.count;
  const C = run.contributions.count;
  const person = () => new Float64Array(2);
  const perAccount = () => new Float64Array(A);
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
  const ps: Omit<PathState, "assess"> & { assess: AssessFn } = {
    run,
    hooks,
    tax,
    pathIndex: 0,
    market: createMarketPath(Y),
    cpi: new Float64Array(Y + 1),
    deathIdx: new Int16Array(P),
    deathYear: new Float64Array(2),
    bal: new Float64Array(A * 3),
    basis: new Float64Array(A * 3),
    owner: new Int8Array(A),
    roth: new Float64Array(2 * RB_REC),
    ss: new Float64Array(SS_REC),
    so: new Float64Array(SO_REC),
    taxTable: new Float64Array(Y * 2 * TAX_REC),
    progTable: new Float64Array(Y * PROG_REC),
    carry: new Float64Array(CARRY_REC),
    strategy: new Float64Array(STRATEGY_STATE_LENGTH),
    wn: new Float64Array(WN_REC),
    rothBasisUnknown: new Uint8Array(2),
    alive: new Uint8Array(P),
    retired: new Uint8Array(P),
    age: new Int16Array(P),
    yearsToDeath: new Int16Array(P),
    early: person(),
    early65: person(),
    separated55: new Uint8Array(2),
    earlyTable: new Float64Array(P * Y),
    early65Table: new Float64Array(P * Y),
    separated55Table: new Uint8Array(P * Y),
    preTaxShareTable: new Float64Array(P * Y * 2),
    hsaShareTable: new Float64Array(P * Y),
    rothFree: new Float64Array(P),
    hsaShare: new Float64Array(P),
    ssRate: new Float64Array(P),
    conv: person(),
    grossWages: person(),
    preTaxDeferral: person(),
    value: perAccount(),
    rmd: perAccount(),
    deposit: perAccount(),
    convOut: perAccount(),
    convIn: perAccount(),
    available: perAccount(),
    w: perAccount(),
    preTaxShare: perAccount(),
    gain: perAccount(),
    yields: new Float64Array(A * TY_REC),
    afterTrades: new Float64Array(A * 3),
    netOut: perAccount(),
    sold: perAccount(),
    bought: perAccount(),
    streamAmounts: new Float64Array(S),
    iy: new Float64Array(IY_REC),
    employee: new Float64Array(C),
    employer: new Float64Array(C),
    limits: new Float64Array(2 * CL_REC),
    limitsBase: new Float64Array(2 * CL_REC),
    groupEmployee: new Float64Array(2 * 4),
    groupEmployer: new Float64Array(2 * 4),
    scaleEmployee: new Float64Array(2 * 4),
    scaleEmployer: new Float64Array(2 * 4),
    payroll: new Float64Array(PT_REC),
    ppFixed: new Float64Array(PP_COLUMNS * PP_REC),
    pp: new Float64Array(PP_COLUMNS * PP_REC),
    taxIn: new Float64Array(TAX_IN),
    rw: new Float64Array(2 * RW_REC),
    hw: new Float64Array(2 * HW_REC),
    rothScratch: new Float64Array(RB_REC),
    tyScratch: new Float64Array(TY_REC),
    rwScratch: new Float64Array(RW_REC),
    hwScratch: new Float64Array(HW_REC),
    rothW: person(),
    hsaW: person(),
    trade: createTradeResult(),
    zeroW: perAccount(),
    t: 0,
    year: run.startYear,
    f: run.firstYearFraction,
    status: 0,
    drawdown: false,
    periodStart: 0,
    periodMonths: 12,
    billRef: 0,
    need: 0,
    cashIncome: 0,
    employeeTotal: 0,
    employerTotal: 0,
    contributionExcess: 0,
    payrollTotal: 0,
    rmdTotal: 0,
    convTotal: 0,
    qualifiedMedical: 0,
    nAged: 0,
    taxBaseline: 0,
    otherBaseline: 0,
    calls: 0,
    portfolio: 0,
    stockShare: 0,
    ssTotal: 0,
    availableTotal: 0,
    withdrawn: 0,
    yearFlags: 0,
    afterTotal: 0,
    endTotal: 0,
    interestIn: 0,
    interestOut: 0,
    view,
    decision: createSpendDecision(),
    outcome: createSpendingOutcome(),
    record: createAssessment(),
    baseline: createAssessment(),
    assess: () => undefined,
    flags: 0,
    failIdx: -1,
    endIdx: 0,
    endNominal: 0,
    endReal: 0,
    shortfallReal: 0,
    taxesReal: 0,
    payrollReal: 0,
    spendReal: 0,
    conversionsSkipped: 0,
    notConvergedYears: 0,
    totalNominal: new Float64Array(Y),
    totalReal: new Float64Array(Y),
    spendingReal: new Float64Array(Y),
  };
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
  ps.assess = createAssessFn(ps as PathState);
  // The penalty fractions and shares by person and plan year (tax-rmd-ss §3.7.1, seams C33).
  const hw = new Float64Array(HW_REC);
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
      ps.preTaxShareTable[k * 2] = tax.preTaxPenaltyBase(1, early, false, separated);
      ps.preTaxShareTable[k * 2 + 1] = tax.preTaxPenaltyBase(1, early, true, separated);
      tax.hsaWithdraw(1, 0, early65, hw);
      ps.hsaShareTable[k] = hw[HW.PENALTY_BASE]!;
    }
  }
  return ps as PathState;
}
