/**
 * What the year's spending decision means once the withdrawals are settled (strategies-outputs-web
 * §3.8 and §3.9; engine-and-returns §3.7 steps 3 to 5 and §3.11; seams C40's gross-year branch and
 * below-plan flag). Pure arithmetic the loop calls twice a year: `fillNeeds` before the withdrawals
 * (the `need` that `assess` subtracts) and `settleSpending` after the record call of `assess`.
 *
 * - `need = spend × f + lump`, `floorNeed = floor × f + lumpFloor`, `plannedNeed = planned × f + lump`
 *   (in accumulation `spend = floor = lumpFloor = planned = 0`, so `need = lump`, `floorNeed = 0`).
 * - `net < 0`: `shortfall = min(need, −net)`, `funded = need − shortfall`, nothing saved.
 * - `net ≥ 0` in a target or accumulation year (`gross` NaN): `funded = need`, `surplus = net`.
 * - `net ≥ 0` in a gross year: `excess = max(0, Σ rmd − (gross × f + lump))`,
 *   `extra = max(0, net − excess)`, `funded = need + extra`, `surplus = net − extra`: the rule's
 *   money is spent and only RMDs the rule did not call for are saved.
 * - Failure: `funded + CASH_TOL < floorNeed` in a drawdown year. Below plan: `funded + CASH_TOL <
 *   plannedNeed` in a drawdown year.
 */

import { CASH_TOL } from "../constants.js";
import { doubleFields } from "../doubleFields.js";
import type { SpendDecision } from "./types.js";

export interface SpendingOutcome {
  /** Dollars of the year's period (recurring amounts × f, lumps whole). */
  need: number;
  floorNeed: number;
  plannedNeed: number;
  funded: number;
  shortfall: number;
  /** Cash saved to the surplus account. */
  surplus: number;
  /** The floor was not funded (a drawdown year only). */
  failed: boolean;
  /** Funded spending fell below the plan (a drawdown year only). */
  belowPlan: boolean;
}

export function createSpendingOutcome(): SpendingOutcome {
  const o: SpendingOutcome = { need: 0, floorNeed: 0, plannedNeed: 0, funded: 0, shortfall: 0, surplus: 0, failed: false, belowPlan: false };
  return doubleFields(o, ["need", "floorNeed", "plannedNeed", "funded", "shortfall", "surplus"]);
}

/**
 * The settlement's inputs as one record (`fillNeedsFor`, `settleSpendingFor`): the year loop's form,
 * because V8 boxes a double passed to a call it does not inline, and these are passed every year.
 */
export interface SettleInput {
  /** f, the year fraction. */
  yearFraction: number;
  /** The view's phase is drawdown. */
  drawdown: boolean;
  /** The record call's net cash (after tax and `need`). */
  net: number;
  /** The year's RMDs, all accounts. */
  rmdTotal: number;
}

export function createSettleInput(): SettleInput {
  const s: SettleInput = { yearFraction: 1, drawdown: false, net: 0, rmdTotal: 0 };
  return doubleFields(s, ["yearFraction", "net", "rmdTotal"]);
}

/** The scalar forms' record. */
const SCALAR = createSettleInput();

/** The period's need, floor and planned need of a decision (f = the year fraction). */
export function fillNeeds(decision: SpendDecision, f: number, out: SpendingOutcome): void {
  SCALAR.yearFraction = f;
  fillNeedsFor(decision, SCALAR, out);
}

/** `fillNeeds` with f from `s.yearFraction`. */
export function fillNeedsFor(decision: SpendDecision, s: SettleInput, out: SpendingOutcome): void {
  const f = s.yearFraction;
  out.need = decision.spend * f + decision.lump;
  out.floorNeed = decision.floor * f + decision.lumpFloor;
  out.plannedNeed = decision.planned * f + decision.lump;
}

/**
 * Settles the year's spending from the record call's `net` (cash left after tax and `need`) and the
 * year's total RMDs. `drawdown` is the view's phase (1) — failure and below-plan exist only there.
 */
export function settleSpending(decision: SpendDecision, f: number, drawdown: boolean, net: number, rmdTotal: number, out: SpendingOutcome): void {
  SCALAR.yearFraction = f;
  SCALAR.drawdown = drawdown;
  SCALAR.net = net;
  SCALAR.rmdTotal = rmdTotal;
  settleSpendingFor(decision, SCALAR, out);
}

/**
 * `settleSpending` with its inputs from the record `s`. Every case's figures are computed and the
 * results chosen among them (the module comment's three cases): an operation first reached in a
 * case the warm-up never saw (the first shortfall of a run) deoptimizes the loop's function that
 * inlined this one, which then runs unoptimized and allocates until it is compiled again. In a
 * target year the gross-year figures are NaN and not chosen.
 */
export function settleSpendingFor(decision: SpendDecision, s: SettleInput, out: SpendingOutcome): void {
  const f = s.yearFraction;
  const drawdown = s.drawdown;
  const net = s.net;
  const rmdTotal = s.rmdTotal;
  fillNeedsFor(decision, s, out);
  const need = out.need;
  const short = net < 0;
  const target = Number.isNaN(decision.gross);
  // net < 0: the shortfall, at most the need.
  const unfunded = -net;
  const shortfall = unfunded < need ? unfunded : need;
  const fundedShort = need - shortfall;
  // A gross year: only the RMDs the rule did not call for are saved.
  const released = decision.gross * f + decision.lump;
  const overRule = rmdTotal - released;
  const excess = rmdTotal > released ? overRule : 0;
  const spendable = net - excess;
  const extra = net > excess ? spendable : 0;
  const fundedGross = need + extra;
  const surplusGross = net - extra;
  out.shortfall = short ? shortfall : 0;
  out.funded = short ? fundedShort : target ? need : fundedGross;
  out.surplus = short ? 0 : target ? net : surplusGross;
  out.failed = drawdown && out.funded + CASH_TOL < out.floorNeed;
  out.belowPlan = drawdown && out.funded + CASH_TOL < out.plannedNeed;
}
