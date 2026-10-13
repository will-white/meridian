import { dayOfMonth, isoDateToUtcMs, toIsoDate, type IsoDate } from "./dates.js";

/** Calendar months as `YYYY-MM` strings. Pure string/integer arithmetic; no Date objects except for day counts. */
export type MonthKey = string;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: string): boolean {
  return MONTH_RE.test(value);
}

export function monthKey(date: IsoDate): MonthKey {
  return date.slice(0, 7);
}

export function monthStart(m: MonthKey): IsoDate {
  return `${m}-01`;
}

export function monthEnd(m: MonthKey): IsoDate {
  return `${m}-${String(daysInMonth(m)).padStart(2, "0")}`;
}

function parts(m: MonthKey): [number, number] {
  const match = MONTH_RE.exec(m);
  if (!match) throw new Error(`Not a month: "${m}"`);
  return [Number(match[1]), Number(match[2])];
}

export function addMonths(m: MonthKey, n: number): MonthKey {
  const [y, mo] = parts(m);
  const index = y * 12 + (mo - 1) + n;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** b − a in months. */
export function monthDiff(a: MonthKey, b: MonthKey): number {
  const [ya, ma] = parts(a);
  const [yb, mb] = parts(b);
  return (yb - ya) * 12 + (mb - ma);
}

/** Inclusive ascending range. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function daysInMonth(m: MonthKey): number {
  const [y, mo] = parts(m);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Days left in the month including today (last day → 1). */
export function daysRemainingInMonth(today: IsoDate): number {
  return daysInMonth(monthKey(today)) - dayOfMonth(today) + 1;
}

export function maxMonth(a: MonthKey, b: MonthKey): MonthKey {
  return a > b ? a : b;
}

export function minMonth(a: MonthKey, b: MonthKey): MonthKey {
  return a < b ? a : b;
}

/** Same day `n` months away, clamped to the target month's length (2028-02-29 −12 → 2027-02-28). */
export function addMonthsClamped(date: IsoDate, n: number): IsoDate {
  const m = addMonths(monthKey(date), n);
  const day = Math.min(dayOfMonth(date), daysInMonth(m));
  return `${m}-${String(day).padStart(2, "0")}`;
}

/** Calendar date for an instant in an IANA time zone, e.g. the household's "today". */
export function localDateInTimeZone(instant: Date, timeZone: string): IsoDate {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Integer helpers for money. BigInt `/` truncates toward zero; both assert a positive divisor. */
export function truncDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("divisor must be > 0n");
  return n / d;
}

/** Ceiling division for a non-negative dividend (used for "needed per month"). */
export function ceilDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("divisor must be > 0n");
  const q = n / d;
  return n % d !== 0n && n > 0n ? q + 1n : q;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export { toIsoDate, isoDateToUtcMs };
