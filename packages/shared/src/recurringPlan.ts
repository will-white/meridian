import type { IsoDate } from "./dates.js";
import { maxMonth, monthEnd, monthKey, monthStart, type MonthKey } from "./months.js";
import { occurrencesWithIndexInRange, periodIndex, validateSchedule, type Schedule } from "./schedule.js";

/**
 * Which months a confirmed recurring item plans in, and how many occurrences in each
 * (docs/phase-2-plan.md decision 13). The plan follows what happened, not the calendar:
 *
 * 1. Every linked charge is one occurrence, planned in the month the charge posted. A salary
 *    due on the 1st that arrived the Friday before belongs to the earlier month; rent due on
 *    the 30th that posted on the 2nd belongs to the later one. This holds for paused and
 *    cancelled items too, so what was paid stays planned after the status changes.
 * 2. Only an active item is planned ahead. Its occurrences without a linked charge are planned
 *    in their scheduled month for the current and later months, from `expectedFrom` on (the
 *    day the item began to be expected: confirm, resume or manual create). Nothing is expected
 *    for the time before that, so a resume never back-fills the months the item was on hold.
 * 3. A completed month keeps only what was paid in it. An occurrence from an earlier month that
 *    is still awaited (on or after `nextDueDate`: overdue but inside the cadence's grace) is
 *    planned in the current month, where its charge will land; once the recurring refresh
 *    writes it off as missed it is no longer planned anywhere.
 */

export interface RecurringPlanItem {
  schedule: Schedule;
  status: "active" | "paused" | "cancelled";
  /** Occurrences before this date are expected only when a charge is linked to them. */
  expectedFrom: IsoDate;
  /** The first occurrence the item still waits for; null when unknown. */
  nextDueDate: IsoDate | null;
  /** Dates of the charges linked to the item. */
  chargeDates: readonly IsoDate[];
}

export interface RecurringPlanQuery {
  from: MonthKey;
  to: MonthKey;
  today: IsoDate;
}

/** Occurrence count per month in [from, to]; months without occurrences are absent. */
export function recurringPlanCounts(item: RecurringPlanItem, q: RecurringPlanQuery): Map<MonthKey, number> {
  const counts = new Map<MonthKey, number>();
  if (q.from > q.to) return counts;
  const add = (month: MonthKey): void => {
    if (month < q.from || month > q.to) return;
    counts.set(month, (counts.get(month) ?? 0) + 1);
  };

  for (const date of item.chargeDates) add(monthKey(date));

  const currentMonth = monthKey(q.today);
  if (item.status !== "active" || q.to < currentMonth || validateSchedule(item.schedule) !== null) return counts;

  const fulfilled = new Set<number>();
  for (const date of item.chargeDates) fulfilled.add(periodIndex(item.schedule, date).k);

  const currentStart = monthStart(currentMonth);
  const awaitedFrom = item.nextDueDate !== null && item.nextDueDate < currentStart ? item.nextDueDate : currentStart;
  const scanFrom = awaitedFrom > item.expectedFrom ? awaitedFrom : item.expectedFrom;
  for (const o of occurrencesWithIndexInRange(item.schedule, scanFrom, monthEnd(q.to))) {
    if (fulfilled.has(o.k)) continue;
    add(maxMonth(monthKey(o.date), currentMonth));
  }
  return counts;
}
