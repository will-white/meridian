import type { AlertKind, AlertView, Cadence } from "@meridian/shared";
import { dayDiff, periodMonths } from "@meridian/shared";
import { money, shortDate } from "../../lib/format.js";

/** Pure display helpers for the recurring, subscriptions and alerts pages. No money math beyond bigint. */

export const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  twice_monthly: "Twice a month",
  monthly: "Monthly",
  bimonthly: "Every 2 months",
  quarterly: "Quarterly",
  semiannual: "Twice a year",
  yearly: "Yearly",
};

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"] as const;

export interface ScheduleLike {
  cadence: Cadence;
  anchorDay: number | null;
  anchorDay2: number | null;
  anchorMonth: number | null;
  anchorDate: string | null;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "the 15th", or "the last day" for the clamped anchor 31. */
export function dayLabel(day: number): string {
  return day === 31 ? "the last day" : `the ${ordinal(day)}`;
}

/** Months on the cycle of a multi-month cadence, e.g. quarterly anchored in October → Jan, Apr, Jul, Oct. */
export function cycleMonths(anchorMonth: number, cadence: Cadence): number[] {
  const p = periodMonths(cadence);
  if (p === 0 || p === 12) return [anchorMonth];
  const first = ((anchorMonth - 1) % p) + 1;
  const out: number[] = [];
  for (let m = first; m <= 12; m += p) out.push(m);
  return out;
}

function weekdayOf(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return WEEKDAY_NAMES[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
}

/** The same derivation as the schedule module: a lone first day implies the second one. */
export function twiceMonthlyDays(anchorDay: number, anchorDay2: number | null): [number, number] {
  if (anchorDay2 != null) return [Math.min(anchorDay, anchorDay2), Math.max(anchorDay, anchorDay2)];
  return anchorDay <= 15 ? [anchorDay, anchorDay + 15] : [anchorDay - 15, anchorDay];
}

/** One line describing when an item recurs, e.g. "Monthly on the 15th". */
export function scheduleSummary(s: ScheduleLike): string {
  const label = CADENCE_LABELS[s.cadence];
  switch (s.cadence) {
    case "weekly":
    case "biweekly":
      return s.anchorDate ? `${label} on ${weekdayOf(s.anchorDate)}` : label;
    case "twice_monthly": {
      if (s.anchorDay == null) return label;
      const [a, b] = twiceMonthlyDays(s.anchorDay, s.anchorDay2);
      return `${label} on ${dayLabel(a)} and ${dayLabel(b)}`;
    }
    case "monthly":
      return s.anchorDay == null ? label : `${label} on ${dayLabel(s.anchorDay)}`;
    case "yearly": {
      if (s.anchorDay == null || s.anchorMonth == null) return label;
      const month = MONTH_NAMES[s.anchorMonth - 1]!;
      return s.anchorDay === 31 ? `${label} at the end of ${month}` : `${label} on ${month} ${s.anchorDay}`;
    }
    default: {
      if (s.anchorDay == null) return label;
      const months = s.anchorMonth == null ? "" : ` (${cycleMonths(s.anchorMonth, s.cadence).map((m) => MONTH_NAMES[m - 1]).join(", ")})`;
      return `${label} on ${dayLabel(s.anchorDay)}${months}`;
    }
  }
}

/** Relative due label: "Due today", "Due in 3 days", "2 days past due", or the date when far away. */
export function dueLabel(nextDueDate: string | null, today: string): string {
  if (!nextDueDate) return "—";
  const diff = dayDiff(today, nextDueDate);
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  if (diff === -1) return "1 day past due";
  if (diff < 0) return `${-diff} days past due`;
  if (diff <= 14) return `Due in ${diff} days`;
  return `Due ${shortDate(nextDueDate)}`;
}

export function confidenceTone(confidence: number | null): "ok" | "warn" | "neutral" {
  if (confidence == null) return "neutral";
  if (confidence >= 85) return "ok";
  if (confidence >= 70) return "warn";
  return "neutral";
}

export function confidenceLabel(confidence: number | null): string {
  if (confidence == null) return "manual";
  const word = confidence >= 85 ? "high" : confidence >= 70 ? "medium" : "low";
  return `${confidence}% · ${word}`;
}

/** Magnitude of a signed cents string. */
export function absCents(cents: string): string {
  return cents.startsWith("-") ? cents.slice(1) : cents;
}

/** "$15.49" for fixed items, "~$120.00 ± $15.00" for variable ones (band omitted when unknown or zero). Magnitudes; the sign is shown separately. */
export function expectedLabel(item: { expectedCents: string; toleranceCents?: string | undefined; amountMode: "fixed" | "variable" }): string {
  const base = money(absCents(item.expectedCents));
  if (item.amountMode === "fixed") return base;
  return !item.toleranceCents || item.toleranceCents === "0" ? `~${base}` : `~${base} ± ${money(item.toleranceCents)}`;
}

export const ALERT_TITLES: Record<AlertKind, string> = {
  price_increase: "Price increase",
  new_recurring: "New recurring charge",
  missed_charge: "Missed charge",
  trial_converted: "Trial converted",
};

export const ALERT_TONES: Record<AlertKind, "warn" | "info" | "bad"> = {
  price_increase: "warn",
  new_recurring: "info",
  missed_charge: "bad",
  trial_converted: "warn",
};

/** Plain-language message per alert kind. Amounts are shown as magnitudes. */
export function alertMessage(a: Pick<AlertView, "kind" | "recurringName" | "payeeName" | "dueDate" | "oldCents" | "newCents">): string {
  const name = a.recurringName ?? a.payeeName;
  switch (a.kind) {
    case "price_increase": {
      if (a.oldCents == null || a.newCents == null) return `${name} changed its price.`;
      const delta = BigInt(absCents(a.newCents)) - BigInt(absCents(a.oldCents));
      const sign = delta < 0n ? "-" : "+";
      return `${name} went up from ${money(absCents(a.oldCents))} to ${money(absCents(a.newCents))} (${sign}${money((delta < 0n ? -delta : delta).toString())}).`;
    }
    case "new_recurring":
      return `${name} looks like a new subscription or bill. Review it under Suggested.`;
    case "missed_charge":
      return a.dueDate ? `${name} was due ${shortDate(a.dueDate)} and has not been charged.` : `A charge for ${name} was missed.`;
    case "trial_converted":
      return a.newCents == null
        ? `A free trial at ${a.payeeName} turned into a paid charge.`
        : `A free trial at ${a.payeeName} turned into a ${money(absCents(a.newCents))} charge.`;
  }
}

/** Where an alert should take the user: the recurring item when there is one, else the payee's transactions. */
export function alertLink(a: Pick<AlertView, "recurringId" | "payeeName">): { to: string; label: string } {
  if (a.recurringId) return { to: `/recurring?focus=${a.recurringId}`, label: "View item" };
  return { to: `/transactions?q=${encodeURIComponent(a.payeeName)}`, label: "View transactions" };
}

/** |part| / |total| in basis points, truncated (0 when the total is zero). */
export function shareBp(part: bigint, total: bigint): number {
  const p = part < 0n ? -part : part;
  const t = total < 0n ? -total : total;
  if (t === 0n) return 0;
  return Number((p * 10000n) / t);
}

export function percentLabel(bp: number): string {
  return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, "0").slice(0, 1)}%`;
}

/** Today's date in the browser's local time zone as YYYY-MM-DD (what the API expects from clients). */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
