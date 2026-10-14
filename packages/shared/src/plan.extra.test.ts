import { describe, expect, it } from "vitest";
import { computePlan, type ComputePlanInput } from "./plan.js";

const base: ComputePlanInput = {
  startMonth: "2026-10",
  from: "2026-10",
  to: "2026-10",
  today: "2026-10-13",
  zeroBased: false,
  groups: [],
  categories: [{ id: "pay", name: "Paycheck", bucket: "income", groupId: null, position: 1, hidden: false, rolloverMode: "none", rolloverFromMonth: null, goalId: null }],
  rows: [{ categoryId: "pay", month: "2026-10", plannedCents: 100n, plannedSource: "manual", rolloverMode: null, carriedInOverrideCents: null, note: null }],
  actuals: [{ categoryId: "pay", month: "2026-10", signedCents: 200n, pendingSignedCents: 0n, count: 1 }],
  goalNets: [],
  autoPlans: [],
  goals: [],
  uncategorized: [],
};

describe("engine review probes", () => {
  it("E1 income above plan: the category cell is not overspent but the income bucket subtotal row is", () => {
    const r = computePlan(base);
    const bucket = r.rows.find((x) => x.kind === "bucket")!;
    const cat = r.rows.find((x) => x.kind === "category")!;
    expect(cat.cells[0]).toMatchObject({ remainingCents: -100n, overspendCents: 0n, overspent: false });
    expect(bucket.cells[0]).toMatchObject({ remainingCents: -100n, overspendCents: 0n, overspent: false });
  });
});
