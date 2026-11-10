import { formatCents, parseDecimalToCents } from "@meridian/shared";
import type { TransactionSplitView, TransactionView } from "@meridian/shared";

/**
 * Pure helpers for split transactions: what a row contributes to a category, and turning the
 * split editor's typed lines into the request body. Amounts are typed as magnitudes in the
 * transaction's own direction ("60.00" of a 100.00 purchase); a leading minus runs the other
 * way (20.00 cash back on a grocery run). No floats.
 */

/** The cents of `t` that count in `categoryId`: its split lines there, or the whole amount when it is not split. */
export function amountInCategory(t: Pick<TransactionView, "amountCents" | "splits">, categoryId: string): bigint {
  if (t.splits.length === 0) return BigInt(t.amountCents);
  return t.splits.filter((s) => s.categoryId === categoryId).reduce((sum, s) => sum + BigInt(s.amountCents), 0n);
}

/** One row of the split editor, as typed. */
export interface SplitDraftLine {
  categoryId: string;
  amount: string;
  memo: string;
}

export interface SplitRequestLine {
  categoryId: string;
  amountCents: string;
  memo: string | null;
}

export const MAX_SPLIT_LINES = 20;

const sign = (cents: bigint): bigint => (cents < 0n ? -1n : 1n);

/** Signed cents of a typed magnitude ("60", "60.5", "1,234.50", "-20.00"), or null when it is not an amount. */
export function parseSplitAmount(raw: string, totalCents: bigint): bigint | null {
  let s = raw.replace(/[$,\s]/g, "");
  let opposite = false;
  if (s.startsWith("-")) {
    opposite = true;
    s = s.slice(1);
  }
  if (s.startsWith(".")) s = `0${s}`;
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const magnitude = parseDecimalToCents(s);
  return sign(totalCents) * (opposite ? -magnitude : magnitude);
}

/** The editor's starting lines: the existing split, or the whole amount on the row's category plus one empty line. */
export function initialSplitDraft(t: Pick<TransactionView, "amountCents" | "categoryId" | "splits">): SplitDraftLine[] {
  const total = BigInt(t.amountCents);
  const typed = (cents: bigint): string => {
    const magnitude = sign(total) * cents;
    return formatCents(magnitude);
  };
  if (t.splits.length > 0) return t.splits.map((s: TransactionSplitView) => ({ categoryId: s.categoryId ?? "", amount: typed(BigInt(s.amountCents)), memo: s.memo ?? "" }));
  return [
    { categoryId: t.categoryId ?? "", amount: typed(total), memo: "" },
    { categoryId: "", amount: "", memo: "" },
  ];
}

/** What is still unassigned: the transaction amount minus the lines that parse (signed like the transaction). */
export function splitRemainderCents(totalCents: bigint, lines: readonly SplitDraftLine[]): bigint {
  let sum = 0n;
  for (const line of lines) sum += parseSplitAmount(line.amount, totalCents) ?? 0n;
  return totalCents - sum;
}

/** The editor's running status, in the transaction's own direction: fully assigned, some left, or too much. */
export function splitRemainderLabel(totalCents: bigint, lines: readonly SplitDraftLine[]): { done: boolean; text: string } {
  const left = sign(totalCents) * splitRemainderCents(totalCents, lines);
  if (left === 0n) return { done: true, text: "Fully assigned" };
  if (left > 0n) return { done: false, text: `${formatCents(left)} still unassigned` };
  return { done: false, text: `${formatCents(-left)} over the transaction amount` };
}

export type SplitBuildResult = { ok: true; lines: SplitRequestLine[] } | { ok: false; error: string };

/** Validate the typed lines against the transaction amount and build the PUT body, or say what is wrong. */
export function buildSplitLines(totalCents: bigint, drafts: readonly SplitDraftLine[]): SplitBuildResult {
  const filled = drafts.filter((d) => d.categoryId !== "" || d.amount.trim() !== "" || d.memo.trim() !== "");
  if (filled.length < 2) return { ok: false, error: "A split needs at least two lines" };
  if (filled.length > MAX_SPLIT_LINES) return { ok: false, error: `At most ${MAX_SPLIT_LINES} lines` };
  const lines: SplitRequestLine[] = [];
  let sum = 0n;
  for (const [i, d] of filled.entries()) {
    if (d.categoryId === "") return { ok: false, error: `Line ${i + 1}: pick a category` };
    const cents = parseSplitAmount(d.amount, totalCents);
    if (cents === null) return { ok: false, error: `Line ${i + 1}: not an amount` };
    if (cents === 0n) return { ok: false, error: `Line ${i + 1}: the amount can't be zero` };
    sum += cents;
    lines.push({ categoryId: d.categoryId, amountCents: cents.toString(), memo: d.memo.trim() || null });
  }
  if (sum !== totalCents) {
    const left = sign(totalCents) * (totalCents - sum);
    return { ok: false, error: left > 0n ? `${formatCents(left)} is still unassigned` : `The lines are ${formatCents(-left)} over the transaction amount` };
  }
  return { ok: true, lines };
}
