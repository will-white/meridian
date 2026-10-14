import { describe, expect, it } from "vitest";
import type { Bucket, RolloverMode } from "./enums.js";
import { addMonths, monthRange, type MonthKey } from "./months.js";
import {
  averageWindow,
  carryOut,
  committedCents,
  computePlan,
  goalProgress,
  paceCents,
  planAverage,
  type ActualInput,
  type AutoPlanInput,
  type ComputePlanInput,
  type GoalInput,
  type MonthPlanRowInput,
  type PlanCategoryInput,
  type PlanCategoryRowResult,
  type PlanCell,
  type PlanGroupInput,
  type PlanResult,
  type PlanRowResult,
} from "./plan.js";

// ---- builders ----

function group(id: string, name: string, bucket: Bucket, position: number, hidden = false): PlanGroupInput {
  return { id, name, bucket, position, hidden };
}

function category(
  id: string,
  name: string,
  bucket: Bucket,
  groupId: string | null,
  position: number,
  opts: Partial<Pick<PlanCategoryInput, "hidden" | "rolloverMode" | "rolloverFromMonth" | "goalId">> = {},
): PlanCategoryInput {
  return {
    id,
    name,
    bucket,
    groupId,
    position,
    hidden: opts.hidden ?? false,
    rolloverMode: opts.rolloverMode ?? "none",
    rolloverFromMonth: opts.rolloverFromMonth ?? null,
    goalId: opts.goalId ?? null,
  };
}

function row(
  categoryId: string,
  month: MonthKey,
  plannedCents: bigint | null,
  source: MonthPlanRowInput["plannedSource"] = "manual",
  extra: Partial<Pick<MonthPlanRowInput, "rolloverMode" | "carriedInOverrideCents" | "note">> = {},
): MonthPlanRowInput {
  return {
    categoryId,
    month,
    plannedCents,
    plannedSource: plannedCents === null ? null : source,
    rolloverMode: extra.rolloverMode ?? null,
    carriedInOverrideCents: extra.carriedInOverrideCents ?? null,
    note: extra.note ?? null,
  };
}

function actual(categoryId: string, month: MonthKey, signedCents: bigint, count: number, pendingSignedCents = 0n): ActualInput {
  return { categoryId, month, signedCents, pendingSignedCents, count };
}

function auto(categoryId: string, month: MonthKey, cents: bigint, source: "recurring" | "goal"): AutoPlanInput {
  return { categoryId, month, cents, source };
}

function autoMonthly(categoryId: string, from: MonthKey, to: MonthKey, cents: bigint, source: "recurring" | "goal"): AutoPlanInput[] {
  return monthRange(from, to).map((m) => auto(categoryId, m, cents, source));
}

function catRow(result: PlanResult, categoryId: string): PlanCategoryRowResult {
  const r = result.rows.find((x): x is PlanCategoryRowResult => x.kind === "category" && x.categoryId === categoryId);
  if (!r) throw new Error(`no row for ${categoryId}`);
  return r;
}

function cellOf(result: PlanResult, categoryId: string, month: MonthKey): PlanCell {
  const i = result.months.indexOf(month);
  const c = catRow(result, categoryId).cells[i];
  if (i < 0 || !c) throw new Error(`no cell ${categoryId} ${month}`);
  return c;
}

function rowCell(result: PlanResult, pick: (r: PlanRowResult) => boolean, month: MonthKey): PlanCell {
  const r = result.rows.find(pick);
  const c = r?.cells[result.months.indexOf(month)];
  if (!c) throw new Error(`no row cell for ${month}`);
  return c;
}

function summaryOf(result: PlanResult, month: MonthKey) {
  const s = result.summary[result.months.indexOf(month)];
  if (!s) throw new Error(`no summary for ${month}`);
  return s;
}

/** planned / carriedIn / actual / remaining / source, the grid design's shorthand. */
function brief(c: PlanCell): [bigint, bigint, bigint, bigint, string] {
  return [c.plannedCents, c.carriedInCents, c.actualCents, c.remainingCents, c.source];
}

function totals(c: PlanCell): [bigint, bigint, bigint, bigint] {
  return [c.plannedCents, c.carriedInCents, c.actualCents, c.remainingCents];
}

// =====================================================================
// Seed from docs/design/phase-2/grid-and-api.md (today 2026-10-13)
// =====================================================================

const S = {
  paycheck: "cat-paycheck",
  rent: "cat-rent",
  carInsurance: "cat-car-insurance",
  netflix: "cat-netflix",
  internet: "cat-internet",
  music: "cat-music",
  emergency: "cat-emergency-fund",
  groceries: "cat-groceries",
  dining: "cat-dining",
  fuel: "cat-fuel",
  oldHobby: "cat-old-hobby",
  shopping: "cat-shopping",
  goal: "goal-emergency-fund",
};

const SEED_MONTHS = ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"];

function seed(overrides: Partial<ComputePlanInput> = {}): ComputePlanInput {
  const goal: GoalInput = {
    id: S.goal,
    categoryId: S.emergency,
    name: "Emergency Fund",
    targetCents: 1000000n,
    targetDate: "2027-09-30",
    linkedAccountId: "acct-savings",
    linkedAccountName: "Savings",
    monthlyContributionCents: 50000n,
    startMonth: "2026-09",
    startingCents: 200000n,
    status: "active",
  };
  return {
    startMonth: "2026-08",
    from: "2026-08",
    to: "2027-01",
    today: "2026-10-13",
    zeroBased: false,
    groups: [
      group("grp-paychecks", "Paychecks", "income", 1),
      group("grp-housing", "Housing", "bills", 1),
      group("grp-subscriptions", "Subscriptions", "bills", 2),
      group("grp-everyday", "Everyday", "spending", 1),
    ],
    categories: [
      category(S.paycheck, "Paycheck", "income", "grp-paychecks", 1),
      category(S.rent, "Rent", "bills", "grp-housing", 1),
      category(S.carInsurance, "Car Insurance", "bills", "grp-housing", 2),
      category(S.netflix, "Netflix", "bills", "grp-subscriptions", 1),
      category(S.internet, "Internet", "bills", "grp-subscriptions", 2),
      category(S.music, "Music", "bills", "grp-subscriptions", 3),
      category(S.emergency, "Emergency Fund", "savings", null, 1, { goalId: S.goal }),
      category(S.groceries, "Groceries", "spending", "grp-everyday", 1, { rolloverMode: "all", rolloverFromMonth: "2026-09" }),
      category(S.dining, "Dining", "spending", "grp-everyday", 2, { rolloverMode: "surplus", rolloverFromMonth: "2026-09" }),
      category(S.fuel, "Fuel", "spending", "grp-everyday", 3),
      category(S.oldHobby, "Old Hobby", "spending", "grp-everyday", 4, { hidden: true }),
      category(S.shopping, "Shopping", "spending", null, 1),
    ],
    rows: [
      row(S.paycheck, "2026-09", 500000n),
      row(S.paycheck, "2026-10", 500000n),
      row(S.paycheck, "2026-11", 500000n),
      row(S.groceries, "2026-09", 50000n),
      row(S.groceries, "2026-10", 50000n),
      row(S.groceries, "2026-11", 50000n),
      row(S.dining, "2026-09", 20000n),
      row(S.dining, "2026-10", 20000n),
      row(S.fuel, "2026-10", 15000n),
    ],
    actuals: [
      actual(S.groceries, "2026-08", -7000n, 1),
      actual(S.paycheck, "2026-09", 500000n, 2),
      actual(S.rent, "2026-09", -180000n, 1),
      actual(S.netflix, "2026-09", -1549n, 1),
      actual(S.internet, "2026-09", -7999n, 1),
      actual(S.groceries, "2026-09", -40000n, 2),
      actual(S.dining, "2026-09", -26000n, 2),
      actual(S.fuel, "2026-09", -6000n, 1),
      actual(S.oldHobby, "2026-09", -2000n, 1),
      actual(S.paycheck, "2026-10", 250000n, 1),
      actual(S.rent, "2026-10", -180000n, 1),
      actual(S.netflix, "2026-10", -1649n, 1),
      actual(S.groceries, "2026-10", -54500n, 3), // −35000, −21000, +1500 refund
      actual(S.dining, "2026-10", -20000n, 2),
      actual(S.fuel, "2026-10", -5500n, 2, -2500n), // −3000 posted, −2500 pending
    ],
    goalNets: [
      { goalId: S.goal, month: "2026-09", signedCents: 50000n, count: 1 },
      { goalId: S.goal, month: "2026-10", signedCents: 30000n, count: 2 }, // +50000 in, −20000 withdrawal
    ],
    autoPlans: [
      ...autoMonthly(S.rent, "2026-09", "2027-08", 180000n, "recurring"),
      ...autoMonthly(S.netflix, "2026-09", "2027-08", 1549n, "recurring"),
      ...autoMonthly(S.internet, "2026-09", "2027-08", 7999n, "recurring"),
      auto(S.carInsurance, "2026-12", 45000n, "recurring"),
      auto(S.carInsurance, "2027-03", 45000n, "recurring"),
      ...autoMonthly(S.emergency, "2026-09", "2027-09", 50000n, "goal"),
    ],
    goals: [goal],
    uncategorized: [{ month: "2026-10", count: 1, signedCents: -4500n }],
    ...overrides,
  };
}

