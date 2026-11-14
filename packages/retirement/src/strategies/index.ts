/**
 * The spending strategies (strategies-outputs-web §2.1 to §2.3, §3.2 to §3.4, §3.8): the tables
 * `prepare()` builds, planned spending, the spending hook and the settlement of the year's
 * spending. The withdrawal order (`planWithdrawals`) is in ../withdrawals/.
 */

export { STRATEGY, prepareStrategies } from "./prepare.js";
export type { FloorCeilingParams, GuardrailParams, StrategyIndex, StrategyTables } from "./prepare.js";
export { createPlannedYear, plannedYear, plannedYearOf } from "./planned.js";
export type { PlannedInput, PlannedYear } from "./planned.js";
export { RULE, RULE_EVENTS, SLOT, STRATEGY_STATE_LENGTH, createSpendDecision, ruleEvents } from "./types.js";
export type { SpendDecision, SpendingView } from "./types.js";
export { decideSpending, everyLivingRetired } from "./decide.js";
export { guardrailsCore, yearsRemaining } from "./guardrails.js";
export { floorCeilingCore } from "./floorCeiling.js";
export { fixedPercentageGross, vpwGross, youngerLivingAge } from "./vpw.js";
export { createSpendingOutcome, fillNeeds, settleSpending } from "./outcome.js";
export type { SpendingOutcome } from "./outcome.js";
