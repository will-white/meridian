/**
 * The default withdrawal order and the gross-up (strategies-outputs-web §2.4, §3.5 to §3.8): the
 * tiers and `fill`, the solver, `planWithdrawals` and the production hooks.
 */

export { TIER, TIER_COUNT, buildTiers, createWithdrawalTiers, fill, fillTiers } from "./tiers.js";
export type { TierView, WithdrawalTiers } from "./tiers.js";
export { createSolveState, solve } from "./solve.js";
export type { SolveState } from "./solve.js";
export { createEngineHooks, createPlanWithdrawals, createWithdrawalPlanner, planWithdrawalsWith } from "./plan.js";
export type { WithdrawalPlanner, WithdrawalView } from "./plan.js";
