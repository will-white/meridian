/**
 * The year loop (engine-and-returns §3.7 with seams §2.3, the order of one year and the owner of
 * each step). `simulatePath(ps, k, detail)` simulates path k of the run `ps` was created for: once
 * per path the market (`fillPath`), the deaths, the path's tax and program tables
 * (`fillPathTables(law, indexInflation, …)`, C22), the Social Security state, the Roth records,
 * balances, basis and the loss carry-in; then for t = 0 … the last death:
 *
 * | Step | What happens |
 * | --- | --- |
 * | 0 | ages, alive, retired, filing status, phase; `rothRollYear` from year 1; the early fractions |
 * | 1 | income streams by month window (`incomeYearInto`); `socialSecurityYear` gives the period's benefits, not scaled again (C21) |
 * | 2 | contributions (`contributionsYearInto`), capped by the tax area's limits (C26); payroll tax on gross wages (C27) |
 * | 3 | `decideSpending` fills the `SpendDecision`; `fillNeeds` |
 * | 3b | the RMD of each pre-tax account (C36); scheduled conversions pro rata to `value − rmd` (C39); `available`; the penalty shares and `rothFree` for the view (C33, C34) |
 * | 4, 5 | `planWithdrawals(view, decision, assess, w)`; the loop's own record call of `assess` |
 * | 6 | the trades applied (flow and rebalance in one list); the yields' basis; the Roth records; the surplus deposited (C24) |
 * | 7 | returns and fund costs; bill interest carried to next year; `cpi[t + 1]` |
 * | 8 | the year recorded; at a first death: the basis reset (C19), the rollover and `mergeRothAtDeath` |
 *
 * All flows of a year happen at its start, returns after; deaths, the rollover and the basis reset
 * take effect at the year's end (seams §2.2). A person is alive during the whole of the death year.
 *
 * Contract checks (engine-and-returns §3.9, T45): a withdrawal outside `[0, available]`
 * (`withdrawal_out_of_range`), a record `net < −CASH_TOL` while money remains (`withdrawal_short`)
 * and a 25th `assess` call (`assess_calls`) raise `EngineInvariantError`. A hook that stops with a
 * surplus beyond the tolerance (`grossup_not_converged`) sets the path's not-converged flag; the
 * surplus is saved.
 *
 * The fast path allocates nothing; a `PathDetail` (re-simulation of one path for its year table)
 * records every year.
 */

import { CASH_TOL } from "./constants.js";
import { periodMonths, periodStart } from "./clock.js";
import { EngineInvariantError } from "./errors.js";
import { CONTRIB, IY, IY_REC, LIMIT, contributionsYearInto, conversionsYearInto, incomeYearInto } from "./flows.js";
import { BILLS, BONDS, STOCKS } from "./models/index.js";
import { type PreparedRun, TREATMENT } from "./prepare.js";
import { CARRY, assessInto, prepareAssessYear } from "./assess.js";
import { PATH_FLAG, type PathState } from "./state.js";
import { fillNeeds, settleSpending } from "./strategies/index.js";
import { hsaMonthsBefore65 } from "./tax/contributionLimits.js";
import { CL, PT, PT_REC, RB_REC, RW, SO, SO_REC, TAX_IN, TAX_OUT, TO, TY, TY_REC, WN, progOffset } from "./tax/layout.js";
import { addRothContribution, addRothConversion, mergeRothAtDeath, rothRollYear, seedRoth } from "./tax/rothBasis.js";
import { resetSsState } from "./tax/socialSecurity.js";
import { noteWarning, resetPathWarnings } from "./tax/warnings.js";
import { depositAtWeights, planTradesFrom } from "./trades.js";

const TAXABLE = TREATMENT.taxable;
const PRE_TAX = TREATMENT.pre_tax;
const ROTH = TREATMENT.roth;
const CASH = TREATMENT.cash;
const GROUPS = 4;

// ---------------------------------------------------------------------------------------------
// The detail recorder: one record per plan year, for the year table (strategies-outputs-web
// §3.11) and the loop's tests.

/** Year scalars of a `PathDetail` (`YR_REC` slots per year). */
export const YR = {
  YEAR_FRACTION: 0,
  CPI_START: 1,
  CPI_END: 2,
  /** 0 accumulation, 1 drawdown. */
  PHASE: 3,
  /** 0 single, 1 married filing jointly. */
  FILING_STATUS: 4,
  /** `assess` calls of the withdrawal hook (the record call and the baseline not counted). */
  ASSESS_CALLS: 5,
  /** `YEAR_FLAG` bits. */
  FLAGS: 6,
  /** Streams plus Social Security, the period's cash income. */
  CASH_INCOME: 7,
  /** Employee contributions (the cash use: capped amounts plus the excess saved in the surplus account), employer contributions after the caps, the employee excess. */
  EMPLOYEE: 8,
  EMPLOYER: 9,
  CONTRIBUTION_EXCESS: 10,
  RMD_TOTAL: 11,
  WITHDRAWAL_TOTAL: 12,
  CONVERSIONS: 13,
  /** The record call: `TO.TOTAL`, other charges (0), `net`. */
  TAX: 14,
  OTHER_CHARGES: 15,
  NET: 16,
  PAYROLL: 17,
  /** Bill and cash interest taxed this year (earned last year) and carried to next year. */
  INTEREST_CARRIED_IN: 18,
  INTEREST_CARRIED_OUT: 19,
  PORTFOLIO_START: 20,
  AFTER_TRADES_TOTAL: 21,
  END_TOTAL: 22,
  END_TOTAL_REAL: 23,
  STOCK_SHARE: 24,
  /** The accumulation baseline's tax (0 in drawdown years). */
  TAX_BASELINE: 25,
} as const;
export const YR_REC = 26;

/** Bits of `YR.FLAGS`. */
export const YEAR_FLAG = {
  /** The floor was not funded (a drawdown year). */
  FAILED: 1,
  BELOW_PLAN: 2,
  NOT_CONVERGED: 4,
  /** The year's tax exceeded all the cash there was: the unpaid part is dropped (engine-and-returns §3.11). */
  UNPAID_TAX: 8,
} as const;

