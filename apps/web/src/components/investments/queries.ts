import type { QueryClient } from "@tanstack/react-query";
import { useAuthStatus } from "../../lib/auth.js";

/**
 * Query conventions shared by the Investments pages: keys under
 * `['investments', view, params]` and `['valuation', view, params]`, a 30 s
 * stale time (the nightly price job may have run; refetch on focus is the
 * client default), and one invalidation list for every editor.
 */

export const INVESTMENTS_STALE_MS = 30_000;

/**
 * Keys an investment edit can change: the views, the valuation, accounts,
 * settings, securities, prices, holding snapshots, lots, investment
 * transactions, reconciliations, the plan and the dashboard. One list for
 * every editor (an accepted statement writes a snapshot, a trade import
 * rebuilds lots, a merge rewrites snapshots and rows); an invalidated key
 * refetches only while a page shows it, so the breadth is cheap.
 */
const INVALIDATE_AFTER_EDIT = [
  ["investments"],
  ["valuation"],
  ["accounts"],
  ["settings"],
  ["securities"],
  ["prices"],
  ["snapshots"],
  ["lots"],
  ["investment-transactions"],
  ["reconcile"],
  ["plan"],
  ["dashboard"],
] as const;

export function invalidateInvestments(qc: QueryClient): void {
  for (const queryKey of INVALIDATE_AFTER_EDIT) void qc.invalidateQueries({ queryKey });
}

/** A viewer sees every table and no editor (plan decision 19). */
export function useIsViewer(): boolean {
  const status = useAuthStatus();
  return status.data?.role === "viewer";
}
