import type { CashFlowProjectionResponse } from "@meridian/shared";
import { monthLabel } from "../../lib/plan.js";

/**
 * Planned income, bills and savings the projection does not hold because no recurring item dates
 * them (audit finding b5-recurring-cashflow-03; phase 2 plan, audit decision A14). Pure helpers
 * for the Cash flow page's notice.
 */

export type UnscheduledItem = CashFlowProjectionResponse["unscheduled"][number];

export interface UnscheduledRow {
  categoryId: string;
  categoryName: string;
  bucket: UnscheduledItem["bucket"];
  /** "Dec 2026, Jan 2027". */
  months: string;
  /** Signed like the ledger: income in (+), bills and savings out (−). */
  totalCents: string;
  link: string;
}

/** The Recurring page's add form, with the category and the direction filled in. */
export function newRecurringLink(u: Pick<UnscheduledItem, "categoryId" | "bucket">): string {
  const direction = u.bucket === "income" ? "inflow" : "outflow";
  return `/recurring?new=1&category=${encodeURIComponent(u.categoryId)}&direction=${direction}`;
}

/** One row per category, in the order the response lists them (month, bucket, name). */
export function unscheduledRows(items: readonly UnscheduledItem[]): UnscheduledRow[] {
  const rows = new Map<string, { first: UnscheduledItem; months: string[]; total: bigint }>();
  for (const u of items) {
    const row = rows.get(u.categoryId) ?? { first: u, months: [], total: 0n };
    row.months.push(monthLabel(u.month));
    row.total += BigInt(u.amountCents);
    rows.set(u.categoryId, row);
  }
  return [...rows.values()].map(({ first, months, total }) => ({
    categoryId: first.categoryId,
    categoryName: first.categoryName,
    bucket: first.bucket,
    months: months.join(", "),
    totalCents: (first.bucket === "income" ? total : -total).toString(),
    link: newRecurringLink(first),
  }));
}