/** The spending record of a year (`SP_REC` slots): the decision, then its settlement. */
export const SP = {
  SPEND: 0,
  FLOOR: 1,
  LUMP: 2,
  LUMP_FLOOR: 3,
  HEALTHCARE: 4,
  GROSS: 5,
  PLANNED: 6,
  RULE: 7,
  NEED: 8,
  FLOOR_NEED: 9,
  PLANNED_NEED: 10,
  FUNDED: 11,
  SHORTFALL: 12,
  SURPLUS: 13,
} as const;
export const SP_REC = 14;

/** Per account and year (`AC_REC` slots at `(t × A + a) × AC_REC`). */
export const AC = {
  /** The balance before any flow (the prior year-end balance). */
  START: 0,
  RMD: 1,
  WITHDRAWAL: 2,
  CONV_OUT: 3,
  CONV_IN: 4,
  /** Contributions after the caps, plus (surplus account) the employee excess. */
  DEPOSIT: 5,
  /** The surplus saved into the account after the trades. */
  SURPLUS: 6,
  /** The gain the year's trades realized (taxable accounts). */
  GAIN: 7,
  AVAILABLE: 8,
  OWNER: 9,
  /** Dollars sold and bought by the year's trades (before the surplus deposit). */
  SOLD: 10,
  BOUGHT: 11,
} as const;
export const AC_REC = 12;

export interface PathDetail {
  readonly years: number;
  readonly people: number;
  readonly accounts: number;
  pathIndex: number;
  /** Plan years simulated: the last death's index + 1. */
  rows: number;
  readonly deathIdx: Int16Array;
  /** Historical model: the cohort's start year; −1 otherwise. */
  cohortStartYear: number;
  /** The data year of each plan year (historical and bootstrap models), −1 otherwise. */
  readonly sampledYear: Int16Array;
  /** The period's growth factors (`t × 3 + j`) and price factor. */
  readonly growth: Float64Array;
  readonly priceFactor: Float64Array;
  readonly year: Float64Array;
  readonly alive: Uint8Array;
  readonly age: Int16Array;
  readonly income: Float64Array;
  readonly socialSecurity: Float64Array;
  readonly payroll: Float64Array;
  readonly spending: Float64Array;
  readonly taxIn: Float64Array;
  readonly taxOut: Float64Array;
  readonly account: Float64Array;
  /** The record call's taxable yields per account (`TY`). */
  readonly yields: Float64Array;
  /** By account and asset (`(t × A + a) × 3 + j`): after the trades and the surplus deposit, at the year's end, and the basis at the year's end (after a death's reset). */
  readonly afterTrades: Float64Array;
  readonly end: Float64Array;
  readonly endBasis: Float64Array;
}

export function createPathDetail(run: PreparedRun): PathDetail {
  const Y = run.years;
  const A = run.accountCount;
  const P = run.personCount;
  return {
    years: Y,
    people: P,
    accounts: A,
    pathIndex: 0,
    rows: 0,
    deathIdx: new Int16Array(P),
    cohortStartYear: -1,
    sampledYear: new Int16Array(Y),
    growth: new Float64Array(Y * 3),
    priceFactor: new Float64Array(Y),
    year: new Float64Array(Y * YR_REC),
    alive: new Uint8Array(Y * P),
    age: new Int16Array(Y * P),
    income: new Float64Array(Y * IY_REC),
    socialSecurity: new Float64Array(Y * SO_REC),
    payroll: new Float64Array(Y * PT_REC),
    spending: new Float64Array(Y * SP_REC),
    taxIn: new Float64Array(Y * TAX_IN),
    taxOut: new Float64Array(Y * TAX_OUT),
    account: new Float64Array(Y * A * AC_REC),
    yields: new Float64Array(Y * A * TY_REC),
    afterTrades: new Float64Array(Y * A * 3),
    end: new Float64Array(Y * A * 3),
    endBasis: new Float64Array(Y * A * 3),
  };
}

// ---------------------------------------------------------------------------------------------
// The path.

/**
 * Simulates path `pathIndex` of `ps.run` (with `ps.hooks` and `ps.tax`). Results are in `ps`: the
 * flags, `failIdx`, `endIdx`, `endNominal`, `endReal`, the lifetime sums and the per-year
 * `totalNominal`, `totalReal`, `spendingReal`; `detail`, when given, receives every year.
 */
