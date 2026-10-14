import { describe, expect, it } from "vitest";
import type { PlanCellView, PlanResponse, PlanRow } from "@meridian/shared";
import {
  applyEdits,
  carriedText,
  defaultRange,
  drillDownUrl,
  fillRightEdits,
  localToday,
  monthLabel,
  moveId,
  nextCategoryIndex,
  paceText,
  parseAmountInput,
  patchCell,
  plannedInputValue,
  resolveRange,
  rowHeight,
  sourceMarker,
  stickyBucketIndex,
  uncategorizedUrl,
  visibleRows,
  type PlanCategoryRow,
} from "./plan.js";

const cell = (over: Partial<PlanCellView> = {}): PlanCellView => ({
  plannedCents: "0",
  source: "none",
  hasExplicitPlan: false,
  carriedInCents: "0",
  carriedInSource: "none",
  availableCents: "0",
  actualCents: "0",
  pendingCents: "0",
  remainingCents: "0",
  overspendCents: "0",
  committedCents: "0",
  rolloverMode: "none",
  txnCount: 0,
  overspent: false,
  note: null,
  ...over,
});

const GROCERIES = "11111111-1111-4111-8111-111111111111";
const FUND = "22222222-2222-4222-8222-222222222222";
const GOAL = "33333333-3333-4333-8333-333333333333";

const groceries = (): PlanCategoryRow => ({
  kind: "category",
  bucket: "spending",
  groupId: null,
  categoryId: GROCERIES,
  name: "Groceries",
  position: 1,
  hidden: false,
  rolloverMode: "all",
  rolloverFromMonth: "2026-09",
  goal: null,
  // Seed numbers from grid-and-api.md: Sep 50000/0/40000, Oct 50000/10000/54500, Nov 50000/5500/0.
  cells: [
    cell({ plannedCents: "50000", source: "manual", hasExplicitPlan: true, actualCents: "40000", remainingCents: "10000", availableCents: "50000", committedCents: "50000" }),
    cell({ plannedCents: "50000", source: "manual", hasExplicitPlan: true, carriedInCents: "10000", actualCents: "54500", remainingCents: "5500", availableCents: "60000", committedCents: "50000" }),
    cell({ plannedCents: "50000", source: "manual", hasExplicitPlan: true, carriedInCents: "5500", remainingCents: "55500", availableCents: "55500", committedCents: "50000" }),
  ],
});

