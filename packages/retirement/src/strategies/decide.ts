/**
 * `decideSpending(view, state, out)`: the spending hook (strategies-outputs-web decisions 2 to 7,
 * §3.3 and §3.4; engine-and-returns §4.3; seams §2.3 step 3, C35, C40).
 *
 * | Phase of the year | Test                                         | Decision                                              |
 * | ----------------- | -------------------------------------------- | ----------------------------------------------------- |
 * | Accumulation      | `view.phase = 0`                             | `spend = floor = 0`, `lump = goals`, `lumpFloor = 0`  |
 * | Transition        | drawdown, and some living person still works | the `constant_dollar` decision; state untouched       |
 * | Retirement        | drawdown, and every living person is retired | the chosen strategy                                   |
 *
 * In every drawdown year `healthcare` is the HSA's qualified cap, `lump = lumpFloor = goals` and
 * `planned = corePlanned + healthcare + longTermCare` (healthcare not included in base). Target
 * years (`constant_dollar`, `guardrails`, `floor_ceiling`) set `spend = floor = C + healthcare +
 * longTermCare`; gross years (`fixed_percentage`, `vpw`) set `gross` and `spend = floor =
 * essentialCore + healthcare + longTermCare`.
 *
 * Pure apart from `out` and the strategy state; allocates nothing; no banned `Math` call (decision
 * 38). The `PlannedYear` scratch is module-level: one per thread, used only inside one call.
 */

import { floorCeilingCore } from "./floorCeiling.js";
import { guardrailsCore } from "./guardrails.js";
import { createPlannedYear, plannedYearOf } from "./planned.js";
import { STRATEGY } from "./prepare.js";
import type { SpendDecision, SpendingView } from "./types.js";
import { fixedPercentageGross, vpwGross } from "./vpw.js";

const PY = createPlannedYear();

/** Whether every living person is retired this year (the retirement phase of a drawdown year). */
export function everyLivingRetired(view: SpendingView, personCount: number): boolean {
  for (let i = 0; i < personCount; i++) {
    if (view.alive[i] !== 0 && view.retired[i] === 0) return false;
  }
  return true;
}

export function decideSpending(view: SpendingView, state: Float64Array, out: SpendDecision): void {
  const tb = view.strategies;
  plannedYearOf(view, PY);
  out.lump = PY.goals;
  out.gross = Number.NaN;
  out.rule = 0;
  if (view.phase === 0) {
    out.spend = 0;
    out.floor = 0;
    out.lumpFloor = 0;
    out.healthcare = 0;
    out.planned = 0;
    return;
  }
  out.lumpFloor = PY.goals;
  out.healthcare = PY.healthcareCap;
  const scheduled = PY.healthcare + PY.longTermCare;
  out.planned = PY.corePlanned + scheduled;

  let spend = PY.corePlanned + scheduled;
  if (everyLivingRetired(view, tb.personCount)) {
    switch (tb.kind) {
      case STRATEGY.fixed_percentage:
        fixedPercentageGross(tb, PY, out);
        spend = PY.essentialCore + scheduled;
        break;
      case STRATEGY.vpw:
        vpwGross(view, tb, PY, out);
        spend = PY.essentialCore + scheduled;
        break;
      case STRATEGY.guardrails:
        guardrailsCore(view, tb, state, PY, out);
        spend = out.spend + scheduled;
        break;
      case STRATEGY.floor_ceiling:
        floorCeilingCore(tb, state, PY, out);
        spend = out.spend + scheduled;
        break;
      default:
        break;
    }
  }
  out.spend = spend;
  out.floor = spend;
}