describe("computePlan on the grid-and-api seed", () => {
  const result = computePlan(seed());

  it("returns the range, the current month and display-ordered rows", () => {
    expect(result.today).toBe("2026-10-13");
    expect(result.currentMonth).toBe("2026-10");
    expect(result.months).toEqual(SEED_MONTHS);
    expect(result.zeroBased).toBe(false);
    expect(result.rows[0]).toMatchObject({ kind: "bucket", bucket: "income" });
    const order = result.rows.map((r) => (r.kind === "bucket" ? `bucket:${r.bucket}` : r.kind === "group" ? `group:${r.name}` : r.name));
    expect(order).toEqual([
      "bucket:income",
      "group:Paychecks",
      "Paycheck",
      "bucket:bills",
      "group:Housing",
      "Rent",
      "Car Insurance",
      "group:Subscriptions",
      "Netflix",
      "Internet",
      "Music",
      "bucket:savings",
      "Emergency Fund",
      "bucket:spending",
      "group:Everyday",
      "Groceries",
      "Dining",
      "Fuel",
      "Old Hobby",
      "Shopping",
    ]);
    expect(catRow(result, S.oldHobby).hidden).toBe(true);
    expect(catRow(result, S.shopping)).toMatchObject({ groupId: null, position: 1, hidden: false });
    expect(catRow(result, S.groceries)).toMatchObject({ rolloverMode: "all", rolloverFromMonth: "2026-09", goal: null });
    for (const r of result.rows) expect(r.cells).toHaveLength(6);
    expect(result.summary.map((s) => s.month)).toEqual(SEED_MONTHS);
  });

  it("folds the Groceries chain ('all' from 2026-09) through row-less months", () => {
    const g = (m: MonthKey) => cellOf(result, S.groceries, m);
    expect(brief(g("2026-08"))).toEqual([0n, 0n, 7000n, -7000n, "none"]);
    expect(g("2026-08")).toMatchObject({ overspent: true, overspendCents: 7000n, carriedInSource: "none", rolloverMode: "none", committedCents: 7000n });
    expect(brief(g("2026-09"))).toEqual([50000n, 0n, 40000n, 10000n, "manual"]);
    expect(g("2026-09")).toMatchObject({ carriedInSource: "start", hasExplicitPlan: true, rolloverMode: "all", committedCents: 50000n, overspent: false });
    expect(brief(g("2026-10"))).toEqual([50000n, 10000n, 54500n, 5500n, "manual"]);
    expect(g("2026-10")).toMatchObject({ txnCount: 3, carriedInSource: "chain", availableCents: 60000n, committedCents: 50000n });
    expect(brief(g("2026-11"))).toEqual([50000n, 5500n, 0n, 55500n, "manual"]);
    expect(g("2026-11").committedCents).toBe(50000n);
    expect(brief(g("2026-12"))).toEqual([0n, 55500n, 0n, 55500n, "none"]);
    expect(g("2026-12")).toMatchObject({ hasExplicitPlan: false, committedCents: 0n });
    expect(brief(g("2027-01"))).toEqual([0n, 55500n, 0n, 55500n, "none"]);
    expect(catRow(result, S.groceries).cells.map((c) => c.carriedInCents)).toEqual([0n, 0n, 10000n, 5500n, 55500n, 55500n]);
  });

  it("drops a surplus-only overspend (Dining), reports pending (Fuel) and keeps hidden rows (Old Hobby)", () => {
    expect(brief(cellOf(result, S.dining, "2026-09"))).toEqual([20000n, 0n, 26000n, -6000n, "manual"]);
    expect(cellOf(result, S.dining, "2026-09")).toMatchObject({ overspent: true, overspendCents: 6000n, committedCents: 26000n, rolloverMode: "surplus" });
    expect(brief(cellOf(result, S.dining, "2026-10"))).toEqual([20000n, 0n, 20000n, 0n, "manual"]);
    expect(cellOf(result, S.dining, "2026-10").committedCents).toBe(20000n);
    expect(brief(cellOf(result, S.dining, "2026-11"))).toEqual([0n, 0n, 0n, 0n, "none"]);

    expect(brief(cellOf(result, S.fuel, "2026-09"))).toEqual([0n, 0n, 6000n, -6000n, "none"]);
    expect(cellOf(result, S.fuel, "2026-09")).toMatchObject({ overspent: true, committedCents: 6000n });
    expect(brief(cellOf(result, S.fuel, "2026-10"))).toEqual([15000n, 0n, 5500n, 9500n, "manual"]);
    expect(cellOf(result, S.fuel, "2026-10")).toMatchObject({ pendingCents: 2500n, txnCount: 2, committedCents: 15000n });

    expect(cellOf(result, S.rent, "2026-10").actualCents).toBe(180000n);
    expect(cellOf(result, S.oldHobby, "2026-09")).toMatchObject({ actualCents: 2000n, remainingCents: -2000n, committedCents: 2000n });
  });

  it("auto-fills bills from recurring occurrences and savings from the goal", () => {
    expect(brief(cellOf(result, S.rent, "2026-08"))).toEqual([0n, 0n, 0n, 0n, "none"]);
    for (const m of ["2026-09", "2026-10"]) expect(brief(cellOf(result, S.rent, m))).toEqual([180000n, 0n, 180000n, 0n, "recurring"]);
    for (const m of ["2026-11", "2026-12", "2027-01"]) {
      expect(brief(cellOf(result, S.rent, m))).toEqual([180000n, 0n, 0n, 180000n, "recurring"]);
      expect(cellOf(result, S.rent, m)).toMatchObject({ hasExplicitPlan: false, committedCents: 180000n });
    }
    expect(brief(cellOf(result, S.netflix, "2026-10"))).toEqual([1549n, 0n, 1649n, -100n, "recurring"]);
    expect(cellOf(result, S.netflix, "2026-10")).toMatchObject({ overspent: true, overspendCents: 100n, committedCents: 1649n });
    expect(brief(cellOf(result, S.internet, "2026-10"))).toEqual([7999n, 0n, 0n, 7999n, "recurring"]);
    expect(brief(cellOf(result, S.carInsurance, "2026-12"))).toEqual([45000n, 0n, 0n, 45000n, "recurring"]);
    for (const m of SEED_MONTHS.filter((m) => m !== "2026-12")) expect(brief(cellOf(result, S.carInsurance, m))).toEqual([0n, 0n, 0n, 0n, "none"]);
    for (const m of SEED_MONTHS) expect(brief(cellOf(result, S.music, m))).toEqual([0n, 0n, 0n, 0n, "none"]);

    expect(brief(cellOf(result, S.emergency, "2026-08"))).toEqual([0n, 0n, 0n, 0n, "none"]);
    expect(brief(cellOf(result, S.emergency, "2026-09"))).toEqual([50000n, 0n, 50000n, 0n, "goal"]);
    expect(brief(cellOf(result, S.emergency, "2026-10"))).toEqual([50000n, 0n, 30000n, 20000n, "goal"]);
    expect(cellOf(result, S.emergency, "2026-10")).toMatchObject({ txnCount: 2, committedCents: 50000n });
    for (const m of ["2026-11", "2026-12", "2027-01"]) expect(brief(cellOf(result, S.emergency, m))).toEqual([50000n, 0n, 0n, 50000n, "goal"]);

    expect(brief(cellOf(result, S.paycheck, "2026-09"))).toEqual([500000n, 0n, 500000n, 0n, "manual"]);
    expect(brief(cellOf(result, S.paycheck, "2026-10"))).toEqual([500000n, 0n, 250000n, 250000n, "manual"]);
    expect(cellOf(result, S.paycheck, "2026-10")).toMatchObject({ committedCents: 500000n, overspent: false, rolloverMode: "none" });
    expect(brief(cellOf(result, S.paycheck, "2026-11"))).toEqual([500000n, 0n, 0n, 500000n, "manual"]);
    for (const m of ["2026-12", "2027-01"]) expect(brief(cellOf(result, S.paycheck, m))).toEqual([0n, 0n, 0n, 0n, "none"]);
  });

  it("decorates the Emergency Fund row with its goal summary", () => {
    const goal = catRow(result, S.emergency).goal;
    expect(goal).toMatchObject({
      id: S.goal,
      name: "Emergency Fund",
      targetCents: 1000000n,
      targetDate: "2027-09-30",
      linkedAccountId: "acct-savings",
      linkedAccountName: "Savings",
      monthlyContributionCents: 50000n,
      startMonth: "2026-09",
      startingCents: 200000n,
      status: "active",
    });
    expect(goal?.progress).toEqual({
      savedCents: 280000n,
      remainingToTargetCents: 720000n,
      monthsLeft: 12,
      neededPerMonthCents: 60000n,
      projectedCompletionMonth: "2028-01",
      onTrack: false,
      progressBp: 2800,
    });
  });

  it("sums group and bucket subtotal rows (hidden members included)", () => {
    const spending = (m: MonthKey) => totals(rowCell(result, (r) => r.kind === "bucket" && r.bucket === "spending", m));
    expect(spending("2026-08")).toEqual([0n, 0n, 7000n, -7000n]);
    expect(spending("2026-09")).toEqual([70000n, 0n, 74000n, -4000n]);
    expect(spending("2026-10")).toEqual([85000n, 10000n, 80000n, 15000n]);
    expect(spending("2026-11")).toEqual([50000n, 5500n, 0n, 55500n]);
    expect(spending("2026-12")).toEqual([0n, 55500n, 0n, 55500n]);
    expect(spending("2027-01")).toEqual([0n, 55500n, 0n, 55500n]);
    const everydayOct = rowCell(result, (r) => r.kind === "group" && r.name === "Everyday", "2026-10");
    expect(totals(everydayOct)).toEqual([85000n, 10000n, 80000n, 15000n]);
    expect(everydayOct).toMatchObject({ pendingCents: 2500n, txnCount: 7, source: "none", carriedInSource: "none", hasExplicitPlan: false, note: null });
    expect(totals(rowCell(result, (r) => r.kind === "group" && r.name === "Subscriptions", "2026-10"))).toEqual([9548n, 0n, 1649n, 7899n]);
    expect(totals(rowCell(result, (r) => r.kind === "group" && r.name === "Housing", "2026-10"))).toEqual([180000n, 0n, 180000n, 0n]);
    const bills = (m: MonthKey) => totals(rowCell(result, (r) => r.kind === "bucket" && r.bucket === "bills", m));
    expect(bills("2026-09")).toEqual([189548n, 0n, 189548n, 0n]);
    expect(bills("2026-10")).toEqual([189548n, 0n, 181649n, 7899n]);
    expect(bills("2026-11")).toEqual([189548n, 0n, 0n, 189548n]);
    expect(bills("2026-12")).toEqual([234548n, 0n, 0n, 234548n]);
    expect(bills("2027-01")[0]).toBe(189548n);
    const spendingSep = rowCell(result, (r) => r.kind === "bucket" && r.bucket === "spending", "2026-09");
    expect(spendingSep).toMatchObject({ committedCents: 84000n, overspendCents: 14000n, overspent: true });
    expect(result.rows.find((r) => r.kind === "group" && r.name === "Everyday")).toMatchObject({ bucket: "spending", groupId: "grp-everyday", position: 1, hidden: false });
  });

  it("builds the summary strip: committed, left to spend, to assign, pace and uncategorized", () => {
    const s = (m: MonthKey) => summaryOf(result, m);
    const c = (m: MonthKey) => Object.values(s(m).committed);
    expect(c("2026-08")).toEqual([0n, 0n, 0n, 7000n]);
    expect(c("2026-09")).toEqual([500000n, 189548n, 50000n, 84000n]);
    expect(c("2026-10")).toEqual([500000n, 189648n, 50000n, 85000n]);
    expect(c("2026-11")).toEqual([500000n, 189548n, 50000n, 50000n]);
    expect(c("2026-12")).toEqual([0n, 234548n, 50000n, 0n]);
    expect(c("2027-01")).toEqual([0n, 189548n, 50000n, 0n]);

    expect(s("2026-10").planned).toEqual({ income: 500000n, bills: 189548n, savings: 50000n, spending: 85000n });
    expect(s("2026-10").actual).toEqual({ income: 250000n, bills: 181649n, savings: 30000n, spending: 80000n });
    expect(s("2026-09").actual).toEqual({ income: 500000n, bills: 189548n, savings: 50000n, spending: 74000n });

    expect(result.summary.map((x) => x.leftToSpendCents)).toEqual([-7000n, 176452n, 175352n, 210452n, -284548n, -239548n]);
    expect(result.summary.map((x) => x.toAssignCents)).toEqual([0n, 190452n, 175452n, 210452n, -284548n, -239548n]);
    expect(result.summary.map((x) => x.plannedLeftToSpendCents)).toEqual([0n, 190452n, 175452n, 210452n, -284548n, -239548n]);
    expect(result.summary.map((x) => x.warning)).toEqual([true, false, false, false, true, true]);
    expect(result.summary.map((x) => x.state)).toEqual(["past", "past", "current", "future", "future", "future"]);
    expect(result.summary.map((x) => x.pace)).toEqual([null, null, { daysLeft: 19, perDayCents: 9229n, overCents: 0n }, null, null, null]);
    expect(result.summary.map((x) => x.uncategorized)).toEqual([
      { count: 0, cents: 0n },
      { count: 0, cents: 0n },
      { count: 1, cents: -4500n },
      { count: 0, cents: 0n },
      { count: 0, cents: 0n },
      { count: 0, cents: 0n },
    ]);
  });

  it("keeps hidden rows in totals: removing Old Hobby's actual moves Sep committed and left to spend", () => {
    const without = computePlan(seed({ actuals: seed().actuals.filter((a) => a.categoryId !== S.oldHobby) }));
    expect(summaryOf(result, "2026-09").committed.spending).toBe(84000n);
    expect(summaryOf(without, "2026-09").committed.spending).toBe(82000n);
    expect(summaryOf(without, "2026-09").leftToSpendCents).toBe(178452n);
  });

  it("counts a goal's net linked transfers: without the withdrawal Oct actual is 50000", () => {
    const nets = seed().goalNets.map((g) => (g.month === "2026-10" ? { ...g, signedCents: 50000n, count: 1 } : g));
    const r = computePlan(seed({ goalNets: nets }));
    expect(cellOf(r, S.emergency, "2026-10")).toMatchObject({ actualCents: 50000n, remainingCents: 0n, txnCount: 1 });
    expect(catRow(r, S.emergency).goal?.progress.savedCents).toBe(300000n);
  });

  it("gives the same numbers when the household start month is 2026-09 (chains start at the later of the two)", () => {
    // Only the carried-in provenance moves ('start' → 'none' in Aug for categories whose chain starts at startMonth).
    const money = (r: PlanResult) => ({
      summary: r.summary,
      rows: r.rows.map((x) => ({ ...x, cells: x.cells.map(({ carriedInSource: _, ...cell }) => cell) })),
    });
    expect(money(computePlan(seed({ startMonth: "2026-09" })))).toEqual(money(result));
  });

  it("warns on the displayed number: to assign when zero-based", () => {
    const zb = computePlan(seed({ zeroBased: true }));
    expect(zb.zeroBased).toBe(true);
    expect(zb.summary.map((x) => x.warning)).toEqual([false, false, false, false, true, true]);
    expect(zb.summary.map((x) => x.leftToSpendCents)).toEqual(result.summary.map((x) => x.leftToSpendCents));
  });

  it("is pure and deterministic", () => {
    expect(computePlan(seed())).toEqual(result);
    const shuffled = seed();
    shuffled.categories.reverse();
    shuffled.groups.reverse();
    shuffled.actuals.reverse();
    shuffled.rows.reverse();
    expect(computePlan(shuffled)).toEqual(result);
  });

  it("rejects an inverted range", () => {
    expect(() => computePlan(seed({ from: "2026-11", to: "2026-10" }))).toThrow(/range/);
  });

  it("computes months before the plan start as 'none' and the goal summary independently of the visible range", () => {
    const r = computePlan(seed({ from: "2026-06", to: "2026-08" }));
    expect(r.months).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(cellOf(r, S.groceries, "2026-08")).toMatchObject({ actualCents: 7000n, carriedInSource: "none", rolloverMode: "none" });
    expect(r.summary.map((x) => x.pace)).toEqual([null, null, null]);
    expect(r.summary.map((x) => x.state)).toEqual(["past", "past", "past"]);
    expect(catRow(r, S.emergency).goal?.progress.savedCents).toBe(280000n);
  });
});

