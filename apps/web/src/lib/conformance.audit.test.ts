import { describe, expect, it } from "vitest";
import type { AuditEntryView } from "@meridian/shared";
import { MAX_RANGE_MONTHS, defaultRange, resizeRange, shiftRange } from "./plan.js";
import { describeEntry, groupBatches, laterChanges } from "./planHistory.js";

/**
 * Audit batch b9-conformance-plan-investments: the pure web helpers
 * (docs/audit/phases-1-3/b9-conformance-plan-investments.md).
 */

describe("b9-07: the plan's month window moves and shrinks as well as grows", () => {
  const def = defaultRange("2026-11-13"); // Sep 2026 – Feb 2027: last 2, current, next 3

  it("‹ and › move the window one month without widening it", () => {
    expect(def).toEqual({ from: "2026-09", to: "2027-02" });
    expect(shiftRange(def, -1)).toEqual({ from: "2026-08", to: "2027-01" });
    expect(shiftRange(def, 1)).toEqual({ from: "2026-10", to: "2027-03" });
    expect(shiftRange({ from: "2025-01", to: "2026-12" }, -1)).toEqual({ from: "2024-12", to: "2026-11" });
  });

  it("at 24 months the window still moves, so any month from 2000-01 on can be reached", () => {
    let r = { from: "2025-01", to: "2026-12" };
    for (let i = 0; i < 40; i++) r = shiftRange(r, -1);
    expect(r).toEqual({ from: "2021-09", to: "2023-08" });
    expect(shiftRange({ from: "2000-01", to: "2001-12" }, -1)).toEqual({ from: "2000-01", to: "2001-12" });
    expect(shiftRange({ from: "2000-02", to: "2000-07" }, -3)).toEqual({ from: "2000-01", to: "2000-06" });
  });

  it("the month count picks how many months are shown, keeping the current month in view at its relative place", () => {
    const current = "2026-11";
    expect(resizeRange(def, 1, current)).toEqual({ from: "2026-11", to: "2026-11" });
    expect(resizeRange(def, 2, current)).toEqual({ from: "2026-11", to: "2026-12" });
    expect(resizeRange(def, 3, current)).toEqual({ from: "2026-10", to: "2026-12" });
    expect(resizeRange(def, 6, current)).toEqual(def);
    expect(resizeRange(def, 12, current)).toEqual({ from: "2026-07", to: "2027-06" });
    expect(resizeRange(def, MAX_RANGE_MONTHS, current)).toEqual({ from: "2026-02", to: "2028-01" });
    // out of bounds is clamped to 1..24
    expect(resizeRange(def, 0, current)).toEqual({ from: "2026-11", to: "2026-11" });
    expect(resizeRange(def, 99, current)).toEqual({ from: "2026-02", to: "2028-01" });
  });

  it("the window never ends after 2199-12, the last month a request may name", () => {
    expect(shiftRange({ from: "2199-07", to: "2199-12" }, 1)).toEqual({ from: "2199-07", to: "2199-12" });
    expect(resizeRange({ from: "2199-10", to: "2199-12" }, 6, "2026-11")).toEqual({ from: "2199-07", to: "2199-12" });
  });

  it("a window that does not show the current month keeps its first month", () => {
    expect(resizeRange({ from: "2024-01", to: "2024-06" }, 3, "2026-11")).toEqual({ from: "2024-01", to: "2024-03" });
    expect(resizeRange({ from: "2024-01", to: "2024-06" }, 12, "2026-11")).toEqual({ from: "2024-01", to: "2024-12" });
  });
});

describe("b9-03: the plan's history in words", () => {
  const CAT = "11111111-1111-4111-8111-111111111111";
  const ACC = "22222222-2222-4222-8222-222222222222";
  const e = (over: Partial<AuditEntryView>): AuditEntryView => ({
    id: "00000000-0000-4000-8000-000000000001",
    at: "2026-11-13T16:05:00.000Z",
    userId: null,
    username: null,
    batchId: "b1",
    entity: "household_setting",
    entityId: "1",
    action: "update",
    before: null,
    after: null,
    ...over,
  });
  const names = { category: (id: string) => (id === CAT ? "Dining" : undefined), account: (id: string) => (id === ACC ? "Checking" : undefined) };

  it("names what changed, from what to what", () => {
    expect(describeEntry(e({ before: { zeroBased: false, primaryAccountId: null, lowBalanceThresholdCents: "0" }, after: { zeroBased: true, primaryAccountId: ACC, lowBalanceThresholdCents: "50000" } }), names)).toBe(
      "Settings: zero-based off → on; primary account none → Checking; low-balance threshold $0.00 → $500.00",
    );
    expect(describeEntry(e({ before: { investmentIncomeCategoryId: null }, after: { investmentIncomeCategoryId: CAT } }), names)).toBe("Settings: investment income category none → Dining");
    expect(describeEntry(e({ entity: "recurring", entityId: "r", before: { name: "Netflix", expectedCents: "-1549", status: "active" }, after: { name: "Netflix", expectedCents: "-1799", status: "paused" } }), names)).toBe(
      "Recurring Netflix: expected amount -$15.49 → -$17.99; status active → paused",
    );
    expect(describeEntry(e({ entity: "category", entityId: CAT, before: { name: "Dining", rolloverMode: "none", rolloverFromMonth: null }, after: { name: "Dining", rolloverMode: "surplus_only", rolloverFromMonth: "2026-11" } }), names)).toMatch(
      /^Category Dining: rollover .+ → .+; rollover from none → Nov 2026$/,
    );
    expect(describeEntry(e({ entity: "month_plan", entityId: `2026-11:${CAT}`, action: "delete", before: { plannedCents: "25000", source: "average", rolloverMode: null, carriedInOverrideCents: null, note: null }, after: null }), names)).toBe(
      "Dining · Nov 2026: planned automatic (was $250.00 (average))",
    );
  });

  it("groups the newest-first list by request and counts later changes to the same values", () => {
    const items = [e({ batchId: "b3", entityId: "1" }), e({ batchId: "b2", entity: "month_plan", entityId: `2026-11:${CAT}` }), e({ batchId: "b2", entity: "month_plan", entityId: `2026-12:${CAT}` }), e({ batchId: "b1", entityId: "1" })];
    const batches = groupBatches(items);
    expect(batches.map((b) => [b.batchId, b.entries.length])).toEqual([
      ["b3", 1],
      ["b2", 2],
      ["b1", 1],
    ]);
    expect(laterChanges(batches[2]!, items.slice(0, 3))).toBe(1);
    expect(laterChanges(batches[1]!, items.slice(0, 1))).toBe(0);
  });
});