export function simulatePath(ps: PathState, pathIndex: number, detail: PathDetail | null = null): void {
  const run = ps.run;
  const tax = ps.tax;
  const P = run.personCount;
  const market = ps.market;
  ps.pathIndex = pathIndex;
  ps.view.pathIndex = pathIndex;
  run.model.fillPath(pathIndex, market);
  run.mortality.drawDeaths(run.key, pathIndex, ps.deathIdx);
  let endIdx = 0;
  for (let i = 0; i < P; i++) if (ps.deathIdx[i]! > endIdx) endIdx = ps.deathIdx[i]!;
  ps.endIdx = endIdx;
  ps.deathYear[0] = run.startYear + ps.deathIdx[0]!;
  ps.deathYear[1] = P === 2 ? run.startYear + ps.deathIdx[1]! : Number.POSITIVE_INFINITY;

  const cpi = ps.cpi;
  cpi.fill(Number.NaN);
  cpi[0] = 1;
  tax.fillPathTables(run.law, market.inflationFull, run.fillOptions, ps.taxTable, ps.progTable);
  resetSsState(run.ssPlan, ps.ss);
  ps.roth.fill(0);
  for (let i = 0; i < P; i++) {
    seedRoth(ps.roth, i * RB_REC, run.rothBasis0[i]!, run.rothFunded[i] === 1, run.startYear);
    ps.rothBasisUnknown[i] = run.rothBasisUnknown[i]!;
  }
  ps.bal.set(run.bal0);
  ps.basis.set(run.basis0);
  ps.owner.set(run.owner0);
  ps.carry.fill(0);
  ps.carry[CARRY.LOSS] = run.lossCarryIn;
  ps.strategy.fill(0);
  resetPathWarnings(ps.wn);
  ps.flags = 0;
  ps.failIdx = -1;
  ps.shortfallReal = 0;
  ps.taxesReal = 0;
  ps.payrollReal = 0;
  ps.spendReal = 0;
  ps.conversionsSkipped = 0;
  ps.notConvergedYears = 0;
  ps.totalNominal.fill(Number.NaN);
  ps.totalReal.fill(Number.NaN);
  ps.spendingReal.fill(Number.NaN);
  const view = ps.view;
  view.prevPortfolioReturn = Number.NaN;
  view.prevInflation = Number.NaN;
  view.prevFundedSpend = Number.NaN;

  for (let t = 0; t <= endIdx; t++) runYear(ps, t, detail);

  // The path's ending is the last year's own end total (the same sum and the same division as the
  // year's record), so a re-simulated table ends at the stored series value bit for bit (T43).
  ps.endNominal = ps.endTotal;
  ps.endReal = ps.totalReal[endIdx]!;
  if (ps.failIdx < 0) ps.flags |= PATH_FLAG.SUCCESS;
  if (market.wrapped) ps.flags |= PATH_FLAG.WRAPPED;
  if (detail !== null) {
    detail.pathIndex = pathIndex;
    detail.rows = endIdx + 1;
    detail.deathIdx.set(ps.deathIdx);
    detail.cohortStartYear = market.cohortStartYear;
    detail.sampledYear.set(market.sampledYear);
    detail.growth.set(market.growth);
    detail.priceFactor.set(market.priceFactor);
  }
}

/**
 * One plan year. The steps are separate functions that take only the state and the plan year: a
 * double passed to, or returned from, a call TurboFan does not inline is boxed, and one function
 * holding the whole year exhausts the inlining budget; each step is optimized on its own and inlines
 * its callees. The year's scalars travel in `ps`.
 */
function runYear(ps: PathState, t: number, detail: PathDetail | null): void {
  beginYear(ps, t);
  yearIncome(ps, t);
  yearContributions(ps, t);
  yearSpending(ps, t);
  forcedFlows(ps, t);
  yearAvailable(ps, t);
  prepareAssessYear(ps);
  yearWithdrawals(ps, t);
  applyTrades(ps, t);
  applyTaxState(ps);
  saveSurplus(ps, t);
  if (detail !== null) recordFlows(ps, detail, t);
  yearReturns(ps, t);
  endYear(ps, t);
  if (detail !== null) recordEnd(ps, detail, t);
}

/** Step 0: the year, ages, alive, retired, filing status, phase; the Roth roll; the start balances. */
function beginYear(ps: PathState, t: number): void {
  const run = ps.run;
  const A = run.accountCount;
  const P = run.personCount;
  const year = run.startYear + t;
  ps.t = t;
  ps.year = year;
  ps.f = t === 0 ? run.firstYearFraction : 1;
  ps.periodStart = periodStart(run.clock, t);
  ps.periodMonths = periodMonths(run.clock, t);
  let living = 0;
  let aged = 0;
  for (let i = 0; i < P; i++) {
    const alive = ps.deathIdx[i]! >= t ? 1 : 0;
    ps.alive[i] = alive;
    ps.retired[i] = t >= run.retiredFrom[i]! ? 1 : 0;
    const age = year - run.birthYear[i]!;
    ps.age[i] = age;
    ps.yearsToDeath[i] = ps.deathIdx[i]! - t;
    living += alive;
    if (alive === 1 && age >= 65) aged++;
    const k = i * run.years + t;
    ps.early[i] = ps.earlyTable[k]!;
    ps.early65[i] = ps.early65Table[k]!;
    ps.separated55[i] = ps.separated55Table[k]!;
    ps.hsaShare[i] = ps.hsaShareTable[k]!;
    if (t > 0) rothRollYear(ps.roth, i * RB_REC);
  }
  ps.status = living === 2 ? 1 : 0;
  ps.nAged = aged;
  ps.drawdown = t >= run.drawdownStart;
  ps.billRef = t === 0 ? run.model.billRef0 : ps.market.billsFull[t - 1]!;
  const bal = ps.bal;
  const weights = run.weights;
  let portfolio = 0;
  let stockWeighted = 0;
  for (let a = 0; a < A; a++) {
    const o = a * 3;
    const v = bal[o]! + bal[o + 1]! + bal[o + 2]!;
    ps.value[a] = v;
    portfolio += v;
    stockWeighted += v * weights[(t * A + a) * 3 + STOCKS]!;
    ps.rmd[a] = 0;
    ps.deposit[a] = 0;
    ps.convOut[a] = 0;
    ps.convIn[a] = 0;
    ps.gain[a] = 0;
    ps.preTaxShare[a] = 0;
    ps.w[a] = 0;
  }
  ps.yields.fill(0);
  ps.portfolio = portfolio;
  ps.stockShare = portfolio > 0 ? stockWeighted / portfolio : 0;
}

/** Step 1: income streams by month window; Social Security for the period (not scaled again, C21). Wages are gross. */
function yearIncome(ps: PathState, t: number): void {
  const run = ps.run;
  const iy = ps.iy;
  incomeYearInto(run.incomes, t, ps.cpi, ps.alive, ps.streamAmounts, iy);
  ps.grossWages[0] = iy[IY.WAGES0]!;
  ps.grossWages[1] = iy[IY.WAGES1]!;
  const so = ps.so;
  ps.tax.socialSecurityYear(run.ssPlan, ps.ss, ps.year, ps.periodStart, ps.periodMonths, ps.progTable, progOffset(t), ps.deathYear[0]!, ps.deathYear[1]!, ps.grossWages[0]!, ps.grossWages[1]!, so);
  const ssTotal = so[SO.BENEFIT]! + so[SO.BENEFIT + 1]!;
  for (let i = 0; i < run.personCount; i++) ps.ssRate[i] = so[SO.BENEFIT + i]! / ps.f;
  noteWarning(ps.wn, WN.SS_EARNINGS_TEST, so[SO.WITHHELD]! + so[SO.WITHHELD + 1]!);
  ps.ssTotal = ssTotal;
  ps.cashIncome = iy[IY.CASH]! + ssTotal;
}

