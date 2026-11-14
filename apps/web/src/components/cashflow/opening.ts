import { dayDiff, type CashFlowProjectionResponse } from "@meridian/shared";
import { money, shortDate } from "../../lib/format.js";

/**
 * Where each account's projection starts (audit finding b9-conformance-plan-investments-02;
 * phase 2 plan, audit decision A28): the date of the balance it starts from, the rows imported
 * since that an account without a bank feed adds to it, and whether that is older than the
 * loader's two days. Pure helpers for the Cash flow page and the dashboard card.
 */

type AccountSeries = CashFlowProjectionResponse["accounts"][number];

/** The loader names an opening older than this many days (`STALE_OPENING_DAYS`). */
export const STALE_OPENING_DAYS = 2;

export interface OpeningNote {
  /** "balance as of 11/12/26", or "balance of 10/31/26 + 2 transactions through 11/06/26 (−$950.00)". */
  text: string;
  stale: boolean;
}

export function isStaleOpening(dataThrough: string | null, today: string): boolean {
  return dataThrough !== null && dayDiff(dataThrough, today) > STALE_OPENING_DAYS;
}

export function openingNote(a: Pick<AccountSeries, "balanceDate" | "rolledForwardCents" | "rolledForwardRows" | "dataThrough">, today: string): OpeningNote {
  if (a.balanceDate === null) return { text: "no known balance", stale: true };
  const stale = isStaleOpening(a.dataThrough, today);
  if (a.rolledForwardRows === 0) return { text: `balance as of ${shortDate(a.balanceDate)}`, stale };
  const rows = `${a.rolledForwardRows} transaction${a.rolledForwardRows === 1 ? "" : "s"}`;
  return { text: `balance of ${shortDate(a.balanceDate)} + ${rows} through ${shortDate(a.dataThrough)} (${money(a.rolledForwardCents)})`, stale };
}

/** The dashboard card's line, or null when every opening is from today or yesterday. */
export function balancesAsOfText(balancesAsOf: string | null, today: string): string | null {
  if (balancesAsOf === null || balancesAsOf >= today) return null;
  return `Starts from balances as of ${shortDate(balancesAsOf)}`;
}
