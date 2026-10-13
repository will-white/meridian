import { addDays, dayDiff, dayOfMonth, type IsoDate } from "./dates.js";
import type { Cadence } from "./enums.js";
import { daysInMonth as daysInMonthKey, truncDiv } from "./months.js";

/**
 * Calendar schedules for recurring items. This is the ONLY occurrence generator in
 * Meridian: auto-planned bills and income, the dashboard's "bills due" list, the
 * recurring matcher and the cash-flow engine all call `occurrencesInRange`.
 *
 * A schedule is a cadence plus anchors:
 * - weekly / biweekly: `anchorDate`, occurrences = anchorDate + k·7 / k·14 days.
 * - monthly, bimonthly, quarterly, semiannual, yearly: `anchorDay` (1..31; 31 = last day of
 *   the month, clamped) and, for the multi-month cadences, `anchorMonth` (1..12, any month on
 *   the cycle). Occurrence k lives in absolute month index M = base + k·periodMonths where
 *   base = 0 for monthly, else anchorMonth − 1.
 * - twice_monthly: `anchorDay` and `anchorDay2` (both clamped per month); when `anchorDay2`
 *   is missing it is derived: D ≤ 15 → {D, D + 15}, else {D − 15, D}. Occurrence k: month
 *   floor(k / 2), slot k mod 2.
 */

export interface Schedule {
  cadence: Cadence;
  anchorDate?: IsoDate | null;
  anchorDay?: number | null;
  anchorDay2?: number | null;
  anchorMonth?: number | null;
}

/** [nominalPeriodDays, toleranceDays, graceDays, occurrencesPerYear, periodMonths] */
export const CADENCE_TABLE: Record<Cadence, { nominalPeriodDays: number; toleranceDays: number; graceDays: number; occurrencesPerYear: number; periodMonths: 0 | 1 | 2 | 3 | 6 | 12 }> = {
  weekly: { nominalPeriodDays: 7, toleranceDays: 1, graceDays: 2, occurrencesPerYear: 52, periodMonths: 0 },
  biweekly: { nominalPeriodDays: 14, toleranceDays: 2, graceDays: 3, occurrencesPerYear: 26, periodMonths: 0 },
  twice_monthly: { nominalPeriodDays: 16, toleranceDays: 3, graceDays: 4, occurrencesPerYear: 24, periodMonths: 0 },
  monthly: { nominalPeriodDays: 31, toleranceDays: 4, graceDays: 5, occurrencesPerYear: 12, periodMonths: 1 },
  bimonthly: { nominalPeriodDays: 62, toleranceDays: 4, graceDays: 5, occurrencesPerYear: 6, periodMonths: 2 },
  quarterly: { nominalPeriodDays: 92, toleranceDays: 5, graceDays: 7, occurrencesPerYear: 4, periodMonths: 3 },
  semiannual: { nominalPeriodDays: 184, toleranceDays: 7, graceDays: 10, occurrencesPerYear: 2, periodMonths: 6 },
  yearly: { nominalPeriodDays: 366, toleranceDays: 10, graceDays: 14, occurrencesPerYear: 1, periodMonths: 12 },
};

export const CADENCES: readonly Cadence[] = ["weekly", "biweekly", "twice_monthly", "monthly", "bimonthly", "quarterly", "semiannual", "yearly"];

export const toleranceDays = (c: Cadence): number => CADENCE_TABLE[c].toleranceDays;
export const graceDays = (c: Cadence): number => CADENCE_TABLE[c].graceDays;
export const nominalPeriodDays = (c: Cadence): number => CADENCE_TABLE[c].nominalPeriodDays;
export const occurrencesPerYear = (c: Cadence): number => CADENCE_TABLE[c].occurrencesPerYear;
export const periodMonths = (c: Cadence): 0 | 1 | 2 | 3 | 6 | 12 => CADENCE_TABLE[c].periodMonths;
export const isWeekBased = (c: Cadence): boolean => c === "weekly" || c === "biweekly";
export const isMonthBased = (c: Cadence): boolean => periodMonths(c) > 0;

export function daysInYearMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function isLastDayOfMonth(d: IsoDate): boolean {
  return dayOfMonth(d) === daysInMonthKey(d.slice(0, 7));
}

/** 31 when `d` is the last day of its month (so a bill "on the 31st" posting Feb 28 reads as 31). */
export function effectiveDay(d: IsoDate): number {
  return isLastDayOfMonth(d) ? 31 : dayOfMonth(d);
}

/** Absolute month index: year × 12 + (month − 1). 2026-10 → 24321. */
export function monthIndex(d: IsoDate): number {
  return Number(d.slice(0, 4)) * 12 + (Number(d.slice(5, 7)) - 1);
}

