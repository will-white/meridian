import { describe, expect, it } from "vitest";
import type { CategoryDetailView, GoalView, PlanCellView, TransactionView } from "@meridian/shared";
import {
  MAX_PLANNED_CENTS,
  beforePlanStart,
  cellEdits,
  drillDownQuery,
  drillDownUrl,
  fillRightEdits,
  parseAmountInput,
  resolveCellCommit,
  uncategorizedUrl,
  type PlanCategoryRow,
} from "./plan.js";
import { buildGoalBody, goalCategoryOptions, initialGoalForm } from "./planGoalForm.js";
import { alwaysRuleBody, canDragToRecategorize, recategorizePrompt } from "./recategorize.js";
import { msUntilNextLocalDay } from "./useLocalToday.js";

/**
 * Audit batch b7-plan-ui (spending plan, goals and dashboard in the web app): the pure
 * parts of findings 01, 04, 05, 07, 09 and 13. The rendered parts are in
 * components/plan/planAudit.test.tsx; the browser checks are recorded in the audit record.
 */

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

const DINING = "11111111-1111-4111-8111-111111111111";
const RENT = "22222222-2222-4222-8222-222222222222";
const MONTHS = ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"];

const row = (categoryId: string, name: string, bucket: PlanCategoryRow["bucket"], cells: PlanCellView[]): PlanCategoryRow => ({
  kind: "category",
  bucket,
  groupId: null,
  categoryId,
  name,
  position: 1,
  hidden: false,
  rolloverMode: "none",
  rolloverFromMonth: null,
  goal: null,
  cells,
});

describe("b7-plan-ui-01: fill right copies the amount just typed", () => {
  // Dining (seed moved one month later): Oct and Nov manual 20000, Dec automatic and empty.
  const dining = () =>
    row(DINING, "Dining", "spending", [
      cell(),
      cell({ plannedCents: "20000", source: "manual", hasExplicitPlan: true }),
      cell({ plannedCents: "20000", source: "manual", hasExplicitPlan: true }),
      cell(),
      cell(),
      cell(),
    ]);
  // Rent: every month planned automatically from its recurring item, 1800.00.
  const rent = () => row(RENT, "Rent", "bills", MONTHS.map(() => cell({ plannedCents: "180000", source: "recurring" })));

  it("typing 123 in an empty automatic cell and filling right sends 123.00 for Dec, Jan and Feb in one batch", () => {
    const r = dining();
    const commit = resolveCellCommit("123", r.cells[3]!);
    expect(commit).toEqual({ kind: "set", cents: 12300n });
    expect(cellEdits(r, MONTHS, 3, commit, { fillRight: true })).toEqual([
      { month: "2026-12", categoryId: DINING, plannedCents: "12300", source: "manual" },
      { month: "2027-01", categoryId: DINING, plannedCents: "12300", source: "manual" },
      { month: "2027-02", categoryId: DINING, plannedCents: "12300", source: "manual" },
    ]);
  });

  it("typing 1900 over Rent's automatic 1800 copies 1900, never the value from before the edit", () => {
    const r = rent();
    const commit = resolveCellCommit("1900", r.cells[2]!);
    const edits = cellEdits(r, MONTHS, 2, commit, { fillRight: true });
    expect(edits.map((e) => [e.month, e.plannedCents])).toEqual([
      ["2026-11", "190000"],
      ["2026-12", "190000"],
      ["2027-01", "190000"],
      ["2027-02", "190000"],
    ]);
    expect(edits.every((e) => e.source === "manual")).toBe(true);
  });

  it("without typing, fill right copies the displayed (resolved) value and leaves the cell itself alone", () => {
    const r = rent();
    const commit = resolveCellCommit(null, r.cells[4]!);
    expect(commit).toEqual({ kind: "keep", cents: 180000n });
    expect(cellEdits(r, MONTHS, 4, commit, { fillRight: true })).toEqual([{ month: "2027-02", categoryId: RENT, plannedCents: "180000", source: "manual" }]);
    // The same text as shown is not an edit either.
    expect(resolveCellCommit("1800.00", r.cells[4]!)).toEqual({ kind: "keep", cents: 180000n });
    expect(cellEdits(r, MONTHS, 4, commit, { fillRight: false })).toEqual([]);
    // The cell menu's Fill right reads the row once the plan is fresh: the displayed value.
    expect(fillRightEdits(r, MONTHS, 4)).toEqual([{ month: "2027-02", categoryId: RENT, plannedCents: "180000", source: "manual" }]);
    expect(fillRightEdits(r, MONTHS, 4, 5000n)).toEqual([{ month: "2027-02", categoryId: RENT, plannedCents: "5000", source: "manual" }]);
  });

  it("an emptied typed cell goes back to automatic and fills nothing (its automatic value is the server's)", () => {
    const r = dining();
    const commit = resolveCellCommit("", r.cells[2]!);
    expect(commit).toEqual({ kind: "clear" });
    expect(cellEdits(r, MONTHS, 2, commit, { fillRight: true })).toEqual([{ month: "2026-11", categoryId: DINING, plannedCents: null, source: "manual" }]);
    // Emptying an automatic cell changes nothing.
    expect(resolveCellCommit("", rent().cells[0]!)).toEqual({ kind: "keep", cents: 180000n });
    // Typing the typed value again is no edit; junk is an inline error and sends nothing.
    expect(resolveCellCommit("200", r.cells[1]!)).toEqual({ kind: "keep", cents: 20000n });
    const junk = resolveCellCommit("abc", r.cells[1]!);
    expect(junk).toEqual({ kind: "invalid", error: "Not an amount" });
    expect(cellEdits(r, MONTHS, 1, junk, { fillRight: true })).toEqual([]);
  });

  it("the last visible month has nothing to fill: the typed value alone is sent", () => {
    const r = dining();
    expect(cellEdits(r, MONTHS, 5, resolveCellCommit("75", r.cells[5]!), { fillRight: true })).toEqual([
      { month: "2027-02", categoryId: DINING, plannedCents: "7500", source: "manual" },
    ]);
  });
});

