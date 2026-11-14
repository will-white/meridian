/**
 * What the year loop hands to the other areas and what it calls (engine-and-returns §4.3 with
 * seams §2.5, C30, C31, C40 and F2).
 *
 * - `EngineHooks`: the two hooks of the strategies area, `decideSpending(view, strategyState, out)`
 *   and `planWithdrawals(view, decision, assess, w)`. The engine's other hooks (`publishedCola`,
 *   `resolveTaxYear`, `federalTax`, `splitRothWithdrawal`, `rmd`, `socialSecurity`) are not built:
 *   the tax area's functions are one injectable record, `TaxFunctions` (tax/functions.ts), which
 *   production passes as `TAX_FUNCTIONS` and the loop tests replace with the stubs of
 *   `@meridian/retirement/testing` written to the same slot layouts.
 * - `YearView`: one instance per thread, mutated in place by the loop, read-only for the hooks and
 *   valid only during the call. Money is nominal dollars. Income fields (`wages`,
 *   `guaranteedIncome`, `otherIncome`, `socialSecurity`) are full-year rates, the period's amount
 *   divided by f; `rmd`, `available` and `rothFree` are the period's amounts. It has no `colaIndex`
 *   (seams C20: the tax area owns the cost-of-living adjustment).
 * - `Assessment`: what `assess(w, out)` writes for a candidate withdrawal vector: the year's cash
 *   left after tax and need (`net`), the tax (`tax`, the tax area's `TO.TOTAL`), the tax area's
 *   output record (`taxResult`, `Float64Array(TAX_OUT)`, which keeps the bracket room Phase 5's
 *   order comparison needs, F11) and `otherCharges`, the seam for Phase 5's IRMAA, ACA and state
 *   tax (F2): 0 in v1, and `net` subtracts it.
 *
 * Rules for every hook (engine-and-returns §4.3): pure apart from its `out` argument and (for
 * `decideSpending`) the strategy state; no allocation; no randomness; no access to this year's
 * return or inflation; none of the banned `Math` functions. Results travel in the preallocated
 * record or array, never as a returned number or a new object: V8 boxes a double that crosses a
 * call it does not inline.
 */

import type { SimInput } from "@meridian/shared";
import type { StrategyTables } from "./strategies/prepare.js";
import type { SpendDecision, SpendingView } from "./strategies/types.js";
import { TAX_OUT } from "./tax/layout.js";

export { TAX_FUNCTIONS } from "./tax/functions.js";
export type { TaxFunctions } from "./tax/functions.js";

/** The most `assess` calls a withdrawal hook may make in one year (engine-and-returns §3.9, `LIMITS.assessMaxCalls`). */
export const ASSESS_MAX_CALLS = 24;

/** The view of one path-year the hooks read (engine-and-returns §4.3, seams §2.5 and C40). */
export interface YearView extends SpendingView {
  readonly pathIndex: number;
  /** Plan year t and its calendar year. */
  readonly t: number;
  readonly year: number;
  /** f: `firstYearMonths / 12` in plan year 0, 1 after. */
  readonly yearFraction: number;
  /** Price level at the start of this year (today = 1) and the series `cpi[0 … t]`; later entries are NaN. */
  readonly cpi: number;
  readonly cpiSeries: Float64Array;
  /** 0 accumulation (before `drawdownStart`), 1 drawdown. */
  readonly phase: 0 | 1;
  /** 0 single, 1 married filing jointly (both people alive this year). */
  readonly filingStatus: 0 | 1;
  readonly personCount: number;
  /** Per person: alive this year, retired (`year(retirementMonth) ≤ year`), age attained, birth year, plan years to death (0 in the year of death). */
  readonly alive: Uint8Array;
  readonly retired: Uint8Array;
  readonly age: Int16Array;
  readonly birthYear: Int16Array;
  readonly yearsToDeath: Int16Array;
  readonly accountCount: number;
  /** Per account: `TREATMENT` index and owner (0, 1, −1 joint; the survivor after a first death). */
  readonly treatment: Uint8Array;
  readonly owner: Int8Array;
  /** Per account: the balance before any flow of the year (the prior year-end balance). */
  readonly balance: Float64Array;
  /** Per account: the year's RMD (period amount, seams C36) and what is left to withdraw, `balance − rmd − conversions out` (valid from step 3b). */
  readonly rmd: Float64Array;
  readonly available: Float64Array;
  /** Per account: the share of a withdrawal that carries the 10% additional tax (0 to 1; pre-tax accounts, seams C33). */
  readonly preTaxPenaltyShare: Float64Array;
  /** Sum of `balance`. */
  readonly portfolioStart: number;
  /** Full-year rates: gross wages; pensions, annuities and Social Security; rental and other income. */
  readonly wages: number;
  readonly guaranteedIncome: number;
  readonly otherIncome: number;
  /** Per person: the year's Social Security benefit as a full-year rate. */
  readonly socialSecurity: Float64Array;
  /** Per person: what can leave the person's Roth accounts this year with no tax and no penalty (seams C34). */
  readonly rothFree: Float64Array;
  /** Per person: the share of a non-qualified HSA withdrawal that carries the 20% additional tax (seams C33). */
  readonly hsaPenaltyShare: Float64Array;
  /** Last year's nominal portfolio return, inflation and funded spending; NaN in year 0. */
  readonly prevPortfolioReturn: number;
  readonly prevInflation: number;
  readonly prevFundedSpend: number;
  /** The stock fraction of this year's targets on the simulated stock asset, weighted by start balances (C40). */
  readonly stockShare: number;
  readonly drawdownStart: number;
  readonly strategies: StrategyTables;
  /** The frozen input: each area reads its own block (`settings.withdrawalOrder`, `spending`, …). */
  readonly input: SimInput;
}

/** One candidate's result; the record is owned by the caller of `assess` and overwritten by every call. */
export interface Assessment {
  /** Cash left after the year's tax, other charges and need: ≥ 0 a surplus, < 0 a shortfall. */
  net: number;
  /** The tax area's `TO.TOTAL`: income tax, net investment income tax and the additional taxes. */
  tax: number;
  /** Phase 5's IRMAA, ACA and state tax (seams F2); 0 in v1. */
  otherCharges: number;
  /** The tax area's output record (`TO` slots). */
  readonly taxResult: Float64Array;
}

export function createAssessment(): Assessment {
  return { net: 0, tax: 0, otherCharges: 0, taxResult: new Float64Array(TAX_OUT) };
}

/** `assess(w, out)`: the year's tax and net cash for the candidate withdrawal `w[a]` (dollars per account). */
export type AssessFn = (w: Float64Array, out: Assessment) => void;

export interface EngineHooks {
  /** Strategies: the year's spending decision (seams §2.3 step 3). */
  decideSpending(view: YearView, strategyState: Float64Array, out: SpendDecision): void;
  /**
   * Strategies: fill `w[a]` (0 ≤ w[a] ≤ `view.available[a]`; zeroed by the loop before the call)
   * using `assess` (at most `ASSESS_MAX_CALLS` calls). Contract (engine-and-returns §3.9,
   * strategies-outputs-web §3.6): when `assess(0).net ≥ −CASH_TOL` in a target or accumulation
   * year, `w = 0`; otherwise the `w` along the order with `|net| ≤ CASH_TOL`, or all of `available`
   * when even that leaves `net < 0`; if not converged by the last call, the smallest amount found
   * with `net ≥ 0` (the loop then saves the small surplus and counts `grossup_not_converged`).
   */
  planWithdrawals(view: YearView, decision: Readonly<SpendDecision>, assess: AssessFn, w: Float64Array): void;
}