// =====================================================================
// Fixture F from docs/design/phase-2/plan-math.md, under the plan's
// reconciled rules: no synthetic Other rows, uncategorized rows do not move
// the numbers, bucket_override is not read (the Oct −5000 Groceries row with
// an override is therefore not part of the engine's input), committed =
// max(planned + carriedIn, actual) − max(carriedIn, 0).
// =====================================================================

const F = {
  paycheck: "f-paycheck",
  rent: "f-rent",
  electric: "f-electric",
  water: "f-water",
  vacation: "f-vacation",
  groceries: "f-groceries",
  dining: "f-dining",
  fuel: "f-fuel",
  pets: "f-pets",
  travel: "f-travel",
  goal: "f-goal-vacation",
};

function fixtureF(overrides: Partial<ComputePlanInput> = {}): ComputePlanInput {
  const goal: GoalInput = {
    id: F.goal,
    categoryId: F.vacation,
    name: "Vacation",
    targetCents: 600000n,
    targetDate: "2027-05-31",
    linkedAccountId: "acct-sav",
    linkedAccountName: "SAV",
    monthlyContributionCents: 30000n,
    startMonth: "2026-08",
    startingCents: 100000n,
    status: "active",
  };
  return {
    startMonth: "2026-08",
    from: "2026-08",
    to: "2026-11",
    today: "2026-10-13",
    zeroBased: false,
    groups: [
      group("fg-income", "Income", "income", 0),
      group("fg-bills", "Bills & Subscriptions", "bills", 0),
      group("fg-savings", "Savings Goals", "savings", 0),
      group("fg-spending", "Spending", "spending", 0),
    ],
    categories: [
      category(F.paycheck, "Paycheck", "income", "fg-income", 1),
      category(F.rent, "Rent", "bills", "fg-bills", 1),
      category(F.electric, "Electric", "bills", "fg-bills", 2),
      category(F.water, "Water", "bills", "fg-bills", 3),
      category(F.vacation, "Vacation", "savings", "fg-savings", 1, { goalId: F.goal }),
      category(F.groceries, "Groceries", "spending", "fg-spending", 1, { rolloverMode: "surplus" }),
      category(F.dining, "Dining", "spending", "fg-spending", 2, { rolloverMode: "all" }),
      category(F.fuel, "Fuel", "spending", "fg-spending", 3),
      category(F.pets, "Pets", "spending", "fg-spending", 4),
      category(F.travel, "Travel", "spending", "fg-spending", 5),
    ],
    rows: ["2026-08", "2026-09", "2026-10"].flatMap((m) => [
      row(F.paycheck, m, 500000n),
      row(F.groceries, m, 40000n),
      row(F.dining, m, 20000n),
      row(F.fuel, m, 15000n),
    ]),
    actuals: [
      actual(F.paycheck, "2026-08", 500000n, 2),
      actual(F.rent, "2026-08", -150000n, 1),
      actual(F.electric, "2026-08", -11000n, 1),
      actual(F.water, "2026-08", -9000n, 1),
      actual(F.groceries, "2026-08", -30000n, 1),
      actual(F.dining, "2026-08", -20000n, 1),
      actual(F.fuel, "2026-08", -9000n, 1),
      actual(F.pets, "2026-08", -7000n, 1),
      actual(F.paycheck, "2026-09", 490000n, 3), // +250000, +250000, −10000 reversal
      actual(F.rent, "2026-09", -150000n, 1),
      actual(F.electric, "2026-09", -13500n, 1),
      actual(F.groceries, "2026-09", -31845n, 3), // −12345, −20000, +500 refund
      actual(F.dining, "2026-09", -25000n, 1),
      actual(F.fuel, "2026-09", -9000n, 1),
      actual(F.paycheck, "2026-10", 250000n, 1),
      actual(F.rent, "2026-10", -150000n, 1),
      actual(F.groceries, "2026-10", -50000n, 2),
      actual(F.dining, "2026-10", -10000n, 1),
      actual(F.fuel, "2026-10", -4000n, 1),
    ],
    goalNets: ["2026-08", "2026-09", "2026-10"].map((month) => ({ goalId: F.goal, month, signedCents: 30000n, count: 1 })),
    autoPlans: [
      ...autoMonthly(F.paycheck, "2026-08", "2027-01", 500000n, "recurring"),
      ...autoMonthly(F.rent, "2026-08", "2027-06", 150000n, "recurring"),
      ...autoMonthly(F.electric, "2026-08", "2027-06", 12000n, "recurring"),
      auto(F.water, "2026-08", 9000n, "recurring"),
      auto(F.water, "2026-11", 9000n, "recurring"),
      auto(F.water, "2027-02", 9000n, "recurring"),
      ...autoMonthly(F.vacation, "2026-08", "2027-05", 30000n, "goal"),
    ],
    goals: [goal],
    uncategorized: [{ month: "2026-09", count: 1, signedCents: -2500n }],
    ...overrides,
  };
}