describe("b7-plan-ui-13: an amount the API cannot take is refused in the cell", () => {
  it("allows at most 13 whole-dollar digits (the 15-digit cents bound of the wire)", () => {
    expect(MAX_PLANNED_CENTS).toBe(999_999_999_999_999n);
    expect(parseAmountInput("9,999,999,999,999.99")).toEqual({ ok: true, cents: 999_999_999_999_999n });
    expect(parseAmountInput("99999999999999999999")).toEqual({ ok: false, error: "Too large" });
    expect(parseAmountInput("10000000000000")).toEqual({ ok: false, error: "Too large" });
    // Leading zeros are not digits of the amount.
    expect(parseAmountInput("00000000000000012.50")).toEqual({ ok: true, cents: 1250n });
    expect(resolveCellCommit("99999999999999999999", cell())).toEqual({ kind: "invalid", error: "Too large" });
  });

  it("the goal form says which field is too large instead of sending it", () => {
    const f = { ...initialGoalForm(null, "2026-11"), name: "Boat", categoryId: "x", target: "99999999999999999999" };
    expect(buildGoalBody(f, false)).toEqual({ ok: false, error: "Target: Too large" });
    expect(buildGoalBody({ ...f, target: "100", contribution: "10000000000000" }, false)).toEqual({ ok: false, error: "Monthly contribution: Too large" });
  });
});

describe("b7-plan-ui-05: months before the plan start are read-only", () => {
  it("compares months, with no start month meaning no limit", () => {
    expect(beforePlanStart("2026-10", "2026-11")).toBe(true);
    expect(beforePlanStart("2026-11", "2026-11")).toBe(false);
    expect(beforePlanStart("2027-01", "2026-11")).toBe(false);
  });
});

