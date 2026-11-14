/**
 * What the spending hook reads and writes (strategies-outputs-web §2.2, §2.3 and §3.3; engine-and-
 * returns §4.3; seams §2.5, C40). Money is nominal dollars; recurring amounts are full-year amounts
 * that the loop multiplies by the year fraction f; a dated lump is never scaled.
 */

import type { StrategyEvent } from "@meridian/shared";
import { doubleFields } from "../doubleFields.js";
import type { StrategyTables } from "./prepare.js";

/**
 * The year's spending decision, one record per thread, overwritten every year.
 *
 * | Field       | Target year                          | Gross year                                   | Accumulation |
 * | ----------- | ------------------------------------ | -------------------------------------------- | ------------ |
 * | `spend`     | core + healthcare + long-term care   | essential core + healthcare + long-term care | 0            |
 * | `floor`     | = spend                              | = spend                                      | 0            |
 * | `lump`      | dated goals                          | same                                         | same         |
 * | `lumpFloor` | = lump                               | = lump                                       | 0            |
 * | `healthcare`| the HSA's qualified cap (C35)        | same                                         | 0            |
 * | `gross`     | NaN                                  | the rule's withdrawal, with released care    | NaN          |
 * | `planned`   | planned core + healthcare + care     | same                                         | 0            |
 * | `rule`      | `RULE` bit flags                     | same                                         | 0            |
 *
 * "Healthcare" in `spend` and `planned` is the part not included in base spending; `healthcare`
 * is every entry, the qualified cap of the HSA tier either way (seams C35, plan decision 9).
 */
export interface SpendDecision {
  spend: number;
  floor: number;
  lump: number;
  lumpFloor: number;
  healthcare: number;
  gross: number;
  planned: number;
  rule: number;
}

export function createSpendDecision(): SpendDecision {
  const d: SpendDecision = { spend: 0, floor: 0, lump: 0, lumpFloor: 0, healthcare: 0, gross: Number.NaN, planned: 0, rule: 0 };
  return doubleFields(d, ["spend", "floor", "lump", "lumpFloor", "healthcare", "gross", "planned"]);
}

/** The rule flags of `SpendDecision.rule` (§2.2). */
export const RULE = {
  FREEZE: 1,
  CUT: 2,
  RAISE: 4,
  BAND_FLOOR: 8,
  BAND_CEILING: 16,
  CAP: 32,
  ESSENTIALS: 64,
} as const;

/** The year-table event of each rule bit, bit 0 first (`results.ts` `StrategyEvent`). */
export const RULE_EVENTS: readonly StrategyEvent[] = ["freeze", "cut", "raise", "band_floor", "band_ceiling", "cap", "essentials"];

/** The events of a rule word, in bit order (for the year table; allocates). */
export function ruleEvents(rule: number): StrategyEvent[] {
  const events: StrategyEvent[] = [];
  RULE_EVENTS.forEach((event, bit) => {
    if ((rule & (1 << bit)) !== 0) events.push(event);
  });
  return events;
}

/** `PathState.strategy`: 16 floats, zeroed per path (§2.3). */
export const STRATEGY_STATE_LENGTH = 16;
export const SLOT = {
  /** 1 once guardrails or floor-and-ceiling has started. */
  STARTED: 0,
  /** Guardrails: x0, the spendable portfolio of the start year in today's dollars (`P_R ÷ cpi_R`). */
  X0: 1,
  /** Guardrails: a, the cumulative adjustment factor, 1 at the start. */
  ADJUST: 2,
  /** Floor and ceiling: the percentage in use (a fraction). */
  FC_RATE: 3,
} as const;

/**
 * The part of the loop's `YearView` the spending hook reads (engine-and-returns §4.3 with seams
 * §2.5 and C40). One instance per thread, mutated in place by the loop and read-only here; the
 * loop's `YearView` extends it. Income fields are full-year rates (the period's amount ÷ f).
 */
export interface SpendingView {
  readonly t: number;
  /** Calendar year of plan year t. */
  readonly year: number;
  /** Price level at the start of the year; today = 1. */
  readonly cpi: number;
  /** 0 accumulation (before `drawdownStart`), 1 drawdown. */
  readonly phase: 0 | 1;
  /** Per person: 1 while alive this year, 1 once retired (`year(retirementMonth) ≤ year`), age attained this year. */
  readonly alive: ArrayLike<number>;
  readonly retired: ArrayLike<number>;
  readonly age: ArrayLike<number>;
  /** Plan-year index of each death minus t (0 in the year of death). */
  readonly yearsToDeath: ArrayLike<number>;
  /** Plan-year index of the first drawdown year: `year(spending.startMonth) − startYear`. */
  readonly drawdownStart: number;
  /** Sum of all account balances before any flow of the year. */
  readonly portfolioStart: number;
  /** Gross recurring income of the year, full-year: wages; pensions, annuities and Social Security; the rest. */
  readonly wages: number;
  readonly guaranteedIncome: number;
  readonly otherIncome: number;
  /** Last year's nominal portfolio return and inflation; NaN in year 0. */
  readonly prevPortfolioReturn: number;
  readonly prevInflation: number;
  /** The stock fraction of this year's target mixes on the simulated stock asset, weighted by start balances (C40). */
  readonly stockShare: number;
  readonly strategies: StrategyTables;
}