function dateFor(monthIdx: number, day: number): IsoDate {
  const y = Math.floor(monthIdx / 12);
  const m = (monthIdx % 12) + 1;
  const dd = Math.min(day, daysInYearMonth(y, m));
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function twiceMonthlyDays(s: Schedule): [number, number] {
  const d1 = s.anchorDay ?? 1;
  if (s.anchorDay2 != null) return [Math.min(d1, s.anchorDay2), Math.max(d1, s.anchorDay2)];
  return d1 <= 15 ? [d1, d1 + 15] : [d1 - 15, d1];
}

function base(s: Schedule): number {
  return s.cadence === "monthly" ? 0 : (s.anchorMonth ?? 1) - 1;
}

export function validateSchedule(s: Schedule): string | null {
  if (isWeekBased(s.cadence)) return s.anchorDate ? null : `${s.cadence} needs anchorDate`;
  if (s.cadence === "twice_monthly") {
    if (s.anchorDay == null) return "twice_monthly needs anchorDay";
    if (s.anchorDay2 != null && s.anchorDay2 === s.anchorDay) return "twice_monthly needs two different days";
    return null;
  }
  if (s.anchorDay == null) return `${s.cadence} needs anchorDay`;
  if (s.cadence !== "monthly" && s.anchorMonth == null) return `${s.cadence} needs anchorMonth`;
  return null;
}

/** The k-th occurrence of a schedule. */
export function occurrence(s: Schedule, k: number): IsoDate {
  if (isWeekBased(s.cadence)) {
    if (!s.anchorDate) throw new Error(`${s.cadence} needs anchorDate`);
    return addDays(s.anchorDate, k * nominalPeriodDays(s.cadence));
  }
  if (s.cadence === "twice_monthly") {
    const [a, b] = twiceMonthlyDays(s);
    const m = Math.floor(k / 2);
    const slot = ((k % 2) + 2) % 2;
    return dateFor(m, slot === 0 ? a : b);
  }
  if (s.anchorDay == null) throw new Error(`${s.cadence} needs anchorDay`);
  return dateFor(base(s) + k * periodMonths(s.cadence), s.anchorDay);
}

/** Nearest period for a date: its index and the signed day distance from that occurrence. */
export function periodIndex(s: Schedule, d: IsoDate): { k: number; residualDays: number } {
  if (isWeekBased(s.cadence)) {
    if (!s.anchorDate) throw new Error(`${s.cadence} needs anchorDate`);
    const P = nominalPeriodDays(s.cadence);
    const diff = dayDiff(s.anchorDate, d);
    const k = Math.floor((2 * diff + P) / (2 * P));
    return { k, residualDays: diff - k * P };
  }
  let candidates: number[];
  if (s.cadence === "twice_monthly") {
    const M = monthIndex(d);
    candidates = [2 * (M - 1), 2 * (M - 1) + 1, 2 * M, 2 * M + 1, 2 * (M + 1), 2 * (M + 1) + 1];
  } else {
    const p = periodMonths(s.cadence);
    const k0 = Math.floor((monthIndex(d) - base(s)) / p);
    candidates = [k0 - 1, k0, k0 + 1];
  }
  let best = candidates[0]!;
  let bestResidual = dayDiff(occurrence(s, best), d);
  for (const k of candidates.slice(1)) {
    const r = dayDiff(occurrence(s, k), d);
    if (Math.abs(r) < Math.abs(bestResidual)) {
      best = k;
      bestResidual = r;
    }
  }
  return { k: best, residualDays: bestResidual };
}

/** Every occurrence in [from, to], ascending. */
export function occurrencesInRange(s: Schedule, from: IsoDate, to: IsoDate): IsoDate[] {
  if (from > to) return [];
  const out: IsoDate[] = [];
  let k = periodIndex(s, from).k - 2;
  for (let guard = 0; guard < 10_000; guard++, k++) {
    const d = occurrence(s, k);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** A due date is missed once more than the cadence's grace days have passed. */
export function isMissed(due: IsoDate, today: IsoDate, c: Cadence): boolean {
  return dayDiff(due, today) > graceDays(c);
}

/** Signed yearly cost of an item (weekly × 52, biweekly × 26: the occasional 53rd/27th charge is ignored). */
export function yearlyCents(expectedCents: bigint, c: Cadence): bigint {
  return expectedCents * BigInt(occurrencesPerYear(c));
}

/** Signed monthly-equivalent cost: yearly / 12, truncated toward zero (the one integer rule). */
export function monthlyEquivalentCents(expectedCents: bigint, c: Cadence): bigint {
  return truncDiv(yearlyCents(expectedCents, c), 12n);
}