/** Step 2: contributions, capped (C26); payroll tax on gross wages (C27). */
function yearContributions(ps: PathState, t: number): void {
  const run = ps.run;
  contributionsYearInto(run.contributions, run.incomes, t, ps.cpi, ps.alive, ps.employee, ps.employer);
  const po = progOffset(t);
  capContributions(ps, po);
  const payroll = ps.payroll;
  if (run.includePayrollTax) ps.tax.employeePayrollTaxInto(ps.progTable, po, ps.grossWages[0]!, ps.grossWages[1]!, ps.status, ps.f, payroll);
  else for (let k = 0; k < PT_REC; k++) payroll[k] = 0;
  ps.payrollTotal = payroll[PT.TOTAL]!;
}

/** Step 3: the view, then the spending decision and the period's need. */
function yearSpending(ps: PathState, t: number): void {
  const view = ps.view;
  const f = ps.f;
  const iy = ps.iy;
  view.t = t;
  view.year = ps.year;
  view.yearFraction = f;
  view.cpi = ps.cpi[t]!;
  view.phase = ps.drawdown ? 1 : 0;
  view.filingStatus = ps.status;
  view.portfolioStart = ps.portfolio;
  view.wages = (ps.grossWages[0]! + ps.grossWages[1]!) / f;
  view.guaranteedIncome = (iy[IY.GUARANTEED]! + ps.ssTotal) / f;
  view.otherIncome = iy[IY.OTHER]! / f;
  view.stockShare = ps.stockShare;
  const decision = ps.decision;
  ps.hooks.decideSpending(view, ps.strategy, decision);
  fillNeeds(decision, f, ps.outcome);
  ps.need = ps.outcome.need;
  ps.qualifiedMedical = decision.healthcare * f;
}

/** Step 3b: RMDs on the prior year-end balance (× f in year 0 inside the function, C36), then the scheduled conversions (C39). */
function forcedFlows(ps: PathState, t: number): void {
  const run = ps.run;
  const tax = ps.tax;
  const A = run.accountCount;
  const P = run.personCount;
  const treatment = run.treatment;
  const owner = ps.owner;
  const value = ps.value;
  const rmd = ps.rmd;
  let rmdTotal = 0;
  for (let a = 0; a < A; a++) {
    if (treatment[a] !== PRE_TAX) continue;
    const o = owner[a]!;
    if (ps.alive[o] !== 1) continue;
    const spouseAge = P === 2 && ps.alive[1 - o] === 1 ? ps.age[1 - o]! : -1;
    const x = tax.requiredMinimumDistribution(value[a]!, ps.age[o]!, run.rmdStartAge[o]!, spouseAge, ps.f, run.rmdTables);
    rmd[a] = x;
    rmdTotal += x;
  }
  ps.rmdTotal = rmdTotal;
  conversionsYearInto(run.conversions, t, ps.cpi, ps.conv);
  let convTotal = 0;
  for (let i = 0; i < P; i++) {
    const amount = ps.conv[i]!;
    if (!(amount > 0)) continue;
    if (ps.alive[i] !== 1) {
      ps.conversionsSkipped += 1;
      continue;
    }
    let room = 0;
    for (let a = 0; a < A; a++) if (treatment[a] === PRE_TAX && owner[a] === i) room += value[a]! - rmd[a]!;
    const take = amount < room ? amount : room;
    if (!(take > 0)) continue;
    for (let a = 0; a < A; a++) {
      if (treatment[a] === PRE_TAX && owner[a] === i) ps.convOut[a] = (take * (value[a]! - rmd[a]!)) / room;
    }
    const target = run.conversions.target[i]!;
    ps.convIn[target] = ps.convIn[target]! + take;
    addRothConversion(ps.roth, i * RB_REC, take, ps.year);
    convTotal += take;
  }
  ps.convTotal = convTotal;
}

/** Step 3b continued: `available`, the penalty shares and `rothFree` for the view (C33, C34). */
function yearAvailable(ps: PathState, t: number): void {
  const run = ps.run;
  const A = run.accountCount;
  const treatment = run.treatment;
  const owner = ps.owner;
  const available = ps.available;
  let availableTotal = 0;
  for (let a = 0; a < A; a++) {
    const left = ps.value[a]! - ps.rmd[a]! - ps.convOut[a]!;
    available[a] = left > 0 ? left : 0;
    availableTotal += available[a]!;
    if (treatment[a] === PRE_TAX) ps.preTaxShare[a] = ps.preTaxShareTable[(owner[a]! * run.years + t) * 2 + run.employerPlan[a]!]!;
  }
  ps.availableTotal = availableTotal;
  for (let i = 0; i < run.personCount; i++) {
    let roth = 0;
    for (let a = 0; a < A; a++) if (treatment[a] === ROTH && owner[a] === i) roth += available[a]!;
    ps.rothFree[i] = ps.tax.rothFreeAmount(ps.roth, i * RB_REC, roth, ps.early[i]!, ps.year);
  }
}

