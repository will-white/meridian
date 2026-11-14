/**
 * `assess(w, out)`: the year's tax and net cash for a candidate withdrawal vector (engine-and-returns
 * §3.9 with seams §2.6, C17, C18, C23, C27, C30, C31, F1, F2). The engine owns the assembly of the
 * tax input; the tax area owns the functions it calls (through the injectable `TaxFunctions`
 * record); the strategies area owns the order and the solver that call `assess`.
 *
 * For a candidate `w[a]` (dollars per account):
 *
 * 1. Each account's flow is `netOut = w + rmd + convOut − deposit − convIn`. A taxable account's
 *    trades are previewed with `planTrades(…, apply = false)`: the gain they realize and the
 *    post-trade balances and basis, on which `taxableYieldsInto` gives the period's dividends (and
 *    their qualified part), taxable and tax-exempt bond interest (`max(0, billRef + spread)`, C18)
 *    and gain distributions (C17).
 * 2. Distributions by owner, into per-person scratch (F1: person 0, person 1 and the household,
 *    `PP` slots, summed into the `TI` slots so a state-tax hook can later read them per person):
 *    pre-tax `rmd + w` to `TRAD_DIST` with the 10% base of `preTaxPenaltyBase` (withdrawals only;
 *    RMDs and conversions never enter a penalty base); the person's Roth withdrawals through
 *    `rothWithdraw` on a scratch copy of the person's `RB` record (`ROTH_TAXABLE`, the Roth part of
 *    `PEN10_BASE`); the person's HSA withdrawals through `hsaWithdraw` with the year's qualified
 *    medical spending shared in proportion to the withdrawals (`HSA_TAXABLE`, `PEN20_BASE`).
 * 3. The other slots (§2.6): `WAGES` = gross wages less the year's employee contributions to
 *    pre-tax and HSA accounts after the caps (per person, at least 0); `PENSION` = pensions and
 *    annuities × `taxableBp` (per person, the household column for a household stream);
 *    `INTEREST` = last year's bill and cash interest (carried) plus this year's taxable bond
 *    interest; `TAX_EXEMPT_INTEREST`; `ORD_DIV` and `QUAL_DIV`; `ST_GAIN` = 0; `LT_GAIN` = the
 *    previewed trades' gains plus gain distributions; `LOSS_CARRY_IN`; `ROTH_CONV` = the scheduled
 *    conversions (per person); `SS_GROSS` = the period's benefits (per person); `RENTAL` and
 *    `OTHER_ORD` from the streams; `ADJUSTMENTS` = 0; `N_AGED`; `YEAR_FRACTION` = f. Every amount is
 *    the period's: nothing is divided by f here (C23, inside `federalTaxInto` only).
 * 4. `net`, with `otherCharges` = 0 in v1 (F2):
 *    - drawdown: `cash income + Σ rmd + Σ w − employee contributions − payroll tax − need − tax − otherCharges`
 *      (C27: the payroll tax is a cash use beside the federal tax); in the first drawdown year with
 *      months before `spending.startMonth`, those months are accumulation months (the Stage A
 *      review's engine-01, plan decision 7): `− (tax − taxBaseline) − preStartCash`, where the
 *      baseline is the tax on their income alone and `preStartCash` their take-home (loop.ts
 *      `preStartYear`); both are 0 in every other drawdown year;
 *    - accumulation: `Σ rmd + Σ w − need − (tax − taxBaseline) − (otherCharges − otherBaseline)`,
 *      where the baseline is the same assessment with no RMD and no withdrawal (wages pay it, and
 *      with it the tax on dividends, conversions and the rebalancing of contributions).
 *
 * `assessInto` writes the scratch of `PathState` (the per-account `gain` and `yields`, `taxIn`,
 * `pp`, `rothW`, `hsaW`), which therefore holds the last evaluation: the loop's record call is the
 * last one before the trades are applied. Nothing is allocated.
 */

import { EngineInvariantError } from "./errors.js";
import { INCOME, IY } from "./flows.js";
import { ASSESS_MAX_CALLS, type AssessFn, type Assessment } from "./hooks.js";
import { BONDS, STOCKS } from "./models/index.js";
import { TREATMENT } from "./prepare.js";
import type { PathState } from "./state.js";
import { HW, HW_REC, RB_REC, RW, RW_REC, SO, TAX_IN, TI, TO, TY, TY_REC, accountDragOffset, taxOffset } from "./tax/layout.js";
import { planTradesFrom } from "./trades.js";

