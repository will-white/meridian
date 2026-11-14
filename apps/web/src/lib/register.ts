import type { InfiniteData } from "@tanstack/react-query";
import { parseDecimalToCents, type TransactionList, type TransactionView } from "@meridian/shared";
import { fitsWire, TOO_LARGE } from "./amounts.js";
import { shortDate } from "./format.js";

/**
 * The register's edits beyond the category (audit a8-ledger-ui-04 and -12, -16): a row's payee,
 * notes and tags, a transaction entered by hand, the other leg a transfer is paired with, and
 * the category a row shows while its save is on the way.
 */

/** `UpdateTransactionBody`'s bounds. */
export const PAYEE_MAX = 200;
export const NOTES_MAX = 2000;
export const TAG_MAX = 50;
export const TAGS_MAX = 50;

/**
 * Which row a transfer leg is paired with (audit a8-ledger-ui-12): "to Savings · 11/03/26" on
 * the outflow, "from Checking · 11/02/26" on the inflow, and for a transfer marked without its
 * other leg, that it has none in the app. Null for a row that is not a transfer.
 */
export function transferLabel(t: Pick<TransactionView, "isTransfer" | "amountCents" | "transferPartner">): string | null {
  if (!t.isTransfer) return null;
  const p = t.transferPartner;
  if (!p) return "no other leg in the app";
  return `${t.amountCents.startsWith("-") ? "to" : "from"} ${p.accountName} · ${shortDate(p.date)}`;
}

/** Tags as typed: "trip, #house project, trip" → ["trip", "house project"]. */
export function parseTags(raw: string): { ok: true; tags: string[] } | { ok: false; error: string } {
  const tags = [
    ...new Set(
      raw
        .split(",")
        .map((t) => t.trim().replace(/^#+/, "").trim())
        .filter((t) => t.length > 0),
    ),
  ];
  const long = tags.find((t) => t.length > TAG_MAX);
  if (long) return { ok: false, error: `A tag is at most ${TAG_MAX} characters ("${long.slice(0, 20)}…" is ${long.length})` };
  if (tags.length > TAGS_MAX) return { ok: false, error: `At most ${TAGS_MAX} tags` };
  return { ok: true, tags };
}

export interface TransactionEditForm {
  payee: string;
  notes: string;
  /** Comma-separated. */
  tags: string;
}

export function transactionEditForm(t: Pick<TransactionView, "payeeName" | "notes" | "tags">): TransactionEditForm {
  return { payee: t.payeeName ?? "", notes: t.notes ?? "", tags: t.tags.join(", ") };
}

export interface TransactionEditBody {
  payeeName?: string;
  notes?: string | null;
  tags?: string[];
}

/** The PATCH body for what changed, or what is wrong. Blank notes clear them; a row's payee can be changed but not removed. */
export function transactionEditBody(
  t: Pick<TransactionView, "payeeName" | "notes" | "tags">,
  form: TransactionEditForm,
): { ok: true; body: TransactionEditBody } | { ok: false; error: string } {
  const body: TransactionEditBody = {};
  const payee = form.payee.trim();
  if (payee !== (t.payeeName ?? "")) {
    if (payee === "") return { ok: false, error: "A payee cannot be removed; type the name it should have" };
    if (payee.length > PAYEE_MAX) return { ok: false, error: `A payee is at most ${PAYEE_MAX} characters` };
    body.payeeName = payee;
  }
  const notes = form.notes.trim();
  if (notes.length > NOTES_MAX) return { ok: false, error: `Notes are at most ${NOTES_MAX} characters (these are ${notes.length})` };
  if (notes !== (t.notes ?? "")) body.notes = notes === "" ? null : notes;
  const tags = parseTags(form.tags);
  if (!tags.ok) return tags;
  if (tags.tags.join("\u0000") !== t.tags.join("\u0000")) body.tags = tags.tags;
  return { ok: true, body };
}

export interface ManualTransactionForm {
  accountId: string;
  date: string;
  /** Signed as the bank would show it: spending is negative. */
  amount: string;
  payee: string;
  categoryId: string;
  notes: string;
}

export interface ManualTransactionBody {
  accountId: string;
  date: string;
  amountCents: string;
  payeeName: string;
  categoryId?: string;
  notes?: string;
}

/**
 * `POST /api/transactions` for a transaction entered by hand (a cash purchase, a check that has
 * not cleared): the amount read with string math, bounded, and never zero.
 */
export function buildManualTransaction(form: ManualTransactionForm, today: string): { ok: true; body: ManualTransactionBody } | { ok: false; error: string } {
  if (!form.accountId) return { ok: false, error: "Choose the account" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return { ok: false, error: "Give the date" };
  if (form.date > today) return { ok: false, error: `A transaction cannot be dated after today (${shortDate(today)})` };
  let s = form.amount.replace(/[$,\s]/g, "");
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith(".")) s = `0${s}`;
  if (s === "") return { ok: false, error: "Give the amount (spending is negative, e.g. -12.50)" };
  if (/^\d+\.\d{3,}$/.test(s)) return { ok: false, error: "Use at most two decimals" };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: "The amount is not an amount (spending is negative, e.g. -12.50)" };
  const magnitude = parseDecimalToCents(s);
  if (magnitude === 0n) return { ok: false, error: "The amount can't be zero" };
  if (!fitsWire(magnitude)) return { ok: false, error: TOO_LARGE };
  const payee = form.payee.trim();
  if (payee === "") return { ok: false, error: "Give the payee" };
  if (payee.length > PAYEE_MAX) return { ok: false, error: `A payee is at most ${PAYEE_MAX} characters` };
  const notes = form.notes.trim();
  if (notes.length > NOTES_MAX) return { ok: false, error: `Notes are at most ${NOTES_MAX} characters` };
  return {
    ok: true,
    body: {
      accountId: form.accountId,
      date: form.date,
      amountCents: (negative ? -magnitude : magnitude).toString(),
      payeeName: payee,
      ...(form.categoryId ? { categoryId: form.categoryId } : {}),
      ...(notes ? { notes } : {}),
    },
  };
}

/**
 * A cached register page set with one row's category set (audit a8-ledger-ui-16): the register
 * shows the category picked while its save is on the way, and goes back if the save fails.
 */
export function withCategory(data: InfiniteData<TransactionList, unknown> | undefined, id: string, categoryId: string | null, categoryName: string | null): InfiniteData<TransactionList, unknown> | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => ({
    ...page,
    items: page.items.map((t) => {
      if (t.id !== id) return t;
      changed = true;
      return { ...t, categoryId, categoryName, categoryLocked: true, splits: [] };
    }),
  }));
  return changed ? { ...data, pages } : data;
}

/** Asked before a split row is made a transfer: a transfer has no split, so its lines go (audit a8-ledger-ui-10). */
export function splitTransferQuestion(t: Pick<TransactionView, "splits">, action: "mark" | "pair"): string | null {
  if (t.splits.length === 0) return null;
  const doing = action === "mark" ? "Mark it as a transfer" : "Pair it as a transfer";
  return `This transaction is split across ${t.splits.length} lines. A transfer has no split, so the lines are removed and the plan no longer counts it. ${doing}?`;
}
