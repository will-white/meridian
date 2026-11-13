/**
 * Month arithmetic of the tax area (tax-rmd-ss §3.1; seams §2.2).
 *
 * A month is an integer index, `year × 12 + (month − 1)`, so consecutive months differ by 1 and a
 * person reaches an age of `a` months at index `birthIndex + a` (inputs-and-data decision 20). Plan
 * year 0 runs from `plan.startMonth` through December; every later plan year is a calendar year.
 */

/** 59½ in months: the 10% additional tax applies to the part of a period before this age (§3.7.1). */
export const MONTHS_59_HALF = 714;
/** 65 in months: the HSA's 20% additional tax applies to the part of a period before this age (§3.7.1). */
export const MONTHS_65 = 780;

/** The month index of `month` (1 to 12) of `year`. */
export function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/**
 * The first month index of plan year `yearIndex`. Year 0 starts at `plan.startMonth`, which is month
 * `13 − firstYearMonths` of `startYear` because year 0 runs through December; later years start in
 * January.
 */
export function periodStartIndex(startYear: number, firstYearMonths: number, yearIndex: number): number {
  return yearIndex === 0 ? startYear * 12 + (12 - firstYearMonths) : (startYear + yearIndex) * 12;
}

/** The months of plan year `yearIndex`: `firstYearMonths` in year 0, 12 after. */
export function periodMonths(firstYearMonths: number, yearIndex: number): number {
  return yearIndex === 0 ? firstYearMonths : 12;
}