/** Slots of `PathState.carry`: tax state carried from one plan year to the next (engine-and-returns §3.9). */
export const CARRY = {
  /** Bill interest of taxable and cash accounts earned last year, taxed this year (C17 item 5). */
  BILL_INTEREST: 0,
  /** The capital loss carried into this year (`TO.LOSS_CARRY_OUT` of last year; `lossCarryIn` in year 0). */
  LOSS: 1,
  /** `TO.MAGI_IRMAA ÷ f` of the last two years (seams F3, C23), kept for Phase 5's IRMAA look-back. */
  MAGI_1: 2,
  MAGI_2: 3,
} as const;
export const CARRY_REC = 4;

/** Per-person scratch slots (seams F1), one record per column: person 0, person 1, the household. */
export const PP = {
  /** Gross wages less pre-tax and HSA employee contributions, at least 0. */
  WAGES: 0,
  /** The taxable part of pensions and annuities. */
  PENSION: 1,
  /** Pre-tax distributions: RMDs and withdrawals. */
  TRAD_DIST: 2,
  /** The period's Social Security benefits. */
  SS_GROSS: 3,
  /** Scheduled conversions out of the person's pre-tax accounts. */
  ROTH_CONV: 4,
  ROTH_TAXABLE: 5,
  HSA_TAXABLE: 6,
  PEN10_BASE: 7,
  PEN20_BASE: 8,
  RESERVED0: 9,
} as const;
export const PP_REC = 10;
/** Columns of the per-person scratch: person 0, person 1 and the household (household streams). */
export const PP_COLUMNS = 3;
export const PP_HOUSEHOLD = 2;

/** The `PP` slots summed into `TI` slots, in pairs. */
const PP_TO_TI: readonly number[] = [
  PP.WAGES, TI.WAGES,
  PP.PENSION, TI.PENSION,
  PP.TRAD_DIST, TI.TRAD_DIST,
  PP.SS_GROSS, TI.SS_GROSS,
  PP.ROTH_CONV, TI.ROTH_CONV,
  PP.ROTH_TAXABLE, TI.ROTH_TAXABLE,
  PP.HSA_TAXABLE, TI.HSA_TAXABLE,
  PP.PEN10_BASE, TI.PEN10_BASE,
  PP.PEN20_BASE, TI.PEN20_BASE,
];

const TAXABLE = TREATMENT.taxable;
const PRE_TAX = TREATMENT.pre_tax;
const ROTH = TREATMENT.roth;
const HSA = TREATMENT.hsa;

/**
 * The year's fixed part of the tax input, once a year after the flows of steps 1 to 3b (the loop
 * calls it): the per-person wages, pensions, benefits and conversions; in an accumulation year the
 * baseline assessment too.
 */
export function prepareAssessYear(ps: PathState): void {
  const run = ps.run;
  const fixed = ps.ppFixed;
  for (let k = 0; k < PP_COLUMNS * PP_REC; k++) fixed[k] = 0;
  const P = run.personCount;
  for (let i = 0; i < P; i++) {
    const wages = ps.grossWages[i]! - ps.preTaxDeferral[i]!;
    fixed[i * PP_REC + PP.WAGES] = wages > 0 ? wages : 0;
    fixed[i * PP_REC + PP.SS_GROSS] = ps.so[SO.BENEFIT + i]!;
  }
  // Pensions and annuities by recipient: the owner while alive, the survivor after (survivor share), the household column for a household stream.
  const inc = run.incomes;
  const amounts = ps.streamAmounts;
  for (let s = 0; s < inc.count; s++) {
    const x = amounts[s]!;
    if (x === 0 || inc.kind[s] !== INCOME.PENSION) continue;
    const owner = inc.person[s]!;
    const column = owner < 0 ? PP_HOUSEHOLD : ps.alive[owner] === 1 ? owner : 1 - owner;
    fixed[column * PP_REC + PP.PENSION] = fixed[column * PP_REC + PP.PENSION]! + x * inc.taxableShare[s]!;
  }
  const A = run.accountCount;
  for (let a = 0; a < A; a++) {
    const out = ps.convOut[a]!;
    if (out > 0) {
      const o = ps.owner[a]!;
      fixed[o * PP_REC + PP.ROTH_CONV] = fixed[o * PP_REC + PP.ROTH_CONV]! + out;
    }
  }
  if (ps.drawdown) {
    // 0, or in the first drawdown year the tax its months before spending.startMonth pay themselves (engine-01).
    ps.taxBaseline = ps.preStartTax;
    ps.otherBaseline = 0;
  } else {
    assessInto(ps, ps.zeroW, false, ps.baseline);
    ps.taxBaseline = ps.baseline.tax;
    ps.otherBaseline = ps.baseline.otherCharges;
  }
}

/**
 * One assessment of the candidate `w` into `out`. `includeRmd` is false only for the accumulation
 * baseline (no RMD, no withdrawal). Writes the scratch of `ps` (module comment).
 */