describe("computePlan on plan-math Fixture F", () => {
  const result = computePlan(fixtureF());

  it("F0/T1: August cells and summary; refunds and reversals lower actual", () => {
    const aug = (id: string) => cellOf(result, id, "2026-08");
    const line = (c: PlanCell) => [c.plannedCents, c.source, c.carriedInCents, c.actualCents, c.remainingCents, c.committedCents];
    expect(line(aug(F.paycheck))).toEqual([500000n, "manual", 0n, 500000n, 0n, 500000n]);
    expect(line(aug(F.rent))).toEqual([150000n, "recurring", 0n, 150000n, 0n, 150000n]);
    expect(line(aug(F.electric))).toEqual([12000n, "recurring", 0n, 11000n, 1000n, 12000n]);
    expect(line(aug(F.water))).toEqual([9000n, "recurring", 0n, 9000n, 0n, 9000n]);
    expect(line(aug(F.vacation))).toEqual([30000n, "goal", 0n, 30000n, 0n, 30000n]);
    expect(line(aug(F.groceries))).toEqual([40000n, "manual", 0n, 30000n, 10000n, 40000n]);
    expect(line(aug(F.dining))).toEqual([20000n, "manual", 0n, 20000n, 0n, 20000n]);
    expect(line(aug(F.fuel))).toEqual([15000n, "manual", 0n, 9000n, 6000n, 15000n]);
    expect(line(aug(F.pets))).toEqual([0n, "none", 0n, 7000n, -7000n, 7000n]);
    expect(aug(F.pets).overspendCents).toBe(7000n);
    expect(line(aug(F.travel))).toEqual([0n, "none", 0n, 0n, 0n, 0n]);
    const s = summaryOf(result, "2026-08");
    expect(s.planned).toEqual({ income: 500000n, bills: 171000n, savings: 30000n, spending: 75000n });
    expect(s.plannedLeftToSpendCents).toBe(224000n);
    expect(s.committed).toEqual({ income: 500000n, bills: 171000n, savings: 30000n, spending: 82000n });
    expect(s.leftToSpendCents).toBe(217000n);
    expect(s.toAssignCents).toBe(224000n);

    const sep = cellOf(result, F.groceries, "2026-09");
    expect(sep).toMatchObject({ actualCents: 31845n, txnCount: 3 });
    const pay = cellOf(result, F.paycheck, "2026-09");
    expect(pay).toMatchObject({ actualCents: 490000n, remainingCents: 10000n, overspendCents: 0n, committedCents: 500000n });
  });

  it("T2: surplus-only carry chains across three months and through a row-less month", () => {
    const g = (m: MonthKey) => cellOf(result, F.groceries, m);
    expect(g("2026-08")).toMatchObject({ availableCents: 40000n, actualCents: 30000n, remainingCents: 10000n, carriedInSource: "start" });
    expect(g("2026-09")).toMatchObject({ carriedInCents: 10000n, carriedInSource: "chain", availableCents: 50000n, actualCents: 31845n, remainingCents: 18155n, committedCents: 40000n });
    expect(g("2026-10")).toMatchObject({ carriedInCents: 18155n, availableCents: 58155n, actualCents: 50000n, remainingCents: 8155n, committedCents: 40000n });
    expect(g("2026-11")).toMatchObject({ carriedInCents: 8155n, plannedCents: 0n, source: "none", hasExplicitPlan: false, availableCents: 8155n, actualCents: 0n, remainingCents: 8155n, committedCents: 0n });
  });

  it("T3: an 'all' overspend goes negative, is charged once, and relieves the next month's commitment", () => {
    const d = (m: MonthKey) => cellOf(result, F.dining, m);
    expect(d("2026-09")).toMatchObject({ availableCents: 20000n, actualCents: 25000n, remainingCents: -5000n, overspendCents: 5000n, committedCents: 25000n });
    expect(d("2026-10")).toMatchObject({ carriedInCents: -5000n, carriedInSource: "chain", availableCents: 15000n, actualCents: 10000n, remainingCents: 5000n, overspendCents: 0n, committedCents: 15000n });
    expect(d("2026-11")).toMatchObject({ carriedInCents: 5000n, availableCents: 5000n, committedCents: 0n });
    expect(d("2026-09").committedCents + d("2026-10").committedCents).toBe(40000n);
  });

  it("T4: rollover 'none' drops the surplus", () => {
    expect(cellOf(result, F.fuel, "2026-08").remainingCents).toBe(6000n);
    expect(cellOf(result, F.fuel, "2026-09")).toMatchObject({ carriedInCents: 0n, remainingCents: 6000n });
    expect(cellOf(result, F.fuel, "2026-10")).toMatchObject({ carriedInCents: 0n, availableCents: 15000n, actualCents: 4000n, remainingCents: 11000n, committedCents: 15000n });
  });

  it("T5: a month with no plan row commits unplanned spending in full and forgives it", () => {
    expect(cellOf(result, F.pets, "2026-08")).toEqual({
      plannedCents: 0n,
      source: "none",
      hasExplicitPlan: false,
      carriedInCents: 0n,
      carriedInSource: "start",
      availableCents: 0n,
      actualCents: 7000n,
      pendingCents: 0n,
      remainingCents: -7000n,
      overspendCents: 7000n,
      committedCents: 7000n,
      rolloverMode: "none",
      txnCount: 1,
      overspent: true,
      note: null,
    });
    expect(cellOf(result, F.pets, "2026-09").carriedInCents).toBe(0n);
  });

  it("T6: surplus-only with an overrun beyond the envelope forgives the overrun", () => {
    const r = computePlan(fixtureF({ actuals: [...fixtureF().actuals, actual(F.groceries, "2026-10", -9000n, 1)] }));
    expect(cellOf(r, F.groceries, "2026-10")).toMatchObject({ availableCents: 58155n, actualCents: 59000n, remainingCents: -845n, overspendCents: 845n, committedCents: 40845n });
    expect(cellOf(r, F.groceries, "2026-11")).toMatchObject({ carriedInCents: 0n, availableCents: 0n });
    expect(summaryOf(result, "2026-10").leftToSpendCents).toBe(238000n);
    expect(summaryOf(r, "2026-10").leftToSpendCents).toBe(238000n - 845n);
  });

  it("T7: a carried-in override replaces the chain value and feeds forward", () => {
    const r = computePlan(fixtureF({ rows: fixtureF().rows.map((x) => (x.categoryId === F.dining && x.month === "2026-10" ? { ...x, carriedInOverrideCents: 0n } : x)) }));
    expect(cellOf(r, F.dining, "2026-10")).toMatchObject({ carriedInCents: 0n, carriedInSource: "override", availableCents: 20000n, actualCents: 10000n, remainingCents: 10000n, committedCents: 20000n });
    expect(cellOf(r, F.dining, "2026-11")).toMatchObject({ carriedInCents: 10000n, carriedInSource: "chain" });
    expect(summaryOf(r, "2026-10").leftToSpendCents).toBe(500000n - 162000n - 30000n - (40000n + 20000n + 15000n));
    expect(cellOf(result, F.dining, "2026-10")).toMatchObject({ carriedInCents: -5000n, remainingCents: 5000n, committedCents: 15000n });
  });

  it("T8: a start-month override seeds an envelope; the carried surplus is never charged", () => {
    const r = computePlan(fixtureF({ rows: fixtureF().rows.map((x) => (x.categoryId === F.groceries && x.month === "2026-08" ? { ...x, carriedInOverrideCents: 25000n } : x)) }));
    expect(cellOf(r, F.groceries, "2026-08")).toMatchObject({ carriedInCents: 25000n, carriedInSource: "override", availableCents: 65000n, actualCents: 30000n, remainingCents: 35000n, committedCents: 40000n });
    expect(cellOf(r, F.groceries, "2026-09")).toMatchObject({ carriedInCents: 35000n, availableCents: 75000n, remainingCents: 43155n });
    expect(cellOf(r, F.groceries, "2026-10")).toMatchObject({ carriedInCents: 43155n, availableCents: 83155n, remainingCents: 33155n });
    expect(["2026-08", "2026-09", "2026-10"].map((m) => summaryOf(r, m).leftToSpendCents)).toEqual([217000n, 226500n, 238000n]);
    expect(["2026-08", "2026-09", "2026-10"].map((m) => summaryOf(result, m).leftToSpendCents)).toEqual([217000n, 226500n, 238000n]);
  });

  it("T9: quarterly bills land in their months; a manual row overrides the auto value; goal contributions stop after the target month", () => {
    const r = computePlan(fixtureF({ to: "2027-06" }));
    const water = (m: MonthKey) => [cellOf(r, F.water, m).plannedCents, cellOf(r, F.water, m).source];
    expect(water("2026-08")).toEqual([9000n, "recurring"]);
    expect(water("2026-09")).toEqual([0n, "none"]);
    expect(water("2026-10")).toEqual([0n, "none"]);
    expect(water("2026-11")).toEqual([9000n, "recurring"]);
    expect(water("2026-12")).toEqual([0n, "none"]);
    expect(water("2027-01")).toEqual([0n, "none"]);
    expect(water("2027-02")).toEqual([9000n, "recurring"]);
    expect(summaryOf(r, "2026-10").planned.bills).toBe(162000n);
    expect(summaryOf(r, "2026-11").planned.bills).toBe(171000n);

    const overridden = computePlan(fixtureF({ to: "2027-06", rows: [...fixtureF().rows, row(F.rent, "2026-11", 152000n)] }));
    expect(cellOf(overridden, F.rent, "2026-11")).toMatchObject({ plannedCents: 152000n, source: "manual", hasExplicitPlan: true });
    expect(summaryOf(overridden, "2026-11").planned.bills).toBe(173000n);
    expect(cellOf(r, F.rent, "2026-11")).toMatchObject({ plannedCents: 150000n, source: "recurring", hasExplicitPlan: false });

    const zeroed = computePlan(fixtureF({ rows: [...fixtureF().rows, row(F.rent, "2026-11", 0n)] }));
    expect(cellOf(zeroed, F.rent, "2026-11")).toMatchObject({ plannedCents: 0n, source: "manual", hasExplicitPlan: true });

    expect([cellOf(r, F.vacation, "2027-05").plannedCents, cellOf(r, F.vacation, "2027-05").source]).toEqual([30000n, "goal"]);
    expect([cellOf(r, F.vacation, "2027-06").plannedCents, cellOf(r, F.vacation, "2027-06").source]).toEqual([0n, "none"]);

    const frozen = computePlan(fixtureF({ rows: [...fixtureF().rows, row(F.rent, "2026-11", 150000n, "recurring")] }));
    expect(cellOf(frozen, F.rent, "2026-11")).toMatchObject({ plannedCents: 150000n, source: "recurring", hasExplicitPlan: true });
  });

  it("T10/T11 (reconciled): completed and current month summaries; uncategorized rows do not move the numbers", () => {
    const sep = summaryOf(result, "2026-09");
    expect(sep.planned).toEqual({ income: 500000n, bills: 162000n, savings: 30000n, spending: 75000n });
    expect(sep.plannedLeftToSpendCents).toBe(233000n);
    expect(sep.committed).toEqual({ income: 500000n, bills: 163500n, savings: 30000n, spending: 80000n });
    expect(sep.leftToSpendCents).toBe(226500n);
    expect(sep.toAssignCents).toBe(233000n);
    expect(sep.uncategorized).toEqual({ count: 1, cents: -2500n });
    expect(sep.state).toBe("past");
    expect(sep.pace).toBeNull();

    const oct = summaryOf(result, "2026-10");
    expect(oct.committed).toEqual({ income: 500000n, bills: 162000n, savings: 30000n, spending: 70000n });
    expect(oct.leftToSpendCents).toBe(238000n);
    expect(oct.state).toBe("current");
    expect(oct.pace).toEqual({ daysLeft: 19, perDayCents: 12526n, overCents: 0n });
  });

  it("T14: a future month with no activity has coinciding numbers and carried-in without rows", () => {
    const r = result;
    expect(cellOf(r, F.paycheck, "2026-11")).toMatchObject({ plannedCents: 500000n, source: "recurring", committedCents: 500000n });
    expect(summaryOf(r, "2026-11").planned).toEqual({ income: 500000n, bills: 171000n, savings: 30000n, spending: 0n });
    expect(cellOf(r, F.vacation, "2026-11")).toMatchObject({ plannedCents: 30000n, source: "goal" });
    expect(summaryOf(r, "2026-11").plannedLeftToSpendCents).toBe(299000n);
    expect(summaryOf(r, "2026-11").leftToSpendCents).toBe(299000n);
    expect(summaryOf(r, "2026-11").committed).toEqual({ income: 500000n, bills: 171000n, savings: 30000n, spending: 0n });
    expect(cellOf(r, F.groceries, "2026-11")).toMatchObject({ carriedInCents: 8155n, availableCents: 8155n });
    expect(cellOf(r, F.dining, "2026-11").carriedInCents).toBe(5000n);
    expect(summaryOf(r, "2026-11").state).toBe("future");
    expect(summaryOf(r, "2026-11").pace).toBeNull();
  });

  it("T20: income never rolls over even when the category or a row says otherwise", () => {
    const r = computePlan(
      fixtureF({
        categories: fixtureF().categories.map((c) => (c.id === F.paycheck ? { ...c, rolloverMode: "all" as RolloverMode, rolloverFromMonth: "2026-08" } : c)),
        rows: [...fixtureF().rows, row(F.paycheck, "2026-10", null, null, { carriedInOverrideCents: 1000n, rolloverMode: "all" })],
      }),
    );
    expect(cellOf(r, F.paycheck, "2026-09").remainingCents).toBe(10000n);
    expect(cellOf(r, F.paycheck, "2026-10")).toMatchObject({ carriedInCents: 0n, carriedInSource: "none", rolloverMode: "none", overspendCents: 0n });
    expect(cellOf(r, F.paycheck, "2026-11")).toMatchObject({ carriedInCents: 0n, carriedInSource: "none" });
    expect(r.summary.map((s) => s.leftToSpendCents)).toEqual(result.summary.map((s) => s.leftToSpendCents));
  });

  it("T28: rolloverFromMonth makes earlier months behave as 'none' so history is never imported as a negative carry", () => {
    const r = computePlan(
      fixtureF({
        categories: fixtureF().categories.map((c) => (c.id === F.pets ? { ...c, rolloverMode: "all" as RolloverMode, rolloverFromMonth: "2026-10" } : c)),
        actuals: [...fixtureF().actuals, actual(F.pets, "2026-10", -3000n, 1)],
      }),
    );
    expect(cellOf(r, F.pets, "2026-08")).toMatchObject({ rolloverMode: "none", carriedInCents: 0n, carriedInSource: "none", overspendCents: 7000n, committedCents: 7000n });
    expect(cellOf(r, F.pets, "2026-09")).toMatchObject({ carriedInCents: 0n, carriedInSource: "none", rolloverMode: "none" });
    expect(cellOf(r, F.pets, "2026-10")).toMatchObject({ carriedInCents: 0n, carriedInSource: "start", rolloverMode: "all", plannedCents: 0n, actualCents: 3000n, remainingCents: -3000n, overspendCents: 3000n, committedCents: 3000n });
    expect(cellOf(r, F.pets, "2026-11")).toMatchObject({ carriedInCents: -3000n, carriedInSource: "chain", availableCents: -3000n, remainingCents: -3000n, overspendCents: 3000n, committedCents: 0n });
    expect(catRow(r, F.pets)).toMatchObject({ rolloverMode: "all", rolloverFromMonth: "2026-10" });
  });

  it("T29: a refund larger than spending makes actual negative, the surplus rolls, left to spend is unchanged", () => {
    const r = computePlan(fixtureF({ to: "2026-12", actuals: [...fixtureF().actuals, actual(F.dining, "2026-11", 3000n, 1)] }));
    expect(cellOf(r, F.dining, "2026-11")).toMatchObject({
      plannedCents: 0n,
      source: "none",
      carriedInCents: 5000n,
      actualCents: -3000n,
      availableCents: 5000n,
      remainingCents: 8000n,
      overspendCents: 0n,
      committedCents: 0n,
      overspent: false,
    });
    expect(summaryOf(r, "2026-11").leftToSpendCents).toBe(299000n);
    expect(cellOf(r, F.dining, "2026-12").carriedInCents).toBe(8000n);
  });

  it("T30a: split lines arrive pre-attributed and count in their categories", () => {
    const r = computePlan(fixtureF({ actuals: [...fixtureF().actuals, actual(F.groceries, "2026-11", -6000n, 1), actual(F.dining, "2026-11", -4000n, 1)] }));
    expect(cellOf(r, F.groceries, "2026-11")).toMatchObject({ actualCents: 6000n, remainingCents: 2155n, txnCount: 1 });
    expect(cellOf(r, F.dining, "2026-11")).toMatchObject({ actualCents: 4000n, availableCents: 5000n, remainingCents: 1000n });
    expect(summaryOf(r, "2026-11").leftToSpendCents).toBe(299000n);
  });

  it("T30b: a hidden category stays in totals and left to spend", () => {
    const r = computePlan(fixtureF({ categories: fixtureF().categories.map((c) => (c.id === F.fuel ? { ...c, hidden: true } : c)) }));
    expect(catRow(r, F.fuel).hidden).toBe(true);
    expect(summaryOf(r, "2026-10").planned.spending).toBe(75000n);
    expect(summaryOf(r, "2026-10").committed.spending).toBe(70000n);
    expect(summaryOf(r, "2026-10").leftToSpendCents).toBe(238000n);
    const hiddenGroup = computePlan(fixtureF({ groups: fixtureF().groups.map((g) => (g.id === "fg-spending" ? { ...g, hidden: true } : g)) }));
    expect(catRow(hiddenGroup, F.fuel).hidden).toBe(true);
    expect(hiddenGroup.rows.find((x) => x.kind === "group" && x.groupId === "fg-spending")).toMatchObject({ hidden: true });
    expect(summaryOf(hiddenGroup, "2026-10").leftToSpendCents).toBe(238000n);
  });

  it("T30c: an empty install yields zero everywhere and a zero pace for the current month", () => {
    const r = computePlan({
      startMonth: "2026-11",
      from: "2026-10",
      to: "2026-12",
      today: "2026-11-01",
      zeroBased: false,
      groups: [group("g", "Spending", "spending", 0)],
      categories: [category("a", "Groceries", "spending", "g", 1), category("b", "Paycheck", "income", null, 1)],
      rows: [],
      actuals: [],
      goalNets: [],
      autoPlans: [],
      goals: [],
      uncategorized: [],
    });
    expect(r.rows).toHaveLength(7);
    for (const row of r.rows) {
      for (const c of row.cells) {
        expect(c).toMatchObject({ plannedCents: 0n, source: "none", carriedInCents: 0n, actualCents: 0n, remainingCents: 0n, committedCents: 0n, overspent: false });
      }
    }
    expect(cellOf(r, "a", "2026-11").carriedInSource).toBe("start");
    expect(cellOf(r, "a", "2026-10").carriedInSource).toBe("none");
    expect(cellOf(r, "a", "2026-12").carriedInSource).toBe("chain");
    for (const s of r.summary) {
      expect(s.planned).toEqual({ income: 0n, bills: 0n, savings: 0n, spending: 0n });
      expect(s.committed).toEqual({ income: 0n, bills: 0n, savings: 0n, spending: 0n });
      expect([s.plannedLeftToSpendCents, s.leftToSpendCents, s.toAssignCents, s.warning]).toEqual([0n, 0n, 0n, false]);
      expect(s.uncategorized).toEqual({ count: 0, cents: 0n });
    }
    expect(r.summary.map((s) => s.pace)).toEqual([null, { daysLeft: 30, perDayCents: 0n, overCents: 0n }, null]);
    const bare = computePlan({ ...fixtureF(), groups: [], categories: [], rows: [], actuals: [], goalNets: [], autoPlans: [], goals: [], uncategorized: [] });
    expect(bare.rows.map((x) => x.kind)).toEqual(["bucket", "bucket", "bucket", "bucket"]);
  });

  it("attaches a note and a per-month rollover override from the row", () => {
    const r = computePlan(
      fixtureF({
        rows: [...fixtureF().rows.map((x) => (x.categoryId === F.groceries && x.month === "2026-09" ? { ...x, rolloverMode: "none" as RolloverMode, note: "lean month" } : x))],
      }),
    );
    expect(cellOf(r, F.groceries, "2026-09")).toMatchObject({ rolloverMode: "none", note: "lean month", remainingCents: 18155n });
    expect(cellOf(r, F.groceries, "2026-10")).toMatchObject({ carriedInCents: 0n, carriedInSource: "chain", rolloverMode: "surplus" });
    expect(cellOf(r, F.groceries, "2026-08").note).toBeNull();
  });
});

