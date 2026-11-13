/**
 * Additional taxes on early distributions from pre-tax accounts and HSAs (tax-rmd-ss §3.7.1,
 * §3.7.2, §3.7.4; decisions 22, 23, 26) and the penalty shares the withdrawal order reads (seams
 * C33). The Roth ordering is in rothBasis.ts.
 *
 * A month-exact age becomes a fraction of the period: `earlyFraction` is the share of the plan year
 * (or of the partial first year) that lies before the month the owner reaches 59½ (or 65 for an
 * HSA). Every function is pure, allocates nothing and never throws on finite inputs. RMDs and Roth
 * conversions never enter a penalty base (§3.7.2); the caller passes only withdrawals.
 */

import { HW } from "./layout.js";

/** 59½ in months: the 10% additional tax applies to the part of a period before this age (§3.7.1). */
export const MONTHS_59_HALF = 714;
/** 65 in months: the HSA's 20% additional tax applies to the part of a period before this age (§3.7.1). */
export const MONTHS_65 = 780;

/**
 * A person's birth month as a month number of the plan clock (clock.ts: `year × 12 + month − 1`),
 * so the person reaches an age of `a` months at `birthMonthIndex + a` (tax-rmd-ss §3.1,
 * inputs-and-data decision 20). Periods come from clock.ts's `periodStart` and `periodMonths`.
 */
export function birthMonthIndex(birthYear: number, birthMonth: number): number {
  return birthYear * 12 + (birthMonth - 1);
}

/**
 * The share of a period of `periodMonths` months starting at month index `periodStart` that lies
 * before month index `thresholdIndex`: `clamp((thresholdIndex − periodStart) / periodMonths, 0, 1)`.
 * The age is reached at the start of the threshold month, so that month and every later one count
 * as not early.
 */
export function earlyFraction(thresholdIndex: number, periodStart: number, periodMonths: number): number {
  if (!(periodMonths > 0)) return thresholdIndex > periodStart ? 1 : 0;
  const x = (thresholdIndex - periodStart) / periodMonths;
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

/** The early fraction for the 10% additional tax (pre-tax and Roth money): before the month of 59½. */
export function earlyFractionBefore59Half(birthIndex: number, periodStart: number, periodMonths: number): number {
  return earlyFraction(birthIndex + MONTHS_59_HALF, periodStart, periodMonths);
}

/** The early fraction for the HSA's 20% additional tax: before the month of 65. */
export function earlyFractionBefore65(birthIndex: number, periodStart: number, periodMonths: number): number {
  return earlyFraction(birthIndex + MONTHS_65, periodStart, periodMonths);
}

/** An employer plan for Form 5329 exception 01: an account of type `401k` (never an IRA). */
export function isEmployerPlan(accountType: string | undefined): boolean {
  return accountType === "401k";
}

/**
 * Form 5329 exception 01: the owner separated from service in or after the calendar year of their
 * 55th birthday, and the distribution is made after the separation. `retirementYear` is the year of
 * the owner's `retirementMonth`; the year of separation counts as after it (annual steps).
 */
export function separatedAt55(birthYear: number, retirementYear: number, year: number): boolean {
  return retirementYear >= birthYear + 55 && year >= retirementYear;
}

/**
 * The share of a pre-tax withdrawal in this period that carries the 10% additional tax (seams C33's
 * `preTaxPenaltyShare`): 0 for an employer plan after separation at 55, else the early fraction.
 * The withdrawal order puts an account with share 0 in tier 4 and one above 0 in tier 7.
 */
export function preTaxPenaltyShare(earlyFrac: number, employerPlan: boolean, separated55: boolean): number {
  return employerPlan && separated55 ? 0 : earlyFrac;
}

/**
 * The amount of a pre-tax withdrawal subject to the 10% additional tax (Form 5329 Part I line 3):
 * `amount × preTaxPenaltyShare(…)`; 0 for a non-positive amount.
 */
export function preTaxPenaltyBase(amount: number, earlyFrac: number, employerPlan: boolean, separated55: boolean): number {
  return amount > 0 ? amount * preTaxPenaltyShare(earlyFrac, employerPlan, separated55) : 0;
}

/**
 * The share of a non-qualified HSA withdrawal in this period that carries the 20% additional tax
 * (seams C33's `hsaPenaltyShare`): the early fraction before 65 (no disability or death exception
 * is modelled, tax-rmd-ss §8.2 `penalty_exceptions`).
 */
export function hsaPenaltyShare(earlyFrac65: number): number {
  return earlyFrac65;
}

/**
 * An HSA withdrawal (Publication 969, Form 8889): the part above the period's qualified medical
 * spending is ordinary income (`out[HW.TAXABLE]`, to `TI.HSA_TAXABLE`), and that part times the
 * early fraction before 65 carries the 20% additional tax (`out[HW.PENALTY_BASE]`, to `TI.PEN20_BASE`).
 */
export function hsaWithdraw(amount: number, qualifiedMedical: number, earlyFrac65: number, out: Float64Array): void {
  const excess = amount - (qualifiedMedical > 0 ? qualifiedMedical : 0);
  const taxable = excess > 0 ? excess : 0;
  out[HW.TAXABLE] = taxable;
  out[HW.PENALTY_BASE] = taxable * hsaPenaltyShare(earlyFrac65);
}