describe("b7-plan-ui-04: the drill-down panel and drag to recategorize", () => {
  const groceries = row(DINING, "Groceries", "spending", [cell()]);

  it("asks the register for exactly the rows behind the cell, the same query the register link uses", () => {
    expect(drillDownQuery({ kind: "category", row: groceries, month: "2026-11" })).toEqual({
      categoryId: DINING,
      from: "2026-11-01",
      to: "2026-11-30",
      transfers: "exclude",
      planScope: true,
    });
    const goalRow = { ...groceries, goal: { id: "33333333-3333-4333-8333-333333333333" } as PlanCategoryRow["goal"] };
    expect(drillDownQuery({ kind: "category", row: goalRow, month: "2026-11" })).toEqual({ goalId: "33333333-3333-4333-8333-333333333333", from: "2026-11-01", to: "2026-11-30", planScope: true });
    expect(drillDownQuery({ kind: "uncategorized", month: "2026-02" })).toEqual({ uncategorized: true, from: "2026-02-01", to: "2026-02-28", planScope: true });
    expect(drillDownUrl(groceries, "2026-11")).toBe("/transactions?categoryId=11111111-1111-4111-8111-111111111111&from=2026-11-01&to=2026-11-30&transfers=exclude&planScope=true");
    expect(uncategorizedUrl("2026-02")).toBe("/transactions?uncategorized=true&from=2026-02-01&to=2026-02-28&planScope=true");
  });

  const txn = (over: Partial<TransactionView>): Pick<TransactionView, "id" | "isTransfer" | "splits" | "payeeName" | "categoryId"> => ({
    id: "44444444-4444-4444-8444-444444444444",
    isTransfer: false,
    splits: [],
    payeeName: "AMAZON",
    categoryId: null,
    ...over,
  });

  it("drags categorized and uncategorized rows, never a transfer leg or a split row", () => {
    expect(canDragToRecategorize(txn({}))).toBe(true);
    expect(canDragToRecategorize(txn({ isTransfer: true }))).toBe(false);
    expect(canDragToRecategorize(txn({ splits: [{ id: "s", categoryId: DINING, categoryName: "Dining", amountCents: "-100", memo: null }] }))).toBe(false);
  });

  it("offers the register's 'always do this' rule after a move, for a transaction with a payee", () => {
    expect(recategorizePrompt(txn({ categoryId: RENT }), RENT)).toEqual({ transactionId: "44444444-4444-4444-8444-444444444444", payeeName: "AMAZON", categoryId: RENT });
    expect(recategorizePrompt(txn({ payeeName: null, categoryId: RENT }), RENT)).toBeNull();
    expect(alwaysRuleBody({ transactionId: "44444444-4444-4444-8444-444444444444", payeeName: "AMAZON", categoryId: RENT }, "Shopping")).toEqual({
      name: "AMAZON → Shopping",
      conditions: { payee: { op: "equals", value: "AMAZON" } },
      actions: { setCategoryId: RENT },
      applyTo: "uncategorized",
    });
  });
});

describe("b7-plan-ui-07: the dashboard follows the local date", () => {
  it("waits until just after the next local midnight", () => {
    expect(msUntilNextLocalDay(new Date(2026, 10, 13, 23, 58, 0, 0))).toBe(2 * 60_000 + 1000);
    expect(msUntilNextLocalDay(new Date(2026, 10, 30, 0, 0, 0, 0))).toBe(24 * 3600_000 + 1000);
  });
});

describe("b7-plan-ui-09: a goal keeps its own category in the form, hidden or not", () => {
  const cat = (id: string, over: Partial<CategoryDetailView> = {}): CategoryDetailView =>
    ({ id, name: id, bucket: "savings", hidden: false, goalId: null, groupId: null, position: 1, rolloverMode: "none", rolloverFromMonth: null, ...over }) as CategoryDetailView;
  const goals = [{ categoryId: "fund" }] as GoalView[];

  it("lists free visible savings categories, plus the edited goal's own category marked hidden", () => {
    const categories = [cat("fund", { name: "Emergency Fund", hidden: true, goalId: "g1" }), cat("vacation", { name: "Vacation" }), cat("old", { name: "Old", hidden: true }), cat("food", { bucket: "spending" })];
    expect(goalCategoryOptions(categories, goals, "fund")).toEqual([
      { id: "fund", label: "Emergency Fund (hidden)" },
      { id: "vacation", label: "Vacation" },
    ]);
    expect(goalCategoryOptions(categories, goals, null)).toEqual([{ id: "vacation", label: "Vacation" }]);
  });
});
