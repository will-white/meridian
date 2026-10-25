import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidatePrices } from "./PriceHistoryDrawer.js";
import { invalidateInvestments } from "./queries.js";
import { invalidateReconcile } from "./ReconcileHistory.js";

/** The root key of every `invalidateQueries` call the function makes. */
function invalidatedRoots(invalidate: (qc: QueryClient) => void): string[] {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue(undefined);
  invalidate(qc);
  return spy.mock.calls.map(([filters]) => String((filters as { queryKey: readonly unknown[] }).queryKey[0]));
}

// Every query root an editor can change: an accepted statement writes a holding snapshot, a trade
// import rebuilds lots and rows, a merge rewrites snapshots, rows and lots, a positions commit
// changes what the reconcile preview compares against.
const EDIT_ROOTS = ["investments", "valuation", "accounts", "settings", "securities", "prices", "snapshots", "lots", "investment-transactions", "reconcile", "plan", "dashboard"];

describe("the one invalidation list", () => {
  it("covers snapshots, lots, investment transactions and reconciliations beside the views", () => {
    expect(invalidatedRoots(invalidateInvestments)).toEqual(EDIT_ROOTS);
  });
  it("is what a reconciliation and a price edit invalidate too", () => {
    expect(invalidatedRoots(invalidateReconcile)).toEqual(EDIT_ROOTS);
    expect(invalidatedRoots(invalidatePrices)).toEqual(EDIT_ROOTS);
  });
});