describe("localToday and ranges", () => {
  it("uses the browser's local calendar date", () => {
    expect(localToday(new Date(2026, 9, 13, 23, 30))).toBe("2026-10-13");
    expect(localToday(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
  });
  it("defaults to current-2 .. current+3", () => {
    expect(defaultRange("2026-10-13")).toEqual({ from: "2026-08", to: "2027-01" });
    expect(defaultRange("2026-01-05")).toEqual({ from: "2025-11", to: "2026-04" });
  });
  it("resolves URL params independently and repairs bad ranges", () => {
    expect(resolveRange(null, null, "2026-10-13")).toEqual({ from: "2026-08", to: "2027-01" });
    expect(resolveRange("2026-10", null, "2026-10-13")).toEqual({ from: "2026-10", to: "2027-01" });
    expect(resolveRange(null, "2026-10", "2026-10-13")).toEqual({ from: "2026-08", to: "2026-10" });
    expect(resolveRange("2026-13", "bogus", "2026-10-13")).toEqual({ from: "2026-08", to: "2027-01" });
    expect(resolveRange("2026-12", "2026-10", "2026-10-13")).toEqual({ from: "2026-08", to: "2027-01" });
    expect(resolveRange("2027-06", null, "2026-10-13")).toEqual({ from: "2027-06", to: "2027-11" });
    expect(resolveRange(null, "2025-01", "2026-10-13")).toEqual({ from: "2024-08", to: "2025-01" });
    expect(resolveRange("2024-01", "2026-12", "2026-10-13")).toEqual({ from: "2024-01", to: "2025-12" });
  });
});

describe("parseAmountInput", () => {
  it("accepts the documented shapes and strips $ and commas", () => {
    expect(parseAmountInput("1,234.50")).toEqual({ ok: true, cents: 123450n });
    expect(parseAmountInput("$12")).toEqual({ ok: true, cents: 1200n });
    expect(parseAmountInput("12.5")).toEqual({ ok: true, cents: 1250n });
    expect(parseAmountInput(" $1,000 ")).toEqual({ ok: true, cents: 100000n });
    expect(parseAmountInput(".5")).toEqual({ ok: true, cents: 50n });
    expect(parseAmountInput("12.")).toEqual({ ok: true, cents: 1200n });
    expect(parseAmountInput("0")).toEqual({ ok: true, cents: 0n });
  });
  it("treats empty as no value and rejects negatives and junk", () => {
    expect(parseAmountInput("")).toEqual({ ok: true, cents: null });
    expect(parseAmountInput("  ")).toEqual({ ok: true, cents: null });
    expect(parseAmountInput("-5")).toEqual({ ok: false, error: "Amounts can't be negative" });
    expect(parseAmountInput("(5)")).toEqual({ ok: false, error: "Amounts can't be negative" });
    expect(parseAmountInput("12.345")).toEqual({ ok: false, error: "Use at most two decimals" });
    expect(parseAmountInput("abc")).toEqual({ ok: false, error: "Not an amount" });
    expect(parseAmountInput("1e3")).toEqual({ ok: false, error: "Not an amount" });
  });
});

describe("cell display helpers", () => {
  it("shows the resolved value, empty for an auto zero, 0.00 for a manual zero", () => {
    expect(plannedInputValue(cell({ plannedCents: "180000", hasExplicitPlan: false }))).toBe("1800.00");
    expect(plannedInputValue(cell({ plannedCents: "0", hasExplicitPlan: false }))).toBe("");
    expect(plannedInputValue(cell({ plannedCents: "0", hasExplicitPlan: true }))).toBe("0.00");
  });
  it("marks recurring, goal and average sources only", () => {
    expect(sourceMarker("recurring")).toBe("R");
    expect(sourceMarker("goal")).toBe("G");
    expect(sourceMarker("average")).toBe("A");
    expect(sourceMarker("manual")).toBeNull();
    expect(sourceMarker("none")).toBeNull();
  });
  it("formats pace and carried notes", () => {
    expect(paceText({ daysLeft: 19, perDayCents: "9229", overCents: "0" })).toBe("$92.29/day for 19 days");
    expect(paceText({ daysLeft: 1, perDayCents: "5000", overCents: "0" })).toBe("$50.00/day for 1 day");
    expect(paceText({ daysLeft: 1, perDayCents: "0", overCents: "5000" })).toBe("over by $50.00");
    expect(carriedText("5500")).toBe("+$55.00 in");
    expect(carriedText("-6000")).toBe("-$60.00 in");
    expect(carriedText("0")).toBeNull();
    expect(monthLabel("2026-10")).toBe("Oct 2026");
    expect(monthLabel("2028-02")).toBe("Feb 2028");
  });
  it("sizes rows by kind and density", () => {
    expect(rowHeight({ kind: "bucket" }, false)).toBe(40);
    expect(rowHeight({ kind: "group" }, true)).toBe(32);
    expect(rowHeight({ kind: "category" }, false)).toBe(48);
    expect(rowHeight({ kind: "category" }, true)).toBe(28);
  });
});

describe("edits", () => {
  const months = ["2026-09", "2026-10", "2026-11"];

  it("fill right writes one manual edit per later visible month with the displayed value", () => {
    const row = groceries();
    row.cells[1] = cell({ plannedCents: "23500", source: "average", hasExplicitPlan: true });
    expect(fillRightEdits(row, months, 1)).toEqual([{ month: "2026-11", categoryId: GROCERIES, plannedCents: "23500", source: "manual" }]);
    expect(fillRightEdits(row, months, 0)).toHaveLength(2);
    expect(fillRightEdits(row, months, 2)).toEqual([]);
  });

  it("patchCell re-derives available, remaining, overspend and committed", () => {
    // Groceries Oct: planned 60000 with carriedIn 10000 and actual 54500 -> remaining 15500, committed 60000.
    const oct = groceries().cells[1]!;
    const patched = patchCell(oct, "spending", { month: "2026-10", categoryId: GROCERIES, plannedCents: "60000", source: "manual" });
    expect(patched.plannedCents).toBe("60000");
    expect(patched.availableCents).toBe("70000");
    expect(patched.remainingCents).toBe("15500");
    expect(patched.overspendCents).toBe("0");
    expect(patched.committedCents).toBe("60000");
    expect(patched.overspent).toBe(false);
    expect(patched.hasExplicitPlan).toBe(true);
    // Dining Sep: planned 20000, actual 26000 -> remaining -6000, overspend 6000, committed 26000.
    const dining = patchCell(cell({ actualCents: "26000" }), "spending", { month: "2026-09", categoryId: GROCERIES, plannedCents: "20000", source: "manual" });
    expect(dining.remainingCents).toBe("-6000");
    expect(dining.overspendCents).toBe("6000");
    expect(dining.committedCents).toBe("26000");
    expect(dining.overspent).toBe(true);
    // Income never overspends; committed = max(planned, actual).
    const pay = patchCell(cell({ actualCents: "250000" }), "income", { month: "2026-10", categoryId: GROCERIES, plannedCents: "200000", source: "manual" });
    expect(pay.remainingCents).toBe("-50000");
    expect(pay.overspendCents).toBe("0");
    expect(pay.overspent).toBe(false);
    expect(pay.committedCents).toBe("250000");
    // Average-sourced edits keep their label; a cleared cell keeps its number but loses its explicit flag.
    expect(patchCell(oct, "spending", { month: "2026-10", categoryId: GROCERIES, plannedCents: "23500", source: "average" }).source).toBe("average");
    const cleared = patchCell(oct, "spending", { month: "2026-10", categoryId: GROCERIES, plannedCents: null, source: "manual" });
    expect(cleared.plannedCents).toBe("50000");
    expect(cleared.hasExplicitPlan).toBe(false);
    expect(cleared.source).toBe("none");
    // An edit without plannedCents (note only) leaves the numbers alone.
    expect(patchCell(oct, "spending", { month: "2026-10", categoryId: GROCERIES, note: "x", source: "manual" })).toBe(oct);
  });

  it("applyEdits patches only the addressed category cells", () => {
    const row = groceries();
    const bucket: PlanRow = { kind: "bucket", bucket: "spending", cells: [cell(), cell(), cell()] };
    const plan = { months, rows: [bucket, row] } as unknown as PlanResponse;
    const next = applyEdits(plan, [{ month: "2026-11", categoryId: GROCERIES, plannedCents: "23500", source: "average" }]);
    expect(next.rows[0]).toBe(bucket);
    const patched = next.rows[1] as PlanCategoryRow;
    expect(patched.cells[0]).toBe(row.cells[0]);
    expect(patched.cells[2]?.plannedCents).toBe("23500");
    expect(patched.cells[2]?.remainingCents).toBe("29000");
    expect(patched.cells[2]?.source).toBe("average");
    expect(applyEdits(plan, [{ month: "2026-11", categoryId: FUND, plannedCents: "1", source: "manual" }]).rows[1]).toBe(row);
  });
});

describe("drill-down URLs", () => {
  it("uses the month's first and last day and excludes transfers for categories", () => {
    expect(drillDownUrl(groceries(), "2026-10")).toBe(`/transactions?categoryId=${GROCERIES}&from=2026-10-01&to=2026-10-31&transfers=exclude`);
    expect(drillDownUrl(groceries(), "2028-02")).toBe(`/transactions?categoryId=${GROCERIES}&from=2028-02-01&to=2028-02-29&transfers=exclude`);
  });
  it("addresses goal rows by goal id", () => {
    const row = groceries();
    row.categoryId = FUND;
    row.goal = {
      id: GOAL,
      name: "Emergency Fund",
      targetCents: "1000000",
      targetDate: "2027-09-30",
      linkedAccountId: null,
      linkedAccountName: null,
      monthlyContributionCents: "50000",
      startMonth: "2026-09",
      startingCents: "200000",
      status: "active",
      progress: { savedCents: "280000", remainingToTargetCents: "720000", progressBp: 2800, monthsLeft: 12, neededPerMonthCents: "60000", projectedCompletionMonth: "2028-01", onTrack: false },
    };
    expect(drillDownUrl(row, "2026-10")).toBe(`/transactions?goalId=${GOAL}&from=2026-10-01&to=2026-10-31`);
    expect(uncategorizedUrl("2026-10")).toBe("/transactions?uncategorized=true&from=2026-10-01&to=2026-10-31");
  });
});

describe("row navigation", () => {
  const rows: PlanRow[] = [
    { kind: "bucket", bucket: "income", cells: [] },
    { ...groceries(), bucket: "income", name: "Paycheck" },
    { kind: "bucket", bucket: "spending", cells: [] },
    { kind: "group", bucket: "spending", groupId: GOAL, name: "Everyday", position: 1, hidden: false, cells: [] },
    groceries(),
    { ...groceries(), name: "Old Hobby", hidden: true },
    { kind: "group", bucket: "spending", groupId: FUND, name: "Secret", position: 2, hidden: true, cells: [] },
    { ...groceries(), name: "Gifts", groupId: FUND },
  ];
  it("filters hidden categories and hidden groups with their members", () => {
    expect(visibleRows(rows, false).map((r) => (r.kind === "bucket" ? r.bucket : r.name))).toEqual(["income", "Paycheck", "spending", "Everyday", "Groceries"]);
    expect(visibleRows(rows, true)).toHaveLength(rows.length);
  });
  it("finds the sticky bucket and the next category row", () => {
    expect(stickyBucketIndex(rows, 0)).toBe(0);
    expect(stickyBucketIndex(rows, 1)).toBe(0);
    expect(stickyBucketIndex(rows, 4)).toBe(2);
    expect(stickyBucketIndex(rows, 99)).toBe(2);
    expect(nextCategoryIndex(rows, 1, 1)).toBe(4);
    expect(nextCategoryIndex(rows, 4, -1)).toBe(1);
    expect(nextCategoryIndex(rows, 1, -1)).toBeNull();
    expect(nextCategoryIndex(rows, 7, 1)).toBeNull();
  });
  it("moves an id up or down and stops at the edges", () => {
    expect(moveId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveId(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveId(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
    expect(moveId(["a", "b", "c"], "zz", 1)).toEqual(["a", "b", "c"]);
  });
});
