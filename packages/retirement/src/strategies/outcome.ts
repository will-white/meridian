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
  return { need: 0, floorNeed: 0, plannedNeed: 0, funded: 0, shortfall: 0, surplus: 0, failed: false, belowPlan: false };
}

/** The period's need, floor and planned need of a decision (f = the year fraction). */
export function fillNeeds(decision: SpendDecision, f: number, out: SpendingOutcome): void {
  out.need = decision.spend * f + decision.lump;
  out.floorNeed = decision.floor * f + decision.lumpFloor;
  out.plannedNeed = decision.planned * f + decision.lump;
}

/**
 * Settles the year's spending from the record call's `net` (cash left after tax and `need`) and the
 * year's total RMDs. `drawdown` is the view's phase (1) — failure and below-plan exist only there.
 */
export function settleSpending(decision: SpendDecision, f: number, drawdown: boolean, net: number, rmdTotal: number, out: SpendingOutcome): void {
  fillNeeds(decision, f, out);
  const need = out.need;
  if (net < 0) {
    const shortfall = -net < need ? -net : need;
    out.shortfall = shortfall;
    out.funded = need - shortfall;
    out.surplus = 0;
  } else if (Number.isNaN(decision.gross)) {
    out.shortfall = 0;
    out.funded = need;
    out.surplus = net;
  } else {
    const released = decision.gross * f + decision.lump;
    const excess = rmdTotal > released ? rmdTotal - released : 0;
    const extra = net > excess ? net - excess : 0;
    out.shortfall = 0;
    out.funded = need + extra;
    out.surplus = net - extra;
  }
  out.failed = drawdown && out.funded + CASH_TOL < out.floorNeed;
  out.belowPlan = drawdown && out.funded + CASH_TOL < out.plannedNeed;
}