/** Steps 4 and 5: the withdrawal hook, its contract checks, the record call and the settlement of the year's spending. */
function yearWithdrawals(ps: PathState, t: number): void {
  const run = ps.run;
  const A = run.accountCount;
  const available = ps.available;
  const w = ps.w;
  const decision = ps.decision;
  const outcome = ps.outcome;
  ps.calls = 0;
  ps.hooks.planWithdrawals(ps.view, decision, ps.assess, w);
  let withdrawn = 0;
  for (let a = 0; a < A; a++) {
    const x = w[a]!;
    if (!(x >= 0) || x > available[a]! + CASH_TOL) {
      throw new EngineInvariantError(
        "withdrawal_out_of_range",
        `the withdrawal hook took ${x} from account ${run.accountIds[a]}, which has ${available[a]} available (plan year ${t}, path ${ps.pathIndex})`,
      );
    }
    if (x > available[a]!) w[a] = available[a]!;
    withdrawn += w[a]!;
  }
  ps.withdrawn = withdrawn;
  const record = ps.record;
  assessInto(ps, w, true, record);
  const net = record.net;
  const left = ps.availableTotal - withdrawn;
  if (net < -CASH_TOL && left > CASH_TOL) {
    throw new EngineInvariantError("withdrawal_short", `the withdrawal hook left ${-net} dollars unfunded while ${left} remain available (plan year ${t}, path ${ps.pathIndex})`);
  }
  let yearFlags = 0;
  if (withdrawn > CASH_TOL && net > CASH_TOL) {
    let converged = false;
    if (!Number.isNaN(decision.gross)) {
      // A gross year may end with net > 0 at the rule's own withdrawal (strategies-outputs-web §3.6).
      const released = decision.gross * ps.f + decision.lump - ps.rmdTotal;
      const wd = released > 0 ? (released < ps.availableTotal ? released : ps.availableTotal) : 0;
      converged = withdrawn <= wd + CASH_TOL;
    }
    if (!converged) {
      ps.flags |= PATH_FLAG.NOT_CONVERGED;
      ps.notConvergedYears += 1;
      yearFlags |= YEAR_FLAG.NOT_CONVERGED;
    }
  }
  // A record net within the tolerance below 0 is the solver's convergence band (|net| ≤ CASH_TOL,
  // engine-and-returns §3.9): settled as 0, so a funded year carries no shortfall of a few ulps.
  settleSpending(decision, ps.f, ps.drawdown, net < 0 && net >= -CASH_TOL ? 0 : net, ps.rmdTotal, outcome);
  if (outcome.failed) {
    yearFlags |= YEAR_FLAG.FAILED;
    if (ps.failIdx < 0) ps.failIdx = t;
  }
  if (outcome.belowPlan) {
    yearFlags |= YEAR_FLAG.BELOW_PLAN;
    ps.flags |= PATH_FLAG.BELOW_PLAN;
  }
  if (-net > outcome.need + CASH_TOL) yearFlags |= YEAR_FLAG.UNPAID_TAX;
  ps.yearFlags = yearFlags;
}

/** Step 6: the trades (flow and rebalance in one list) and the record call's yields added to basis. */
function applyTrades(ps: PathState, t: number): void {
  const run = ps.run;
  const A = run.accountCount;
  const bal = ps.bal;
  const basis = ps.basis;
  const trade = ps.trade;
  const flows = ps.netOut;
  for (let a = 0; a < A; a++) {
    flows[a] = ps.w[a]! + ps.rmd[a]! + ps.convOut[a]! - ps.deposit[a]! - ps.convIn[a]!;
    const taxable = run.treatment[a] === TAXABLE;
    planTradesFrom(bal, basis, a * 3, run.weights, (t * A + a) * 3, flows, a, run.tradeMode, taxable, true, trade);
    ps.sold[a] = trade.sell[0]! + trade.sell[1]! + trade.sell[2]!;
    ps.bought[a] = trade.buy[0]! + trade.buy[1]! + trade.buy[2]!;
    if (taxable) {
      const yo = a * TY_REC;
      basis[a * 3 + STOCKS] = basis[a * 3 + STOCKS]! + ps.yields[yo + TY.STOCK_BASIS_ADD]!;
      basis[a * 3 + BONDS] = basis[a * 3 + BONDS]! + ps.yields[yo + TY.BOND_BASIS_ADD]!;
    }
  }
}

/**
 * Step 6 continued: the Roth records, the loss carry, the MAGI history and the path warnings. A
 * Roth withdrawal that is not wholly tax- and penalty-free, by a person whose contribution basis
 * was not entered, is noted whole under `WN.ROTH_BASIS_UNKNOWN` (tax-rmd-ss §3.7.3: "the caller
 * notes the withdrawal").
 */
function applyTaxState(ps: PathState): void {
  const run = ps.run;
  const rw = ps.rwScratch;
  for (let i = 0; i < run.personCount; i++) {
    const amount = ps.rothW[i]!;
    if (!(amount > 0)) continue;
    ps.tax.rothWithdraw(ps.roth, i * RB_REC, amount, ps.early[i]!, ps.year, rw);
    if (ps.rothBasisUnknown[i] === 1 && rw[RW.TAXABLE]! + rw[RW.PENALTY_BASE]! > 0) noteWarning(ps.wn, WN.ROTH_BASIS_UNKNOWN, amount);
  }
  const taxOut = ps.record.taxResult;
  ps.carry[CARRY.LOSS] = taxOut[TO.LOSS_CARRY_OUT]!;
  ps.carry[CARRY.MAGI_2] = ps.carry[CARRY.MAGI_1]!;
  ps.carry[CARRY.MAGI_1] = taxOut[TO.MAGI_IRMAA]! / ps.f;
  noteWarning(ps.wn, WN.EARLY_PENALTY, taxOut[TO.PEN10]! + taxOut[TO.PEN20]!);
}

/** Step 6 continued: the surplus deposited in the surplus account at its target weights (C24). */
function saveSurplus(ps: PathState, t: number): void {
  const run = ps.run;
  const A = run.accountCount;
  const bal = ps.bal;
  const surplus = ps.outcome.surplus;
  const sa = run.surplusAccount;
  if (surplus > 0) depositAtWeights(bal, ps.basis, sa * 3, run.weights, (t * A + sa) * 3, surplus, run.treatment[sa] === TAXABLE);
  let afterTotal = 0;
  for (let k = 0; k < A * 3; k++) {
    ps.afterTrades[k] = bal[k]!;
    afterTotal += bal[k]!;
  }
  ps.afterTotal = afterTotal;
}