// =====================================================================
// Helpers
// =====================================================================

describe("committedCents", () => {
  it("matches the grid design's cases", () => {
    expect(committedCents(50000n, 10000n, 54500n)).toBe(50000n);
    expect(committedCents(20000n, 0n, 26000n)).toBe(26000n);
    expect(committedCents(0n, -6000n, 0n)).toBe(0n);
    expect(committedCents(0n, 55500n, 0n)).toBe(0n);
    expect(committedCents(20000n, -5000n, 10000n)).toBe(15000n);
    expect(committedCents(0n, -3000n, 0n)).toBe(0n); // T28 Nov Pets: the carried overspend was charged in Oct
    expect(committedCents(0n, -3000n, 3000n)).toBe(3000n); // new spending on top of it is charged in full
    expect(committedCents(500000n, 0n, 250000n)).toBe(500000n);
    expect(committedCents(0n, 5000n, -3000n)).toBe(0n);
  });
  it("equals planned + min(carriedIn, 0) + overspend for every combination", () => {
    const values = [-7000n, -845n, 0n, 3000n, 18155n, 50000n];
    for (const planned of [0n, 15000n, 40000n]) {
      for (const carriedIn of values) {
        for (const act of values) {
          const overspend = planned + carriedIn - act < 0n ? act - planned - carriedIn : 0n;
          const minCarry = carriedIn < 0n ? carriedIn : 0n;
          expect(committedCents(planned, carriedIn, act)).toBe(planned + minCarry + overspend);
        }
      }
    }
  });
});

