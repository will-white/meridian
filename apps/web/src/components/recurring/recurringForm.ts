import type { AmountMode, Cadence, CreateRecurringBody, RecurringView, UpdateRecurringBody } from "@meridian/shared";
import { parseDecimalToCents } from "@meridian/shared";
import { twiceMonthlyDays } from "./recurringFormat.js";

/** Form state (strings, as typed) and the pure mapping to the fixed API bodies. */

export type CreateBody = typeof CreateRecurringBody._output;
export type UpdateBody = typeof UpdateRecurringBody._output;

export type Direction = "outflow" | "inflow";

export interface RecurringFormState {
  name: string;
  payeeName: string;
  categoryId: string;
  accountId: string;
  transferAccountId: string;
  cadence: Cadence;
  /** Day of month 1..31 as typed ("" = unset). 31 means the last day of the month. */
  anchorDay: string;
  anchorDay2: string;
  /** 1..12 as typed. */
  anchorMonth: string;
  /** YYYY-MM-DD for weekly / biweekly. */
  anchorDate: string;
  direction: Direction;
  /** Decimal magnitude as typed, e.g. "15.49" or "$1,234.50". */
  amount: string;
  /** Decimal half-width as typed; "" keeps the default (create) or the current value (edit). */
  tolerance: string;
  amountMode: AmountMode;
  notes: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ScheduleFields {
  cadence: Cadence;
  anchorDay: number | null;
  anchorDay2: number | null;
  anchorMonth: number | null;
  anchorDate: string | null;
}

export function emptyForm(overrides: Partial<RecurringFormState> = {}): RecurringFormState {
  return {
    name: "",
    payeeName: "",
    categoryId: "",
    accountId: "",
    transferAccountId: "",
    cadence: "monthly",
    anchorDay: "1",
    anchorDay2: "",
    anchorMonth: "",
    anchorDate: "",
    direction: "outflow",
    amount: "",
    tolerance: "",
    amountMode: "fixed",
    notes: "",
    ...overrides,
  };
}

/** Cents magnitude string → decimal text for an input ("1549" → "15.49"). */
export function centsToInput(cents: string): string {
  const abs = cents.startsWith("-") ? cents.slice(1) : cents;
  const n = BigInt(abs);
  return `${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
}

export function formFromItem(item: RecurringView): RecurringFormState {
  return {
    name: item.name,
    payeeName: item.payeeName,
    categoryId: item.categoryId ?? "",
    accountId: item.accountId ?? "",
    transferAccountId: item.transferAccountId ?? "",
    cadence: item.cadence,
    anchorDay: item.anchorDay == null ? "" : String(item.anchorDay),
    anchorDay2: item.anchorDay2 == null ? "" : String(item.anchorDay2),
    anchorMonth: item.anchorMonth == null ? "" : String(item.anchorMonth),
    anchorDate: item.anchorDate ?? "",
    direction: item.expectedCents.startsWith("-") ? "outflow" : "inflow",
    amount: centsToInput(item.expectedCents),
    tolerance: centsToInput(item.toleranceCents),
    amountMode: item.amountMode,
    notes: item.notes ?? "",
  };
}

/** "$1,234.50" → 123450n; null when the text is not a money amount. */
export function parseMoneyInput(text: string): bigint | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  try {
    return parseDecimalToCents(cleaned);
  } catch {
    return null;
  }
}

function parseDay(text: string, what: string): Result<number> {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1 || n > 31) return { ok: false, error: `${what} must be a day of the month (1–31; 31 means the last day).` };
  return { ok: true, value: n };
}

/** Validates the schedule the way the API's superRefine does; unused anchors come back as null. */
export function scheduleFromForm(f: RecurringFormState): Result<ScheduleFields> {
  const none: ScheduleFields = { cadence: f.cadence, anchorDay: null, anchorDay2: null, anchorMonth: null, anchorDate: null };
  switch (f.cadence) {
    case "weekly":
    case "biweekly": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.anchorDate)) return { ok: false, error: "Pick a date of one charge; later ones follow every 7 or 14 days." };
      return { ok: true, value: { ...none, anchorDate: f.anchorDate } };
    }
    case "twice_monthly": {
      const d1 = parseDay(f.anchorDay, "First day");
      if (!d1.ok) return d1;
      let day2: number | null = null;
      if (f.anchorDay2.trim() !== "") {
        const d2 = parseDay(f.anchorDay2, "Second day");
        if (!d2.ok) return d2;
        day2 = d2.value;
      }
      const [a, b] = twiceMonthlyDays(d1.value, day2);
      if (a === b) return { ok: false, error: "Pick two different days of the month." };
      return { ok: true, value: { ...none, anchorDay: a, anchorDay2: b } };
    }
    case "monthly": {
      const d = parseDay(f.anchorDay, "Day");
      if (!d.ok) return d;
      return { ok: true, value: { ...none, anchorDay: d.value } };
    }
    default: {
      const d = parseDay(f.anchorDay, "Day");
      if (!d.ok) return d;
      const m = Number(f.anchorMonth.trim());
      if (!Number.isInteger(m) || m < 1 || m > 12) return { ok: false, error: "Pick a month the charge falls in." };
      return { ok: true, value: { ...none, anchorDay: d.value, anchorMonth: m } };
    }
  }
}

export interface AmountFields {
  expectedCents: string;
  /** null = not given. */
  toleranceCents: string | null;
  amountMode: AmountMode;
}

export function amountFromForm(f: RecurringFormState): Result<AmountFields> {
  const magnitude = parseMoneyInput(f.amount);
  if (magnitude === null || magnitude <= 0n) return { ok: false, error: "Enter an amount greater than zero." };
  const signed = f.direction === "outflow" ? -magnitude : magnitude;
  let toleranceCents: string | null = null;
  if (f.tolerance.trim() !== "") {
    const tol = parseMoneyInput(f.tolerance);
    if (tol === null || tol < 0n) return { ok: false, error: "Tolerance must be zero or more." };
    toleranceCents = tol.toString();
  }
  return { ok: true, value: { expectedCents: signed.toString(), toleranceCents, amountMode: f.amountMode } };
}

/** Builds a CreateRecurringBody for the manual "Add recurring" form. */
export function createBodyFromForm(f: RecurringFormState): Result<CreateBody> {
  const name = f.name.trim();
  if (!name) return { ok: false, error: "Enter a name." };
  const payeeName = f.payeeName.trim() || name;
  if (!f.categoryId) return { ok: false, error: "Choose a category." };
  if (!f.accountId) return { ok: false, error: "Choose the account it is charged to." };
  const schedule = scheduleFromForm(f);
  if (!schedule.ok) return schedule;
  const amount = amountFromForm(f);
  if (!amount.ok) return amount;
  const body: CreateBody = {
    name,
    payeeName,
    categoryId: f.categoryId,
    accountId: f.accountId,
    ...schedule.value,
    expectedCents: amount.value.expectedCents,
    amountMode: amount.value.amountMode,
  };
  if (f.transferAccountId) body.transferAccountId = f.transferAccountId;
  if (amount.value.toleranceCents !== null) body.toleranceCents = amount.value.toleranceCents;
  const notes = f.notes.trim();
  if (notes) body.notes = notes;
  return { ok: true, value: body };
}

function sameSchedule(a: ScheduleFields, b: ScheduleFields): boolean {
  return a.cadence === b.cadence && a.anchorDay === b.anchorDay && a.anchorDay2 === b.anchorDay2 && a.anchorMonth === b.anchorMonth && a.anchorDate === b.anchorDate;
}

/**
 * Builds an UpdateRecurringBody holding only what changed against `item`, so that untouched
 * schedule and amount fields do not flip the item's lock flags. `status` is appended as given
 * (confirming a suggestion sends `active`).
 */
export function updateBodyFromForm(f: RecurringFormState, item: RecurringView, status?: "active"): Result<UpdateBody> {
  const name = f.name.trim();
  if (!name) return { ok: false, error: "Enter a name." };
  if (status === "active" && !f.categoryId) return { ok: false, error: "Choose a category to activate this item." };
  if (status === "active" && !f.accountId) return { ok: false, error: "Choose the account it is charged to." };
  const schedule = scheduleFromForm(f);
  if (!schedule.ok) return schedule;
  const amount = amountFromForm(f);
  if (!amount.ok) return amount;

  const body: UpdateBody = {};
  if (name !== item.name) body.name = name;
  const categoryId = f.categoryId || null;
  if (categoryId !== item.categoryId) body.categoryId = categoryId;
  const accountId = f.accountId || null;
  if (accountId !== item.accountId) body.accountId = accountId;
  const transferAccountId = f.transferAccountId || null;
  if (transferAccountId !== item.transferAccountId) body.transferAccountId = transferAccountId;
  const current: ScheduleFields = { cadence: item.cadence, anchorDay: item.anchorDay, anchorDay2: item.anchorDay2, anchorMonth: item.anchorMonth, anchorDate: item.anchorDate };
  if (!sameSchedule(schedule.value, current)) Object.assign(body, schedule.value);
  if (amount.value.expectedCents !== item.expectedCents) body.expectedCents = amount.value.expectedCents;
  if (amount.value.toleranceCents !== null && amount.value.toleranceCents !== item.toleranceCents) body.toleranceCents = amount.value.toleranceCents;
  if (amount.value.amountMode !== item.amountMode) body.amountMode = amount.value.amountMode;
  const notes = f.notes.trim() || null;
  if (notes !== item.notes) body.notes = notes;
  if (status) body.status = status;
  return { ok: true, value: body };
}
