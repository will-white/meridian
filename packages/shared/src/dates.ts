/** Calendar-date helpers. Dates are plain `YYYY-MM-DD` strings everywhere outside the DB driver. */

export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(mo) - 1 && date.getUTCDate() === Number(d);
}

export function toIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

/** Unix seconds (SimpleFIN `posted` / `transaction_date`) to a UTC calendar date. */
export function unixToIsoDate(seconds: number): IsoDate {
  return toIsoDate(new Date(seconds * 1000));
}

export function isoDateToUtcMs(date: IsoDate): number {
  const m = ISO_DATE.exec(date);
  if (!m) throw new Error(`Not an ISO date: "${date}"`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Whole days from `a` to `b` (positive when b is later). */
export function dayDiff(a: IsoDate, b: IsoDate): number {
  return Math.round((isoDateToUtcMs(b) - isoDateToUtcMs(a)) / 86_400_000);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return toIsoDate(new Date(isoDateToUtcMs(date) + days * 86_400_000));
}

export function dayOfMonth(date: IsoDate): number {
  return Number(date.slice(8, 10));
}

export function compareIsoDate(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
