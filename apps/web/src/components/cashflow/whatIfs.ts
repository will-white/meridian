import { addMonthsClamped, dayDiff, parseDecimalToCents } from "@meridian/shared";
import type { CashFlowProjectionResponse, CashFlowWhatIfBody } from "@meridian/shared";
import { money, shortDate } from "../../lib/format.js";

/**
 * Pure helpers for the cash-flow page: the horizon selector, the what-if list
 * held in React state (never persisted; every change re-POSTs the projection)
 * and the labels the drawer and the events table show. No React, no DOM.
 * See docs/design/phase-2/cashflow.md ("Web").
 */

export type WhatIf = CashFlowWhatIfBody;
export type CashFlowEvent = CashFlowProjectionResponse["events"][number];
export type WhatIfOutcome = CashFlowProjectionResponse["whatIfs"][number];

export type HorizonChoice = "30" | "90" | "180" | "12m";
export const HORIZONS: ReadonlyArray<[HorizonChoice, string]> = [
  ["30", "30 days"],
  ["90", "90 days"],
  ["180", "180 days"],
  ["12m", "12 months"],
];

export function isHorizonChoice(value: string | null): value is HorizonChoice {
  return HORIZONS.some(([c]) => c === value);
}

/** Days in the horizon: 12 months is the calendar distance to the same day next year (365 or 366). */
export function horizonDays(choice: HorizonChoice, today: string): number {
  if (choice === "12m") return Math.min(366, dayDiff(today, addMonthsClamped(today, 12)));
  return Number(choice);
}

/** The projection request. `horizonDays` is omitted for the household default; `accountIds` unless a subset is chosen. */
export function projectionBody(input: { today: string; horizonDays?: number; whatIfs: readonly WhatIf[]; accountIds?: readonly string[] }): {
  today: string;
  horizonDays?: number;
  whatIfs: WhatIf[];
  accountIds?: string[];
} {
  return {
    today: input.today,
    ...(input.horizonDays !== undefined ? { horizonDays: input.horizonDays } : {}),
    whatIfs: [...input.whatIfs],
    ...(input.accountIds !== undefined ? { accountIds: [...input.accountIds] } : {}),
  };
}

/** Index of the skip aimed at this occurrence, or -1. What-ifs match on the ORIGINAL occurrence date. */
export function skipIndex(whatIfs: readonly WhatIf[], recurringId: string, occurrenceDate: string): number {
  return whatIfs.findIndex((w) => w.kind === "skipOccurrence" && w.recurringId === recurringId && w.occurrenceDate === occurrenceDate);
}

export function isSkipped(whatIfs: readonly WhatIf[], ev: Pick<CashFlowEvent, "recurringId" | "originalDate">): boolean {
  return ev.recurringId !== null && ev.originalDate !== null && skipIndex(whatIfs, ev.recurringId, ev.originalDate) >= 0;
}

/** Add a skip for the event's occurrence, or remove the existing one. Events without a recurring item are left alone. */
export function toggleSkip(whatIfs: readonly WhatIf[], ev: Pick<CashFlowEvent, "recurringId" | "originalDate">): WhatIf[] {
  if (ev.recurringId === null || ev.originalDate === null) return [...whatIfs];
  const i = skipIndex(whatIfs, ev.recurringId, ev.originalDate);
  if (i >= 0) return removeAt(whatIfs, i);
  return [...whatIfs, { kind: "skipOccurrence", recurringId: ev.recurringId, occurrenceDate: ev.originalDate }];
}

export type MoveScope = "one" | "all";

/** Append a move: this occurrence only, or every occurrence of the item. Returns the list unchanged for an invalid shift. */
export function addMove(whatIfs: readonly WhatIf[], ev: Pick<CashFlowEvent, "recurringId" | "originalDate">, shiftDays: number, scope: MoveScope): WhatIf[] {
  if (ev.recurringId === null || !Number.isInteger(shiftDays) || shiftDays === 0 || Math.abs(shiftDays) > 366) return [...whatIfs];
  const base = { kind: "moveOccurrence" as const, recurringId: ev.recurringId, shiftDays };
  const move: WhatIf = scope === "one" && ev.originalDate !== null ? { ...base, occurrenceDate: ev.originalDate } : base;
  return [...whatIfs, move];
}

export function removeAt(whatIfs: readonly WhatIf[], index: number): WhatIf[] {
  return whatIfs.filter((_, i) => i !== index);
}

export interface OneTimeForm {
  date: string;
  accountId: string;
  /** Decimal amount as typed ("800", "$1,250.50"); the direction supplies the sign. */
  amount: string;
  direction: "expense" | "income";
  label: string;
}

export type OneTimeResult = { ok: true; whatIf: WhatIf } | { ok: false; error: string };

/** Turn the add-one-time form into a what-if, or say what is wrong. */
export function oneTimeFromForm(form: OneTimeForm): OneTimeResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return { ok: false, error: "Pick a date" };
  if (!form.accountId) return { ok: false, error: "Pick an account" };
  const raw = form.amount.replace(/[$,\s]/g, "");
  if (raw === "" || raw.startsWith("-")) return { ok: false, error: "Enter a positive amount; the direction sets the sign" };
  let cents: bigint;
  try {
    cents = parseDecimalToCents(raw);
  } catch {
    return { ok: false, error: "Not an amount" };
  }
  if (cents === 0n) return { ok: false, error: "The amount must not be zero" };
  const signed = form.direction === "expense" ? -cents : cents;
  const label = form.label.trim();
  return {
    ok: true,
    whatIf: { kind: "oneTime", date: form.date, accountId: form.accountId, amountCents: signed.toString(), ...(label ? { label: label.slice(0, 100) } : {}) },
  };
}

export interface NameLookup {
  recurring: (id: string) => string;
  account: (id: string) => string;
}

/** The sentence the drawer shows for one what-if. */
export function describeWhatIf(w: WhatIf, names: NameLookup): string {
  switch (w.kind) {
    case "skipOccurrence":
      return `Skip ${names.recurring(w.recurringId)} on ${shortDate(w.occurrenceDate)}`;
    case "moveOccurrence": {
      const shift = `${w.shiftDays > 0 ? "+" : ""}${w.shiftDays} day${Math.abs(w.shiftDays) === 1 ? "" : "s"}`;
      const which = w.occurrenceDate === undefined ? "every occurrence" : `the ${shortDate(w.occurrenceDate)} occurrence`;
      return `Move ${names.recurring(w.recurringId)} ${shift} (${which})`;
    }
    case "oneTime": {
      const what = w.label ? `${w.label} ` : "";
      return `One-time ${what}${money(w.amountCents)} on ${shortDate(w.date)} in ${names.account(w.accountId)}`;
    }
  }
}

/** Human label for an event kind. */
export const EVENT_KIND_LABELS: Record<CashFlowEvent["kind"], string> = {
  income: "Income",
  bill: "Bill",
  transfer_out: "Transfer out",
  transfer_in: "Transfer in",
  card_payment_out: "Card payment",
  card_payment_in: "Card payment received",
  one_time: "One-time",
};

/** Recurring names seen in the projection, so what-if labels need no second request. */
export function recurringNamesFromEvents(events: readonly CashFlowEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const ev of events) if (ev.recurringId !== null && !names.has(ev.recurringId)) names.set(ev.recurringId, ev.label);
  return names;
}