describe("carryOut", () => {
  it("drops, keeps the surplus, or keeps everything", () => {
    expect(carryOut("none", 6000n)).toBe(0n);
    expect(carryOut("none", -6000n)).toBe(0n);
    expect(carryOut("surplus", 6000n)).toBe(6000n);
    expect(carryOut("surplus", -6000n)).toBe(0n);
    expect(carryOut("all", 6000n)).toBe(6000n);
    expect(carryOut("all", -6000n)).toBe(-6000n);
    expect(carryOut("all", 0n)).toBe(0n);
  });
});

describe("paceCents (T12, adapted to a non-negative pace with overCents)", () => {
  it("counts today, handles month ends, February and leap years", () => {
    expect(paceCents(233000n, "2026-10-31")).toEqual({ daysLeft: 1, perDayCents: 233000n, overCents: 0n });
    expect(paceCents(233000n, "2026-11-30")).toEqual({ daysLeft: 1, perDayCents: 233000n, overCents: 0n });
    expect(paceCents(233000n, "2026-02-28")).toEqual({ daysLeft: 1, perDayCents: 233000n, overCents: 0n });
    expect(paceCents(233000n, "2026-02-01")).toEqual({ daysLeft: 28, perDayCents: 8321n, overCents: 0n });
    expect(paceCents(233000n, "2028-02-29")).toEqual({ daysLeft: 1, perDayCents: 233000n, overCents: 0n });
    expect(paceCents(233000n, "2028-02-01")).toEqual({ daysLeft: 29, perDayCents: 8034n, overCents: 0n });
    expect(paceCents(123456n, "2026-10-13")).toEqual({ daysLeft: 19, perDayCents: 6497n, overCents: 0n });
    expect(paceCents(2900n, "2028-02-01")).toEqual({ daysLeft: 29, perDayCents: 100n, overCents: 0n });
    expect(paceCents(100000n, "2028-02-10")).toEqual({ daysLeft: 20, perDayCents: 5000n, overCents: 0n });
    expect(paceCents(175352n, "2026-10-13")).toEqual({ daysLeft: 19, perDayCents: 9229n, overCents: 0n });
  });
  it("never promises a negative pace: the shortfall goes to overCents", () => {
    expect(paceCents(-5000n, "2026-10-31")).toEqual({ daysLeft: 1, perDayCents: 0n, overCents: 5000n });
    expect(paceCents(-67000n, "2026-10-13")).toEqual({ daysLeft: 19, perDayCents: 0n, overCents: 67000n });
    expect(paceCents(0n, "2026-10-13")).toEqual({ daysLeft: 19, perDayCents: 0n, overCents: 0n });
  });
});

