import { addDays, truncDiv } from "@meridian/shared";
import type { DashboardView } from "@meridian/shared";
import { money, shortDate } from "../../lib/format.js";

/**
 * Pure helpers for the dashboard cards. Every number is bigint cents until it
 * is formatted; percentages are basis points truncated toward zero.
 */

export type NetWorthView = DashboardView["netWorth"];
export type BillDue = DashboardView["billsDue"][number];
export type ReviewView = DashboardView["review"];
export type SyncAttention = DashboardView["sync"]["attention"][number];

/** Change as basis points of |base| (truncated toward zero); null when the base is 0. */
export function changePercentBp(changeCents: bigint, baseCents: bigint): number | null {
  if (baseCents === 0n) return null;
  const base = baseCents < 0n ? -baseCents : baseCents;
  return Number(truncDiv(changeCents * 10000n, base));
}

/** "64.2%" from 6428 bp (one decimal, truncated); "-25.0%" from -2500. */
export function percentText(bp: number): string {
  const sign = bp < 0 ? "-" : "";
  const abs = Math.abs(bp);
  const whole = Math.trunc(abs / 100);
  const tenth = Math.trunc((abs % 100) / 10);
  return `${sign}${whole}.${tenth}%`;
}

export interface ChangeText {
  text: string;
  tone: "ok" | "bad" | "neutral";
}

/** The 12-month change line under the net-worth number. */
export function netWorthChangeText(nw: Pick<NetWorthView, "yearAgoDate" | "yearAgoCents" | "changeCents">): ChangeText {
  if (nw.changeCents === null || nw.yearAgoCents === null) return { text: `No balances recorded as of ${shortDate(nw.yearAgoDate)} yet`, tone: "neutral" };
  const change = BigInt(nw.changeCents);
  const bp = changePercentBp(change, BigInt(nw.yearAgoCents));
  const signed = `${change > 0n ? "+" : ""}${money(nw.changeCents)}`;
  const pct = bp === null ? "" : ` (${bp > 0 ? "+" : ""}${percentText(bp)})`;
  return { text: `${signed}${pct} since ${shortDate(nw.yearAgoDate)}`, tone: change > 0n ? "ok" : change < 0n ? "bad" : "neutral" };
}

/** "Visa and Brokerage are newer than a year and count as $0.00 a year ago." */
export function newAccountsNote(newAccounts: NetWorthView["newAccounts"]): string | null {
  if (newAccounts.length === 0) return null;
  const names = newAccounts.map((a) => a.name);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
  const verb = names.length === 1 ? "is" : "are";
  const count = names.length === 1 ? "counts" : "count";
  return `${list} ${verb} newer than a year and ${count} as $0.00 a year ago.`;
}

export function sumCents(values: readonly string[]): string {
  return values.reduce((acc, v) => acc + BigInt(v), 0n).toString();
}

/** Bills due in the next 14 days: totals and the overdue subset. */
export function billsSummary(bills: readonly BillDue[], today: string): { totalCents: string; overdue: number; windowEnd: string } {
  return { totalCents: sumCents(bills.map((b) => b.amountCents)), overdue: bills.filter((b) => b.overdue).length, windowEnd: addDays(today, 14) };
}

export interface ReviewLink {
  to: string;
  label: string;
  count: number;
}

export function reviewLinks(review: ReviewView): ReviewLink[] {
  return [
    { to: "/transactions?uncategorized=true", label: "uncategorized transactions", count: review.uncategorized },
    { to: "/recurring?status=suggested", label: "suggested recurring items", count: review.suggestedRecurring },
    { to: "/alerts", label: "open alerts", count: review.alerts },
  ];
}

export function syncTone(status: SyncAttention["status"]): "warn" | "bad" | "neutral" {
  switch (status) {
    case "auth_required":
      return "warn";
    case "error":
      return "bad";
    default:
      return "neutral";
  }
}

export function syncStatusText(status: SyncAttention["status"]): string {
  switch (status) {
    case "auth_required":
      return "needs a new token";
    case "error":
      return "last sync failed";
    case "disabled":
      return "disabled";
    case "claiming":
      return "claiming";
    default:
      return "ok";
  }
}
