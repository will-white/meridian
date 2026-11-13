import { dayOfMonth, isIsoDate, type IsoDate } from "../dates.js";
import { addMonths, monthKey, type MonthKey } from "../months.js";

/**
 * The plan clock's calendar helpers (inputs-and-data decisions 19 and 20, §3.4 R2 and R3).
 * Pure month arithmetic on `YYYY-MM` keys.
 */

export interface PlanStart {
  startYear: number;
  startMonth: MonthKey;
  /** Months of year 0, from `startMonth` through December: f = firstYearMonths / 12. */
  firstYearMonths: number;
}

/**
 * The plan starts at the month boundary nearest the baseline's as-of date: the as-of month when the
 * day is the 15th or earlier, else the next month. Year 0 runs from `startMonth` through December.
 */
export function planStart(asOf: IsoDate): PlanStart {
  if (!isIsoDate(asOf)) throw new RangeError(`planStart: not a date: "${asOf}"`);
  const month = monthKey(asOf);
  const startMonth = dayOfMonth(asOf) <= 15 ? month : addMonths(month, 1);
  return { startYear: Number(startMonth.slice(0, 4)), startMonth, firstYearMonths: 13 - Number(startMonth.slice(5, 7)) };
}

/** The month a person reaches `years` years and `months` months of age: month `birthMonth` of year `birthYear + years`, plus `months`. */
export function ageMonth(birthYear: number, birthMonth: number, years: number, months = 0): MonthKey {
  if (!Number.isInteger(birthYear) || birthYear < 0 || birthYear > 9999) throw new RangeError(`ageMonth: bad birth year ${birthYear}`);
  if (!Number.isInteger(birthMonth) || birthMonth < 1 || birthMonth > 12) throw new RangeError(`ageMonth: bad birth month ${birthMonth}`);
  if (!Number.isInteger(years) || years < 0 || !Number.isInteger(months) || months < 0) {
    throw new RangeError(`ageMonth: an age is whole, non-negative years and months (${years}, ${months})`);
  }
  const birth = `${String(birthYear).padStart(4, "0")}-${String(birthMonth).padStart(2, "0")}`;
  return addMonths(birth, years * 12 + months);
}