/** Step 7: returns and fund costs; bill interest of taxable and cash accounts carried to next year (C17 item 5); `cpi[t + 1]`. */
function yearReturns(ps: PathState, t: number): void {
  const run = ps.run;
  const A = run.accountCount;
  const bal = ps.bal;
  const basis = ps.basis;
  const g = ps.market.growth;
  const gS = g[t * 3 + STOCKS]!;
  const gB = g[t * 3 + BONDS]!;
  const gC = g[t * 3 + BILLS]!;
  const fees = t === 0 ? run.feeFirst : run.fee;
  ps.interestIn = ps.carry[CARRY.BILL_INTEREST]!;
  let interestOut = 0;
  let endTotal = 0;
  for (let a = 0; a < A; a++) {
    const o = a * 3;
    const tr = run.treatment[a]!;
    if ((tr === TAXABLE || tr === CASH) && gC > 1) {
      const interest = (gC - 1) * bal[o + BILLS]!;
      interestOut += interest;
      if (tr === TAXABLE) basis[o + BILLS] = basis[o + BILLS]! + interest;
    }
    const fee = fees[a]!;
    bal[o + STOCKS] = bal[o + STOCKS]! * gS * fee;
    bal[o + BONDS] = bal[o + BONDS]! * gB * fee;
    bal[o + BILLS] = bal[o + BILLS]! * gC * fee;
    endTotal += bal[o]! + bal[o + 1]! + bal[o + 2]!;
  }
  ps.carry[CARRY.BILL_INTEREST] = interestOut;
  ps.interestOut = interestOut;
  ps.endTotal = endTotal;
  ps.cpi[t + 1] = ps.cpi[t]! * ps.market.priceFactor[t]!;
}

/** Step 8: the year recorded; at a first death the basis reset, the rollover and the Roth merge. */
function endYear(ps: PathState, t: number): void {
  const run = ps.run;
  const outcome = ps.outcome;
  const view = ps.view;
  const c0 = ps.cpi[t]!;
  const c1 = ps.cpi[t + 1]!;
  const endTotal = ps.endTotal;
  ps.totalNominal[t] = endTotal;
  ps.totalReal[t] = endTotal / c1;
  if (ps.drawdown) {
    ps.spendingReal[t] = outcome.funded / c0;
    ps.spendReal += outcome.funded / c0;
    ps.shortfallReal += outcome.shortfall / c0;
  }
  ps.taxesReal += ps.record.tax / c0;
  ps.payrollReal += ps.payrollTotal / c0;
  view.prevPortfolioReturn = ps.afterTotal > 0 ? endTotal / ps.afterTotal - 1 : Number.NaN;
  view.prevInflation = ps.market.priceFactor[t]! - 1;
  view.prevFundedSpend = outcome.funded;
  if (run.personCount === 2) {
    for (let d = 0; d < 2; d++) {
      const s = 1 - d;
      if (ps.deathIdx[d] === t && ps.deathIdx[s]! > t) firstDeath(ps, d, s);
    }
  }
}

/**
 * Caps the year's contributions (seams C26, tax-rmd-ss §3.10) per owner and limit group, with the
 * owner's limits from `contributionLimitsInto` (× f inside, the HSA's months before 65 counted in
 * the period; `family = true`, the plan does not know the coverage tier):
 *
 * - employer plan: the owner's employee amounts to accounts of type `401k` (pre-tax and Roth) to
 *   the deferral limit (with catch-up); the employer amounts to the annual-additions limit less the
 *   employee amount without catch-up (catch-up contributions do not count toward it);
 * - IRA: the owner's employee amounts to `ira` and `roth` accounts to the IRA limit, and the
 *   household's to its gross wages of the period (person 0's first);
 * - HSA: employer first, then employee, to the HSA limit. A married couple whose spouses both
 *   contribute shares one family limit (Pub. 969, "Rules for married people"; § 223(b)(5)): the
 *   parts above each spouse's own age-55 catch-up are cut together, in proportion, to the family
 *   limit for the months either spouse is under 65; each spouse keeps their own catch-up.
 *
 * Within a group every entry is cut in proportion. An employee excess is saved after tax in the
 * surplus account (it is still a cash use and does not reduce wages); an employer excess is
 * dropped. Writes `deposit`, the pre-tax deferrals by person, the Roth contribution basis, the
 * year's totals and `WN.CONTRIBUTION_CAPPED`.
 */