export function assessInto(ps: PathState, w: Float64Array, includeRmd: boolean, out: Assessment): void {
  const run = ps.run;
  const tax = ps.tax;
  const A = run.accountCount;
  const P = run.personCount;
  const t = ps.t;
  const f = ps.f;
  const year = ps.year;
  const treatment = run.treatment;
  const owner = ps.owner;
  const rmd = ps.rmd;
  const pp = ps.pp;
  const fixed = ps.ppFixed;
  for (let k = 0; k < PP_COLUMNS * PP_REC; k++) pp[k] = fixed[k]!;
  const rothW = ps.rothW;
  const hsaW = ps.hsaW;
  rothW[0] = 0;
  rothW[1] = 0;
  hsaW[0] = 0;
  hsaW[1] = 0;

  let withdrawn = 0;
  let gains = 0;
  let dividends = 0;
  let qualified = 0;
  let interest = 0;
  let exempt = 0;
  const yields = ps.yields;
  for (let a = 0; a < A; a++) {
    const x = w[a]!;
    const r = includeRmd ? rmd[a]! : 0;
    withdrawn += x;
    const tr = treatment[a]!;
    if (tr === TAXABLE) {
      ps.netOut[a] = x + r + ps.convOut[a]! - ps.deposit[a]! - ps.convIn[a]!;
      previewTaxable(ps, a);
      const yo = a * TY_REC;
      gains += ps.gain[a]! + yields[yo + TY.GAIN_DISTRIBUTIONS]!;
      dividends += yields[yo + TY.DIVIDENDS]!;
      qualified += yields[yo + TY.QUALIFIED_DIVIDENDS]!;
      interest += yields[yo + TY.INTEREST]!;
      exempt += yields[yo + TY.TAX_EXEMPT_INTEREST]!;
    } else if (tr === PRE_TAX) {
      const o = owner[a]! * PP_REC;
      pp[o + PP.TRAD_DIST] = pp[o + PP.TRAD_DIST]! + x + r;
      // preTaxPenaltyBase(x, …) = x × the year's share (the record's function at one dollar, state.ts).
      if (x > 0) pp[o + PP.PEN10_BASE] = pp[o + PP.PEN10_BASE]! + x * ps.preTaxShare[a]!;
    } else if (tr === ROTH) {
      rothW[owner[a]!] = rothW[owner[a]!]! + x;
    } else if (tr === HSA) {
      hsaW[owner[a]!] = hsaW[owner[a]!]! + x;
    }
  }

  // Roth: the ordering on a scratch copy of the person's record (the real record changes only when the year is applied).
  const rw = ps.rw;
  const scratch = ps.rothScratch;
  for (let i = 0; i < 2; i++) {
    const ro = i * RW_REC;
    const amount = i < P ? rothW[i]! : 0;
    if (!(amount > 0)) {
      for (let k = 0; k < RW_REC; k++) rw[ro + k] = 0;
      continue;
    }
    const so = i * RB_REC;
    for (let k = 0; k < RB_REC; k++) scratch[k] = ps.roth[so + k]!;
    tax.rothWithdraw(scratch, 0, amount, ps.early[i]!, year, ps.rwScratch);
    for (let k = 0; k < RW_REC; k++) rw[ro + k] = ps.rwScratch[k]!;
    pp[i * PP_REC + PP.ROTH_TAXABLE] = pp[i * PP_REC + PP.ROTH_TAXABLE]! + ps.rwScratch[RW.TAXABLE]!;
    pp[i * PP_REC + PP.PEN10_BASE] = pp[i * PP_REC + PP.PEN10_BASE]! + ps.rwScratch[RW.PENALTY_BASE]!;
  }

  // HSA: the year's qualified medical spending, shared in proportion to each person's withdrawal.
  const hw = ps.hw;
  const hsaTotal = hsaW[0]! + hsaW[1]!;
  for (let i = 0; i < 2; i++) {
    const ho = i * HW_REC;
    const amount = hsaW[i]!;
    if (!(amount > 0)) {
      hw[ho + HW.TAXABLE] = 0;
      hw[ho + HW.PENALTY_BASE] = 0;
      continue;
    }
    tax.hsaWithdraw(amount, (ps.qualifiedMedical * amount) / hsaTotal, ps.early65[i]!, ps.hwScratch);
    hw[ho + HW.TAXABLE] = ps.hwScratch[HW.TAXABLE]!;
    hw[ho + HW.PENALTY_BASE] = ps.hwScratch[HW.PENALTY_BASE]!;
    pp[i * PP_REC + PP.HSA_TAXABLE] = pp[i * PP_REC + PP.HSA_TAXABLE]! + ps.hwScratch[HW.TAXABLE]!;
    pp[i * PP_REC + PP.PEN20_BASE] = pp[i * PP_REC + PP.PEN20_BASE]! + ps.hwScratch[HW.PENALTY_BASE]!;
  }

  // The tax input (seams §2.6): every slot written, the per-person columns summed.
  const ti = ps.taxIn;
  for (let k = 0; k < TAX_IN; k++) ti[k] = 0;
  for (let p = 0; p < PP_TO_TI.length; p += 2) {
    const slot = PP_TO_TI[p]!;
    ti[PP_TO_TI[p + 1]!] = pp[slot]! + pp[PP_REC + slot]! + pp[2 * PP_REC + slot]!;
  }
  const iy = ps.iy;
  ti[TI.INTEREST] = ps.carry[CARRY.BILL_INTEREST]! + interest;
  ti[TI.TAX_EXEMPT_INTEREST] = exempt;
  ti[TI.ORD_DIV] = dividends;
  ti[TI.QUAL_DIV] = qualified;
  ti[TI.LT_GAIN] = gains;
  ti[TI.LOSS_CARRY_IN] = ps.carry[CARRY.LOSS]!;
  ti[TI.RENTAL] = iy[IY.RENTAL]!;
  ti[TI.OTHER_ORD] = iy[IY.OTHER_ORD]!;
  ti[TI.N_AGED] = ps.nAged;
  ti[TI.YEAR_FRACTION] = f;
  tax.federalTaxInto(ps.taxTable, taxOffset(t, ps.status), ti, out.taxResult);

  const total = out.taxResult[TO.TOTAL]!;
  const other = 0;
  out.tax = total;
  out.otherCharges = other;
  out.net = ps.drawdown
    ? ps.cashIncome + ps.rmdTotal + withdrawn - ps.employeeTotal - ps.payrollTotal - ps.need - (total - ps.taxBaseline) - other - ps.preStartCash
    : ps.rmdTotal + withdrawn - ps.need - (total - ps.taxBaseline) - (other - ps.otherBaseline);
}

