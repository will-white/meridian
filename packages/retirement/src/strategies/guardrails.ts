/**
 * Guardrails (Guyton and Klinger 2006) on a reference withdrawal track (strategies-outputs-web
 * decision 15 and §3.4 (c)).
 *
 * The rules compare only the current withdrawal rate with the initial one, so they run on the
 * track's cumulative real adjustment `a` alone: `ρ = a × x0 × cpi ÷ P` with `x0 = P_R ÷ cpi_R` of the
 * start year R. In a year after a loss (`r₋₁ < 0`) with positive inflation and `ρ > 1` the inflation
 * raise is skipped (`a ÷= 1 + π₋₁`, never made up); then a cut (`a ×= 1 − cut`) when
 * `ρ > 1 + upper` outside the final `cutoffYears`, else, unless frozen, a raise (`a ×= 1 + raise`)
 * when `ρ < 1 − lower`. With `P ≤ 0` no rule is applied and `a` is kept; a rule that never saw a
 * positive `P` never starts and spending is the plan.
 *
 * The factor scales the portfolio-funded part of the plan, `planDraw = max(0, corePlanned + H − G)`
 * (H the healthcare added to spending, G the year's gross recurring income): `C = corePlanned −
 * (1 − a) × planDraw`, never below the essential core. With no income, healthcare or phases this
 * is `C = a × corePlanned`, the published rule.
 */

import type { PlannedYear } from "./planned.js";
import type { StrategyTables } from "./prepare.js";
import { RULE, SLOT, type SpendDecision, type SpendingView } from "./types.js";

/** Writes the guardrail year's core spending into `out.spend` (before healthcare and care) and its flags into `out.rule`. */
export function guardrailsCore(view: SpendingView, tb: StrategyTables, state: Float64Array, py: PlannedYear, out: SpendDecision): void {
  const gk = tb.gk;
  const P = py.spendable;
  const cpi = view.cpi;
  let rule = 0;
  if (state[SLOT.STARTED] === 0) {
    if (P > 0) {
      state[SLOT.STARTED] = 1;
      state[SLOT.X0] = P / cpi;
      state[SLOT.ADJUST] = 1;
    }
  } else if (P > 0) {
    let a = state[SLOT.ADJUST]!;
    let rho = (a * state[SLOT.X0]! * cpi) / P;
    let froze = false;
    const inflation = view.prevInflation;
    if (gk.skipAfterLoss === 1 && inflation > 0 && view.prevPortfolioReturn < 0 && rho > 1) {
      a = a / (1 + inflation);
      rho = rho / (1 + inflation);
      froze = true;
      rule |= RULE.FREEZE;
    }
    if (rho > 1 + gk.upper && yearsRemaining(view, tb) > gk.cutoffYears) {
      a = a * (1 - gk.cut);
      rule |= RULE.CUT;
    } else if (!froze && rho < 1 - gk.lower) {
      a = a * (1 + gk.raise);
      rule |= RULE.RAISE;
    }
    state[SLOT.ADJUST] = a;
  }
  const a = state[SLOT.STARTED] === 1 ? state[SLOT.ADJUST]! : 1;
  const income = view.wages + view.guaranteedIncome + view.otherIncome;
  const need = py.corePlanned + py.healthcare - income;
  const planDraw = need > 0 ? need : 0;
  let core = py.corePlanned - (1 - a) * planDraw;
  if (core < py.essentialCore) {
    core = py.essentialCore;
    rule |= RULE.ESSENTIALS;
  }
  out.spend = core;
  out.rule |= rule;
}

/** `max over living people of horizonYear[i] − year + 1`. */
export function yearsRemaining(view: SpendingView, tb: StrategyTables): number {
  let best = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < tb.personCount; i++) {
    if (view.alive[i] === 0) continue;
    const r = tb.horizonYear[i]! - view.year + 1;
    if (r > best) best = r;
  }
  return best;
}