function capContributions(ps: PathState, po: number): void {
  const run = ps.run;
  const tax = ps.tax;
  const ct = run.contributions;
  const C = ct.count;
  const P = run.personCount;
  const gE = ps.groupEmployee;
  const gR = ps.groupEmployer;
  const sE = ps.scaleEmployee;
  const sR = ps.scaleEmployer;
  for (let k = 0; k < 2 * GROUPS; k++) {
    gE[k] = 0;
    gR[k] = 0;
    sE[k] = 1;
    sR[k] = 1;
  }
  ps.preTaxDeferral[0] = 0;
  ps.preTaxDeferral[1] = 0;
  ps.employeeTotal = 0;
  ps.employerTotal = 0;
  ps.contributionExcess = 0;
  if (C === 0) return;
  const employee = ps.employee;
  const employer = ps.employer;
  for (let c = 0; c < C; c++) {
    const o = ct.owner[c]!;
    const g = ct.limit[c]!;
    if (g === LIMIT.NONE || o < 0) continue;
    gE[o * GROUPS + g] = gE[o * GROUPS + g]! + employee[c]!;
    gR[o * GROUPS + g] = gR[o * GROUPS + g]! + employer[c]!;
  }
  const lim = ps.limits;
  const base = ps.limitsBase;
  const hsaLimit = ps.hsaLimit;
  const hsaCatchUp = ps.hsaCatchUp;
  const hsaFamily = ps.hsaFamily;
  const hsaWanted = ps.hsaWanted;
  let wagesLeft = ps.grossWages[0]! + ps.grossWages[1]!;
  for (let i = 0; i < 2; i++) {
    hsaLimit[i] = 0;
    hsaCatchUp[i] = 0;
    hsaFamily[i] = 0;
    hsaWanted[i] = 0;
  }
  for (let i = 0; i < P; i++) {
    let any = false;
    for (let g = 1; g < GROUPS; g++) if (gE[i * GROUPS + g]! > 0 || gR[i * GROUPS + g]! > 0) any = true;
    if (!any) continue;
    const months = hsaMonthsBefore65(run.birthIndex[i]!, ps.periodStart, ps.periodMonths);
    tax.contributionLimitsInto(ps.progTable, po, ps.age[i]!, ps.f, true, months, lim);
    // The deferral limit without catch-up: the same limits at an age that has none.
    tax.contributionLimitsInto(ps.progTable, po, 0, ps.f, true, months, base);
    // Employer plan.
    let k = i * GROUPS + LIMIT.EMPLOYER_PLAN;
    let e = gE[k]!;
    const r = gR[k]!;
    const ecap = e < lim[CL.EMPLOYEE_DEFERRAL]! ? e : lim[CL.EMPLOYEE_DEFERRAL]!;
    const counted = ecap < base[CL.EMPLOYEE_DEFERRAL]! ? ecap : base[CL.EMPLOYEE_DEFERRAL]!;
    const room = lim[CL.ANNUAL_ADDITIONS]! - counted;
    const rcap = r < room ? r : room > 0 ? room : 0;
    if (e > 0) sE[k] = ecap / e;
    if (r > 0) sR[k] = rcap / r;
    // IRA.
    k = i * GROUPS + LIMIT.IRA;
    e = gE[k]!;
    if (e > 0) {
      const ira = lim[CL.IRA]! < wagesLeft ? lim[CL.IRA]! : wagesLeft > 0 ? wagesLeft : 0;
      const cap = e < ira ? e : ira;
      sE[k] = cap / e;
      wagesLeft -= cap;
    }
    // HSA: the owner's limit (with the catch-up from 55), and its family part without the catch-up.
    k = i * GROUPS + LIMIT.HSA;
    const hsa = lim[CL.HSA]! > 0 ? lim[CL.HSA]! : 0;
    const family = base[CL.HSA]! > 0 ? base[CL.HSA]! : 0;
    hsaLimit[i] = hsa;
    hsaCatchUp[i] = hsa - family;
    hsaFamily[i] = family;
    hsaWanted[i] = gE[k]! + gR[k]!;
  }
  // A married couple shares one family limit (Pub. 969, "Rules for married people"; § 223(b)(5)):
  // while both spouses contribute (both are eligible individuals) and file jointly, the parts of
  // their HSA amounts above their own catch-ups are cut together to the family limit for the
  // months either is under 65, in proportion to the amounts entered (the household's division).
  if (P === 2 && ps.status === 1 && hsaWanted[0]! > 0 && hsaWanted[1]! > 0) {
    let shared = 0;
    const family = hsaFamily[0]! > hsaFamily[1]! ? hsaFamily[0]! : hsaFamily[1]!;
    for (let i = 0; i < 2; i++) {
      const x = hsaWanted[i]! < hsaLimit[i]! ? hsaWanted[i]! : hsaLimit[i]!;
      const c = x < hsaCatchUp[i]! ? x : hsaCatchUp[i]!;
      hsaCatchUp[i] = c;
      hsaWanted[i] = x - c;
      shared += x - c;
    }
    if (shared > family) {
      const scale = family / shared;
      for (let i = 0; i < 2; i++) hsaLimit[i] = hsaCatchUp[i]! + hsaWanted[i]! * scale;
    }
  }
  for (let i = 0; i < P; i++) {
    const k = i * GROUPS + LIMIT.HSA;
    const e = gE[k]!;
    const r = gR[k]!;
    const hsa = hsaLimit[i]!;
    const hr = r < hsa ? r : hsa;
    const he = e < hsa - hr ? e : hsa - hr;
    if (e > 0) sE[k] = he / e;
    if (r > 0) sR[k] = hr / r;
  }
  let excess = 0;
  let dropped = 0;
  for (let c = 0; c < C; c++) {
    const o = ct.owner[c]!;
    const g = ct.limit[c]!;
    const k = o >= 0 ? o * GROUPS + g : 0;
    const scaleE = g === LIMIT.NONE || o < 0 ? 1 : sE[k]!;
    const scaleR = g === LIMIT.NONE || o < 0 ? 1 : sR[k]!;
    const e0 = employee[c]!;
    const r0 = employer[c]!;
    const e = e0 * scaleE;
    const r = r0 * scaleR;
    excess += e0 - e;
    dropped += r0 - r;
    const a = ct.account[c]!;
    ps.deposit[a] = ps.deposit[a]! + e + r;
    ps.employeeTotal += e0;
    ps.employerTotal += r;
    const kind = ct.kind[c]!;
    if (kind === CONTRIB.PRE_TAX && o >= 0) ps.preTaxDeferral[o] = ps.preTaxDeferral[o]! + e;
    else if (kind === CONTRIB.ROTH && o >= 0) addRothContribution(ps.roth, o * RB_REC, e, ps.year);
  }
  if (excess > 0) {
    const sa = run.surplusAccount;
    ps.deposit[sa] = ps.deposit[sa]! + excess;
  }
  ps.contributionExcess = excess;
  noteWarning(ps.wn, WN.CONTRIBUTION_CAPPED, excess + dropped);
}

/**
 * The end of a year in which person `d` died and `s` lives on (seams C19, tax-rmd-ss §3.7.3): the
 * basis of every taxable holding moves toward its value, `basis += share × (value − basis)` (1 for
 * the decedent's own account, the joint share of `prepare` for a joint account, 0 for the
 * survivor's own), up or down; every account the decedent owned passes to the survivor; the
 * survivor's Roth record absorbs the decedent's, and with it an unknown contribution basis.
 */
