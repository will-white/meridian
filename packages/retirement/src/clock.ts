/**
 * The plan clock inside the engine (seams §2.2, C14, C15; plan decision 2).
 *
 * Plan year t is calendar year `plan.startYear + t`. Its period is `[periodStart, periodStart +
 * periodMonths)`: the months from `plan.startMonth` through December for t = 0, the whole year
 * otherwise, so `f = periodMonths / 12`. A recurring flow with a month window `[from, to)` pays
 * `annual × (months of the window inside the period) / 12` (C15); as a full-year rate that is
 * `annual × yearShare`, `yearShare = (months inside the period) / periodMonths`, which the loop's
 * multiplication by f turns back into twelfths (strategies-outputs-web §3.2).
 *
 * Months are whole numbers `year × 12 + (month − 1)`; an open window ends at `Infinity`.
 */

import type { SimInputPlan } from "@meridian/shared";
import { EngineInputError } from "./errors.js";
import { MAX_PLAN_YEARS } from "./models/market.js";

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** A `YYYY-MM` month as a month number: `year × 12 + month − 1` (2026-10 → 24,321). */
export function monthIndex(month: string): number {
  const m = MONTH.exec(month);
  if (m === null) throw new EngineInputError("month_invalid", `not a YYYY-MM month: ${JSON.stringify(month)}`);
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

/** The calendar year of a month number. */
export function yearOfMonth(index: number): number {
  return Math.floor(index / 12);
}

/** The frozen plan's clock, checked once. */
export interface PlanClock {
  readonly startYear: number;
  /** Y = endYear − startYear + 1 plan years. */
  readonly years: number;
  /** The month number of `plan.startMonth`. */
  readonly firstMonth: number;
  /** Months of year 0 (1 to 12). */
  readonly firstYearMonths: number;
  /** f of year 0 = firstYearMonths / 12. */
  readonly firstYearFraction: number;
}

/**
 * The clock of `SimInput.plan`, after checking that its fields agree (the resolver writes them
 * together): `startMonth` lies in `startYear`, `firstYearMonths = 13 − month(startMonth)`, and the
 * plan runs 1 to 120 years (`plan_invalid`, `horizon_too_long`).
 */
export function planClock(plan: SimInputPlan): PlanClock {
  const firstMonth = monthIndex(plan.startMonth);
  if (yearOfMonth(firstMonth) !== plan.startYear || plan.firstYearMonths !== 12 - (firstMonth - plan.startYear * 12)) {
    throw new EngineInputError(
      "plan_invalid",
      `the plan's start month ${plan.startMonth}, start year ${plan.startYear} and first-year months ${plan.firstYearMonths} disagree`,
    );
  }
  const years = plan.endYear - plan.startYear + 1;
  if (years < 1) throw new EngineInputError("plan_invalid", `the plan ends (${plan.endYear}) before it starts (${plan.startYear})`);
  if (years > MAX_PLAN_YEARS) {
    throw new EngineInputError("horizon_too_long", `A plan cannot run for more than ${MAX_PLAN_YEARS} years; this one runs ${years}`);
  }
  return { startYear: plan.startYear, years, firstMonth, firstYearMonths: plan.firstYearMonths, firstYearFraction: plan.firstYearMonths / 12 };
}

/** The month number at which plan year t's period starts. */
export function periodStart(clock: PlanClock, t: number): number {
  return t === 0 ? clock.firstMonth : (clock.startYear + t) * 12;
}

/** Months in plan year t's period: `firstYearMonths` for t = 0, else 12. */
export function periodMonths(clock: PlanClock, t: number): number {
  return t === 0 ? clock.firstYearMonths : 12;
}

/** Months of the window `[from, to)` (month numbers; `to` may be `Infinity`) inside plan year t's period. */
export function monthsInPeriod(clock: PlanClock, t: number, from: number, to: number): number {
  const start = periodStart(clock, t);
  const end = (clock.startYear + t + 1) * 12;
  const lo = from > start ? from : start;
  const hi = to < end ? to : end;
  return hi > lo ? hi - lo : 0;
}

/**
 * The full-year rate share of the window `[from, to)` in plan year t: months inside the period
 * divided by the period's months (strategies-outputs-web §3.2's `yearShare`). It is 0 or 1 for a
 * window that starts in January and runs to the end of the plan.
 */
export function yearShare(clock: PlanClock, t: number, from: number, to: number): number {
  return monthsInPeriod(clock, t, from, to) / periodMonths(clock, t);
}
