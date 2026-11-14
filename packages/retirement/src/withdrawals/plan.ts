/**
 * `planWithdrawals(view, decision, assess, w)`: the default withdrawal order and the gross-up
 * (strategies-outputs-web §3.6, decisions 3, 7, 18 to 22; engine-and-returns §3.9; seams §2.3 steps
 * 4 and 5, C31, C33, C34, F4). The engine has taken the RMDs and the scheduled conversions; this
 * hook decides how much more leaves which account, and `assess` (the engine's) prices a candidate.
 *
 * `net(x)` = `fill(x, w)`, `assess(w)`, its `net` (the cash left after the year's tax and need);
 * `total` = everything the tiers hold; `TOL = CASH_TOL`.
 *
 * Target and accumulation years (`decision.gross` NaN):
 *
 * ```
 * h0 = net(0)                                  call 1
 * h0 ≥ −TOL:  w = 0                            income and RMDs cover the year; the loop saves the rest
 * hT = net(total)                              call 2
 * hT ≤ TOL:   w = fill(total)                  short (the loop records the shortfall) or exactly enough
 * otherwise   w = fill(solve(0, h0, total, hT))
 * ```
 *
 * Gross years (the rule sets the gross portfolio withdrawal; `need` is the floor):
 *
 * ```
 * wd = min(total, max(0, gross × f + lump − Σ rmd))   what the rule still releases after the RMDs
 * h1 = net(wd)                                 call 1
 * h1 ≥ −TOL or wd = total:  w = fill(wd)       the rule's withdrawal pays the floor (or nothing more exists)
 * hT = net(total)                              call 2
 * hT ≤ TOL:   w = fill(total)
 * otherwise   w = fill(solve(wd, h1, total, hT))   topped up to the floor
 * ```
 *
 * In a target year with nothing to take (`total = 0`) the second evaluation would repeat the first
 * and is skipped. The hook makes at most `ASSESS_MAX_CALLS` calls of `assess`; if the solver has
 * not converged by then, `w` is the smallest amount found with `net ≥ 0` (F4) and the loop saves the
 * small surplus and flags the path.
 *
 * The planner is one record per thread (`createPlanWithdrawals`): the tiers, the solver state, the
 * probe `Assessment`, and the call's `assess` and `w`. Its arrays are reallocated only when the
 * account count changes (another run on the same thread). Nothing else allocates, and no double
 * crosses a call.
 */

import { CASH_TOL } from "../constants.js";
import { doubleFields } from "../doubleFields.js";
import { type AssessFn, type Assessment, type EngineHooks, ASSESS_MAX_CALLS, createAssessment } from "../hooks.js";
import { decideSpending } from "../strategies/decide.js";
import type { SpendDecision } from "../strategies/types.js";
import { SOLVE_DOUBLES, type SolveState, solve } from "./solve.js";
import { type TierView, type WithdrawalTiers, buildTiers, createWithdrawalTiers, fillTiers } from "./tiers.js";

/** What `planWithdrawalsWith` reads of the loop's `YearView`: the tiers' fields and the year's RMDs (a structural subset). */
export interface WithdrawalView extends TierView {
  /** Per account: the year's RMD (the period's amount). */
  readonly rmd: ArrayLike<number>;
}

/** The planner's record: the solver state plus what `net` needs. */
export interface WithdrawalPlanner extends SolveState {
  tiers: WithdrawalTiers;
  readonly probe: Assessment;
  assess: AssessFn;
  w: Float64Array;
  /** The rule's released withdrawal of a gross year (`wd`), NaN in a target or accumulation year. */
  released: number;
}

const NO_ASSESS: AssessFn = () => undefined;

/** A planner with room for `accountCount` accounts; `limit` caps the `assess` calls of a year (default `ASSESS_MAX_CALLS`). */
export function createWithdrawalPlanner(accountCount = 0, limit: number = ASSESS_MAX_CALLS): WithdrawalPlanner {
  const p: WithdrawalPlanner = {
    lo: 0,
    hlo: 0,
    hi: 0,
    hhi: 0,
    x: 0,
    hx: 0,
    calls: 0,
    limit,
    converged: 1,
    tiers: createWithdrawalTiers(accountCount),
    probe: createAssessment(),
    assess: NO_ASSESS,
    w: new Float64Array(0),
    released: Number.NaN,
  };
  return doubleFields(p, [...SOLVE_DOUBLES, "released"]);
}

/** `net(p.x)`: fill, assess, `p.hx = net`; counts the call. */
function netAt(p: WithdrawalPlanner): void {
  const tiers = p.tiers;
  tiers.amount = p.x;
  fillTiers(tiers, p.w);
  p.calls += 1;
  p.assess(p.w, p.probe);
  p.hx = p.probe.net;
}

/** The planner's form of `planWithdrawals`: the year's tiers, the contract of the module comment, `w` written. */
export function planWithdrawalsWith(p: WithdrawalPlanner, view: WithdrawalView, decision: Readonly<SpendDecision>, assess: AssessFn, w: Float64Array): void {
  if (p.tiers.accountCount !== view.accountCount) p.tiers = createWithdrawalTiers(view.accountCount);
  const tiers = p.tiers;
  p.assess = assess;
  p.w = w;
  p.calls = 0;
  p.converged = 1;
  buildTiers(view, decision, tiers);
  const total = tiers.total;
  const tol = CASH_TOL;
  let x: number;
  if (Number.isNaN(decision.gross)) {
    p.released = Number.NaN;
    p.x = 0;
    netAt(p);
    const h0 = p.hx;
    if (h0 >= -tol || !(total > 0)) x = 0;
    else {
      p.x = total;
      netAt(p);
      if (p.hx <= tol) x = total;
      else {
        p.lo = 0;
        p.hlo = h0;
        p.hi = total;
        p.hhi = p.hx;
        solve(p, netAt);
        x = p.x;
      }
    }
  } else {
    let rmd = 0;
    const r = view.rmd;
    for (let a = 0; a < view.accountCount; a++) rmd += r[a]!;
    const rule = decision.gross * view.yearFraction + decision.lump - rmd;
    const wd = rule > 0 ? (rule < total ? rule : total) : 0;
    p.released = wd;
    p.x = wd;
    netAt(p);
    const h1 = p.hx;
    if (h1 >= -tol || wd >= total) x = wd;
    else {
      p.x = total;
      netAt(p);
      if (p.hx <= tol) x = total;
      else {
        p.lo = wd;
        p.hlo = h1;
        p.hi = total;
        p.hhi = p.hx;
        solve(p, netAt);
        x = p.x;
      }
    }
  }
  tiers.amount = x;
  fillTiers(tiers, w);
  p.x = x;
  p.assess = NO_ASSESS;
}

/** The default order as an `EngineHooks["planWithdrawals"]`, with its own planner (one per thread). */
export function createPlanWithdrawals(limit: number = ASSESS_MAX_CALLS): EngineHooks["planWithdrawals"] {
  const planner = createWithdrawalPlanner(0, limit);
  return (view, decision, assess, w) => planWithdrawalsWith(planner, view, decision, assess, w);
}

/** The production hooks (engine-and-returns §4.3's default registry): the strategies' `decideSpending` and the default order. One per thread. */
export function createEngineHooks(): EngineHooks {
  return { decideSpending, planWithdrawals: createPlanWithdrawals() };
}