/**
 * A taxable account's previewed trade for the flow `ps.netOut[a]` (`planTradesFrom`, apply =
 * false): the gain it realizes into `ps.gain[a]` and, on the post-trade balances and basis, the
 * period's yields into `ps.yields` (`TY` at `a × TY_REC`). Its own function, so that the tax
 * area's `taxableYieldsInto` is inlined here and its double arguments are not boxed.
 */
function previewTaxable(ps: PathState, a: number): void {
  const run = ps.run;
  const A = run.accountCount;
  const t = ps.t;
  const bal = ps.bal;
  const basis = ps.basis;
  const trade = ps.trade;
  const off = a * 3;
  planTradesFrom(bal, basis, off, run.weights, (t * A + a) * 3, ps.netOut, a, run.tradeMode, true, false, trade);
  // The basis after the previewed trade (planTrades' arithmetic).
  const bS = bal[off + STOCKS]!;
  const sS = trade.sell[STOCKS]!;
  let stockBasis = basis[off + STOCKS]!;
  if (bS > 0 && sS > 0) stockBasis = sS >= bS ? 0 : stockBasis - (sS * stockBasis) / bS;
  stockBasis += trade.buy[STOCKS]!;
  const bB = bal[off + BONDS]!;
  const sB = trade.sell[BONDS]!;
  let bondBasis = basis[off + BONDS]!;
  if (bB > 0 && sB > 0) bondBasis = sB >= bB ? 0 : bondBasis - (sB * bondBasis) / bB;
  bondBasis += trade.buy[BONDS]!;
  // taxableYieldsInto writes TY slots from index 0; copied to the account's record.
  const ty = ps.tyScratch;
  ps.tax.taxableYieldsInto(run.accountDrag, accountDragOffset(t, a, A), ps.billRef, ps.f, trade.post[STOCKS]!, trade.post[BONDS]!, stockBasis, bondBasis, ty);
  const yo = a * TY_REC;
  for (let k = 0; k < TY_REC; k++) ps.yields[yo + k] = ty[k]!;
  ps.gain[a] = trade.realizedGain;
}

/**
 * The `assess` handed to the withdrawal hook: counts the year's calls (`ps.calls`, reset by the
 * loop) and raises `EngineInvariantError("assess_calls")` on call `ASSESS_MAX_CALLS + 1`. Created
 * once per thread.
 */
export function createAssessFn(ps: PathState): AssessFn {
  return (w: Float64Array, out: Assessment): void => {
    ps.calls += 1;
    if (ps.calls > ASSESS_MAX_CALLS) {
      throw new EngineInvariantError("assess_calls", `a withdrawal hook may call assess at most ${ASSESS_MAX_CALLS} times a year (plan year ${ps.t}, path ${ps.pathIndex})`);
    }
    assessInto(ps, w, true, out);
  };
}

