import { addDays, isoDateToUtcMs, toIsoDate, type IsoDate } from "./dates.js";

/**
 * NYSE trading calendar, computed rather than stored (prices design §3.2).
 *
 * Closed: Saturdays, Sundays, the ten rule-based holidays, and the special closures
 * listed below. Early-close days are trading days. A fixed-date holiday that falls on a
 * Saturday is observed on the Friday before, except New Year's Day (NYSE rule 7.2:
 * 2021-12-31 was a trading day); one that falls on a Sunday is observed on the Monday after.
 */

/** Closures outside the rules, extended by code. 2025-01-09: national day of mourning. */
export const SPECIAL_CLOSURES: readonly IsoDate[] = ["2025-01-09"];

function iso(year: number, month: number, day: number): IsoDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: IsoDate): number {
  return new Date(isoDateToUtcMs(date)).getUTCDay();
}

/** The n-th (1-based) given weekday of a month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): IsoDate {
  const first = dayOfWeek(iso(year, month, 1));
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return iso(year, month, day);
}

/** The last given weekday of a month. */
function lastWeekday(year: number, month: number, weekday: number): IsoDate {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = dayOfWeek(iso(year, month, lastDay));
  return iso(year, month, lastDay - ((last - weekday + 7) % 7));
}

/** Easter Sunday by the anonymous Gregorian algorithm (2025-04-20, 2026-04-05, 2027-03-28, 2028-04-16). */
export function easterSunday(year: number): IsoDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** Observed date of a fixed-date holiday: Saturday → Friday (unless `saturdayStays`), Sunday → Monday. */
function observed(date: IsoDate, saturdayStays: boolean): IsoDate | null {
  const dow = dayOfWeek(date);
  if (dow === 6) return saturdayStays ? null : addDays(date, -1);
  if (dow === 0) return addDays(date, 1);
  return date;
}

/** The rule-based NYSE holidays of a year, ascending. Special closures are not included. */
export function nyseHolidays(year: number): IsoDate[] {
  const out: IsoDate[] = [];
  const push = (d: IsoDate | null) => {
    if (d !== null) out.push(d);
  };
  push(observed(iso(year, 1, 1), true)); // New Year's Day; a Saturday is not observed on Dec 31
  push(nthWeekday(year, 1, 1, 3)); // Martin Luther King Jr. Day
  push(nthWeekday(year, 2, 1, 3)); // Presidents' Day
  push(addDays(easterSunday(year), -2)); // Good Friday
  push(lastWeekday(year, 5, 1)); // Memorial Day
  push(observed(iso(year, 6, 19), false)); // Juneteenth
  push(observed(iso(year, 7, 4), false)); // Independence Day
  push(nthWeekday(year, 9, 1, 1)); // Labor Day
  push(nthWeekday(year, 11, 4, 4)); // Thanksgiving
  push(observed(iso(year, 12, 25), false)); // Christmas
  // A New Year's Day on Sunday is observed on Monday Jan 2 of the same year (handled above);
  // nothing from the next year spills into this one.
  return out.sort();
}

const holidayCache = new Map<number, Set<IsoDate>>();

function holidaySet(year: number): Set<IsoDate> {
  let set = holidayCache.get(year);
  if (!set) {
    set = new Set(nyseHolidays(year));
    holidayCache.set(year, set);
  }
  return set;
}

export function isTradingDay(date: IsoDate): boolean {
  const dow = dayOfWeek(date);
  if (dow === 0 || dow === 6) return false;
  if (SPECIAL_CLOSURES.includes(date)) return false;
  return !holidaySet(Number(date.slice(0, 4))).has(date);
}

export function lastTradingDayOnOrBefore(date: IsoDate): IsoDate {
  let d = date;
  while (!isTradingDay(d)) d = addDays(d, -1);
  return d;
}

/** The last trading day strictly before `date`. */
export function previousTradingDay(date: IsoDate): IsoDate {
  return lastTradingDayOnOrBefore(addDays(date, -1));
}

/** The first trading day strictly after `date`. */
export function nextTradingDay(date: IsoDate): IsoDate {
  let d = addDays(date, 1);
  while (!isTradingDay(d)) d = addDays(d, 1);
  return d;
}

/** Trading days in the half-open range (from, to]. Zero when `to ≤ from`. */
export function tradingDaysBetween(from: IsoDate, to: IsoDate): number {
  if (to <= from) return 0;
  let count = 0;
  let ms = isoDateToUtcMs(from) + 86_400_000;
  const end = isoDateToUtcMs(to);
  while (ms <= end) {
    if (isTradingDay(toIsoDate(new Date(ms)))) count++;
    ms += 86_400_000;
  }
  return count;
}