describe("averageWindow and planAverage", () => {
  it("is the n completed months before asOf (T25-style)", () => {
    expect(averageWindow("2026-10", 3)).toEqual({ from: "2026-07", to: "2026-09" });
    expect(averageWindow("2026-10", 12)).toEqual({ from: "2025-10", to: "2026-09" });
    expect(averageWindow("2026-09", 6)).toEqual({ from: "2026-03", to: "2026-08" });
    expect(averageWindow("2027-01", 3)).toEqual({ from: "2026-10", to: "2026-12" });
    expect(addMonths(averageWindow("2026-11", 3).to, 1)).toBe("2026-11");
  });

  it("divides by the months on/after the ledger's first month, truncates and clamps at 0 (grid design averages)", () => {
    const w3 = averageWindow("2026-10", 3);
    const first = "2026-08";
    const groceries = new Map<MonthKey, bigint>([
      ["2026-08", 7000n],
      ["2026-09", 40000n],
      ["2026-10", 54500n],
    ]);
    expect(planAverage(groceries, w3, first)).toEqual({ cents: 23500n, monthsWithData: 2 });
    expect(planAverage(groceries, averageWindow("2026-10", 12), first)).toEqual({ cents: 23500n, monthsWithData: 2 });
    expect(planAverage(new Map([["2026-09", 1549n]]), w3, first)).toEqual({ cents: 774n, monthsWithData: 2 });
    expect(planAverage(new Map([["2026-09", 50000n]]), w3, first)).toEqual({ cents: 25000n, monthsWithData: 2 });
    expect(planAverage(new Map([["2026-09", 26000n]]), w3, first)).toEqual({ cents: 13000n, monthsWithData: 2 });
    expect(planAverage(new Map([["2026-09", 7999n]]), w3, first)).toEqual({ cents: 3999n, monthsWithData: 2 });
    expect(planAverage(new Map([["2026-09", 500000n]]), w3, first)).toEqual({ cents: 250000n, monthsWithData: 2 });
    expect(planAverage(new Map(), w3, first)).toEqual({ cents: 0n, monthsWithData: 2 });
    expect(planAverage(new Map([["2026-08", -1000n]]), w3, first)).toEqual({ cents: 0n, monthsWithData: 2 });
    expect(planAverage(groceries, w3, null)).toEqual({ cents: 0n, monthsWithData: 0 });
    expect(planAverage(groceries, w3, "2026-10")).toEqual({ cents: 0n, monthsWithData: 0 });
    expect(planAverage(groceries, w3, "2025-01")).toEqual({ cents: 15666n, monthsWithData: 3 });
    expect(planAverage(new Map([["2026-08", 7000n]]), w3, first)).toEqual({ cents: 3500n, monthsWithData: 2 });
  });
});