function firstDeath(ps: PathState, d: number, s: number): void {
  const run = ps.run;
  const A = run.accountCount;
  const bal = ps.bal;
  const basis = ps.basis;
  const owner = ps.owner;
  for (let a = 0; a < A; a++) {
    if (run.treatment[a] === TAXABLE) {
      const share = owner[a] === d ? run.ownStepUp : owner[a] === -1 ? run.jointStepUp : 0;
      if (share > 0) {
        for (let j = 0; j < 3; j++) {
          const k = a * 3 + j;
          basis[k] = basis[k]! + share * (bal[k]! - basis[k]!);
        }
      }
    }
    if (owner[a] === d) owner[a] = s;
  }
  mergeRothAtDeath(ps.roth, s * RB_REC, d * RB_REC);
  if (ps.rothBasisUnknown[d] === 1) ps.rothBasisUnknown[s] = 1;
}

function recordFlows(ps: PathState, detail: PathDetail, t: number): void {
  const yearFlags = ps.yearFlags;
  const withdrawn = ps.withdrawn;
  const run = ps.run;
  const A = run.accountCount;
  const P = run.personCount;
  const yo = t * YR_REC;
  const yr = detail.year;
  yr[yo + YR.YEAR_FRACTION] = ps.f;
  yr[yo + YR.CPI_START] = ps.cpi[t]!;
  yr[yo + YR.PHASE] = ps.drawdown ? 1 : 0;
  yr[yo + YR.FILING_STATUS] = ps.status;
  yr[yo + YR.ASSESS_CALLS] = ps.calls;
  yr[yo + YR.FLAGS] = yearFlags;
  yr[yo + YR.CASH_INCOME] = ps.cashIncome;
  yr[yo + YR.EMPLOYEE] = ps.employeeTotal;
  yr[yo + YR.EMPLOYER] = ps.employerTotal;
  yr[yo + YR.CONTRIBUTION_EXCESS] = ps.contributionExcess;
  yr[yo + YR.RMD_TOTAL] = ps.rmdTotal;
  yr[yo + YR.WITHDRAWAL_TOTAL] = withdrawn;
  yr[yo + YR.CONVERSIONS] = ps.convTotal;
  yr[yo + YR.TAX] = ps.record.tax;
  yr[yo + YR.OTHER_CHARGES] = ps.record.otherCharges;
  yr[yo + YR.NET] = ps.record.net;
  yr[yo + YR.PAYROLL] = ps.payrollTotal;
  yr[yo + YR.PORTFOLIO_START] = ps.portfolio;
  yr[yo + YR.STOCK_SHARE] = ps.stockShare;
  yr[yo + YR.TAX_BASELINE] = ps.taxBaseline;
  for (let i = 0; i < P; i++) {
    detail.alive[t * P + i] = ps.alive[i]!;
    detail.age[t * P + i] = ps.age[i]!;
  }
  detail.income.set(ps.iy, t * IY_REC);
  detail.socialSecurity.set(ps.so, t * SO_REC);
  detail.payroll.set(ps.payroll, t * PT_REC);
  detail.taxIn.set(ps.taxIn, t * TAX_IN);
  detail.taxOut.set(ps.record.taxResult, t * TAX_OUT);
  detail.yields.set(ps.yields, t * A * TY_REC);
  const d = ps.decision;
  const o = ps.outcome;
  const so = t * SP_REC;
  const sp = detail.spending;
  sp[so + SP.SPEND] = d.spend;
  sp[so + SP.FLOOR] = d.floor;
  sp[so + SP.LUMP] = d.lump;
  sp[so + SP.LUMP_FLOOR] = d.lumpFloor;
  sp[so + SP.HEALTHCARE] = d.healthcare;
  sp[so + SP.GROSS] = d.gross;
  sp[so + SP.PLANNED] = d.planned;
  sp[so + SP.RULE] = d.rule;
  sp[so + SP.NEED] = o.need;
  sp[so + SP.FLOOR_NEED] = o.floorNeed;
  sp[so + SP.PLANNED_NEED] = o.plannedNeed;
  sp[so + SP.FUNDED] = o.funded;
  sp[so + SP.SHORTFALL] = o.shortfall;
  sp[so + SP.SURPLUS] = o.surplus;
  const sa = run.surplusAccount;
  for (let a = 0; a < A; a++) {
    const ao = (t * A + a) * AC_REC;
    const ac = detail.account;
    ac[ao + AC.START] = ps.value[a]!;
    ac[ao + AC.RMD] = ps.rmd[a]!;
    ac[ao + AC.WITHDRAWAL] = ps.w[a]!;
    ac[ao + AC.CONV_OUT] = ps.convOut[a]!;
    ac[ao + AC.CONV_IN] = ps.convIn[a]!;
    ac[ao + AC.DEPOSIT] = ps.deposit[a]!;
    ac[ao + AC.SURPLUS] = a === sa ? o.surplus : 0;
    ac[ao + AC.GAIN] = ps.gain[a]!;
    ac[ao + AC.AVAILABLE] = ps.available[a]!;
    ac[ao + AC.OWNER] = ps.owner[a]!;
    ac[ao + AC.SOLD] = ps.sold[a]!;
    ac[ao + AC.BOUGHT] = ps.bought[a]!;
  }
  detail.afterTrades.set(ps.afterTrades, t * A * 3);
}

function recordEnd(ps: PathState, detail: PathDetail, t: number): void {
  const interestIn = ps.interestIn;
  const interestOut = ps.interestOut;
  const endTotal = ps.endTotal;
  const A = ps.run.accountCount;
  const yo = t * YR_REC;
  detail.year[yo + YR.CPI_END] = ps.cpi[t + 1]!;
  detail.year[yo + YR.INTEREST_CARRIED_IN] = interestIn;
  detail.year[yo + YR.INTEREST_CARRIED_OUT] = interestOut;
  let after = 0;
  for (let k = 0; k < A * 3; k++) after += ps.afterTrades[k]!;
  detail.year[yo + YR.AFTER_TRADES_TOTAL] = after;
  detail.year[yo + YR.END_TOTAL] = endTotal;
  detail.year[yo + YR.END_TOTAL_REAL] = ps.totalReal[t]!;
  detail.end.set(ps.bal, t * A * 3);
  detail.endBasis.set(ps.basis, t * A * 3);
}