describe("goalProgress", () => {
  const emergency: GoalInput = {
    id: "g1",
    categoryId: "c1",
    name: "Emergency Fund",
    targetCents: 1000000n,
    targetDate: "2027-09-30",
    linkedAccountId: "acct",
    linkedAccountName: "Savings",
    monthlyContributionCents: 50000n,
    startMonth: "2026-09",
    startingCents: 200000n,
    status: "active",
  };
  const actuals = new Map<MonthKey, bigint>([
    ["2026-08", 999999n], // before startMonth: ignored
    ["2026-09", 50000n],
    ["2026-10", 30000n],
    ["2026-11", 50000n], // after currentMonth: ignored
  ]);

  it("matches the grid design's Emergency Fund numbers", () => {
    expect(goalProgress(emergency, actuals, "2026-10")).toEqual({
      savedCents: 280000n,
      remainingToTargetCents: 720000n,
      progressBp: 2800,
      monthsLeft: 12,
      neededPerMonthCents: 60000n,
      projectedCompletionMonth: "2028-01",
      onTrack: false,
    });
  });

  it("matches the Vacation goal: needed 33334, projected 2027-10", () => {
    const vacation: GoalInput = {
      ...emergency,
      id: "g2",
      name: "Vacation",
      targetCents: 300000n,
      targetDate: "2027-06-30",
      linkedAccountId: null,
      linkedAccountName: null,
      monthlyContributionCents: 25000n,
      startMonth: "2026-10",
      startingCents: 0n,
    };
    expect(goalProgress(vacation, new Map(), "2026-10")).toEqual({
      savedCents: 0n,
      remainingToTargetCents: 300000n,
      progressBp: 0,
      monthsLeft: 9,
      neededPerMonthCents: 33334n,
      projectedCompletionMonth: "2027-10",
      onTrack: false,
    });
    expect(goalProgress({ ...vacation, monthlyContributionCents: 40000n }, new Map(), "2026-10")).toMatchObject({ onTrack: true, projectedCompletionMonth: "2027-06" });
  });

  it("handles no target date, a past target, no contribution, a reached target and net withdrawals", () => {
    expect(goalProgress({ ...emergency, targetDate: null }, actuals, "2026-10")).toMatchObject({ monthsLeft: null, neededPerMonthCents: null, onTrack: null, projectedCompletionMonth: "2028-01" });
    expect(goalProgress({ ...emergency, targetDate: "2026-03-31" }, actuals, "2026-10")).toMatchObject({ monthsLeft: 1, neededPerMonthCents: 720000n, onTrack: false });
    expect(goalProgress({ ...emergency, targetDate: "2026-10-31" }, actuals, "2026-10")).toMatchObject({ monthsLeft: 1, neededPerMonthCents: 720000n });
    expect(goalProgress({ ...emergency, monthlyContributionCents: 0n }, actuals, "2026-10")).toMatchObject({ projectedCompletionMonth: null, onTrack: false });
    expect(goalProgress({ ...emergency, targetCents: 250000n }, actuals, "2026-10")).toEqual({
      savedCents: 280000n,
      remainingToTargetCents: 0n,
      progressBp: 10000,
      monthsLeft: 12,
      neededPerMonthCents: 0n,
      projectedCompletionMonth: "2026-10",
      onTrack: true,
    });
    expect(goalProgress({ ...emergency, startingCents: 0n }, new Map([["2026-10", -5000n]]), "2026-10")).toMatchObject({ savedCents: -5000n, remainingToTargetCents: 1005000n, progressBp: 0 });
    expect(goalProgress(emergency, actuals, "2026-08")).toMatchObject({ savedCents: 200000n, monthsLeft: 14 });
  });
});
