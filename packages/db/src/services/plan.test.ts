import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MonthKey, PlanCategoryRowResult, PlanCell, PlanResult, PlanRowResult } from "@meridian/shared";
import { auditLog, category, monthPlan, split, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "../test/planSeed.js";
import { listAudit, PlanError } from "./audit.js";
import { deleteCategory, listCategories, reorderCategories, updateCategory } from "./categories.js";
import { createCategoryGroup, deleteCategoryGroup, listCategoryGroups, reorderCategoryGroups } from "./categoryGroups.js";
import { getPlan, listPlanTransactions, planAverages, setPlanCells } from "./plan.js";
import { getHouseholdSetting, updateHouseholdSetting } from "./settings.js";
import { updateTransaction } from "./transactions.js";

const RANGE = { from: "2026-08", to: "2027-01", today: PLAN_SEED_TODAY };
const MONTHS = ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"];

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

/** planned / carriedIn / actual / remaining / source: the grid design's shorthand. */
const brief = (c: PlanCell): [bigint, bigint, bigint, bigint, string] => [c.plannedCents, c.carriedInCents, c.actualCents, c.remainingCents, c.source];
const totals = (c: PlanCell): [bigint, bigint, bigint, bigint] => [c.plannedCents, c.carriedInCents, c.actualCents, c.remainingCents];
const rowOrder = (result: PlanResult, bucket: string) =>
  result.rows.filter((r) => r.bucket === bucket).map((r) => (r.kind === "bucket" ? `bucket:${r.bucket}` : r.kind === "group" ? `group:${r.name}` : r.name));
const ctx = (batchId = randomUUID()) => ({ userId: null, batchId });

describe.skipIf(!TEST_DATABASE_URL)("plan services on the grid-and-api seed", () => {
  let t: TestDb;
  let S: PlanSeed;
  let C: PlanSeed["categories"];

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedPlanFixture(t.db);
    C = S.categories;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("GET plan: range, row order and the Groceries chain ('all' from 2026-09)", async () => {
    const plan = await getPlan(t.db, RANGE);
    expect(plan.currentMonth).toBe("2026-10");
    expect(plan.months).toEqual(MONTHS);
    expect(plan.rows[0]).toMatchObject({ kind: "bucket", bucket: "income" });
    expect(rowOrder(plan, "spending")).toEqual(["bucket:spending", "group:Everyday", "Groceries", "Dining", "Fuel", "Old Hobby", "Shopping"]);
    expect(catRow(plan, C.oldHobby).hidden).toBe(true);
    expect(catRow(plan, C.shopping)).toMatchObject({ groupId: null, position: 1 });
    expect(catRow(plan, C.groceries)).toMatchObject({ rolloverMode: "all", rolloverFromMonth: "2026-09", goal: null });

    const g = (m: MonthKey) => cellOf(plan, C.groceries, m);
    expect(brief(g("2026-08"))).toEqual([0n, 0n, 7000n, -7000n, "none"]);
    expect(g("2026-08").overspent).toBe(true);
    expect(brief(g("2026-09"))).toEqual([50000n, 0n, 40000n, 10000n, "manual"]);
    expect(brief(g("2026-10"))).toEqual([50000n, 10000n, 54500n, 5500n, "manual"]);
    expect(g("2026-10").txnCount).toBe(3);
    expect(brief(g("2026-11"))).toEqual([50000n, 5500n, 0n, 55500n, "manual"]);
    expect(brief(g("2026-12"))).toEqual([0n, 55500n, 0n, 55500n, "none"]);
    expect(brief(g("2027-01"))).toEqual([0n, 55500n, 0n, 55500n, "none"]);
  });

  it("Dining (surplus), Fuel (none, pending) and the month boundary", async () => {
    const plan = await getPlan(t.db, RANGE);
    expect(brief(cellOf(plan, C.dining, "2026-09"))).toEqual([20000n, 0n, 26000n, -6000n, "manual"]);
    expect(cellOf(plan, C.dining, "2026-09").overspent).toBe(true);
    expect(brief(cellOf(plan, C.dining, "2026-10"))).toEqual([20000n, 0n, 20000n, 0n, "manual"]);
    expect(brief(cellOf(plan, C.dining, "2026-11"))).toEqual([0n, 0n, 0n, 0n, "none"]);
    expect(brief(cellOf(plan, C.fuel, "2026-09"))).toEqual([0n, 0n, 6000n, -6000n, "none"]);
    expect(brief(cellOf(plan, C.fuel, "2026-10"))).toEqual([15000n, 0n, 5500n, 9500n, "manual"]);
    expect(cellOf(plan, C.fuel, "2026-10")).toMatchObject({ pendingCents: 2500n, txnCount: 2 });
    expect(cellOf(plan, C.rent, "2026-10").actualCents).toBe(180000n);
    expect(cellOf(plan, C.oldHobby, "2026-09").actualCents).toBe(2000n);
  });

  it("auto-fills bills from recurring occurrences, savings from the goal, and decorates the goal row", async () => {
    const plan = await getPlan(t.db, RANGE);
    expect(brief(cellOf(plan, C.rent, "2026-08"))).toEqual([0n, 0n, 0n, 0n, "none"]);
    expect(brief(cellOf(plan, C.rent, "2026-09"))).toEqual([180000n, 0n, 180000n, 0n, "recurring"]);
    expect(brief(cellOf(plan, C.rent, "2026-10"))).toEqual([180000n, 0n, 180000n, 0n, "recurring"]);
    for (const m of ["2026-11", "2026-12", "2027-01"]) expect(brief(cellOf(plan, C.rent, m))).toEqual([180000n, 0n, 0n, 180000n, "recurring"]);
    expect(brief(cellOf(plan, C.netflix, "2026-10"))).toEqual([1549n, 0n, 1649n, -100n, "recurring"]);
    expect(cellOf(plan, C.netflix, "2026-10").overspent).toBe(true);
    expect(brief(cellOf(plan, C.internet, "2026-10"))).toEqual([7999n, 0n, 0n, 7999n, "recurring"]);
    expect(brief(cellOf(plan, C.carInsurance, "2026-12"))).toEqual([45000n, 0n, 0n, 45000n, "recurring"]);
    for (const m of MONTHS.filter((m) => m !== "2026-12")) expect(brief(cellOf(plan, C.carInsurance, m))).toEqual([0n, 0n, 0n, 0n, "none"]);
    for (const m of MONTHS) expect(brief(cellOf(plan, C.music, m))).toEqual([0n, 0n, 0n, 0n, "none"]);

    expect(brief(cellOf(plan, C.emergencyFund, "2026-08"))).toEqual([0n, 0n, 0n, 0n, "none"]);
    expect(brief(cellOf(plan, C.emergencyFund, "2026-09"))).toEqual([50000n, 0n, 50000n, 0n, "goal"]);
    expect(brief(cellOf(plan, C.emergencyFund, "2026-10"))).toEqual([50000n, 0n, 30000n, 20000n, "goal"]);
    expect(cellOf(plan, C.emergencyFund, "2026-10").txnCount).toBe(2);
    for (const m of ["2026-11", "2026-12", "2027-01"]) expect(brief(cellOf(plan, C.emergencyFund, m))).toEqual([50000n, 0n, 0n, 50000n, "goal"]);
    expect(catRow(plan, C.emergencyFund).goal).toMatchObject({
      id: S.goals.emergencyFund,
      name: "Emergency Fund",
      linkedAccountId: S.accounts.savings,
      linkedAccountName: "Savings",
      progress: { savedCents: 280000n, remainingToTargetCents: 720000n, monthsLeft: 12, neededPerMonthCents: 60000n, projectedCompletionMonth: "2028-01", onTrack: false, progressBp: 2800 },
    });

    expect(brief(cellOf(plan, C.paycheck, "2026-09"))).toEqual([500000n, 0n, 500000n, 0n, "manual"]);
    expect(brief(cellOf(plan, C.paycheck, "2026-10"))).toEqual([500000n, 0n, 250000n, 250000n, "manual"]);
    expect(brief(cellOf(plan, C.paycheck, "2026-11"))).toEqual([500000n, 0n, 0n, 500000n, "manual"]);
    for (const m of ["2026-12", "2027-01"]) expect(brief(cellOf(plan, C.paycheck, m))).toEqual([0n, 0n, 0n, 0n, "none"]);
  });

  it("subtotal rows and the summary strip (committed, LTS, to assign, pace, uncategorized)", async () => {
    const plan = await getPlan(t.db, RANGE);
    const spending = (m: MonthKey) => totals(rowCell(plan, (r) => r.kind === "bucket" && r.bucket === "spending", m));
    expect(spending("2026-08")).toEqual([0n, 0n, 7000n, -7000n]);
    expect(spending("2026-09")).toEqual([70000n, 0n, 74000n, -4000n]);
    expect(spending("2026-10")).toEqual([85000n, 10000n, 80000n, 15000n]);
    expect(spending("2026-11")).toEqual([50000n, 5500n, 0n, 55500n]);
    expect(spending("2026-12")).toEqual([0n, 55500n, 0n, 55500n]);
    expect(totals(rowCell(plan, (r) => r.kind === "group" && r.name === "Everyday", "2026-10"))).toEqual([85000n, 10000n, 80000n, 15000n]);
    expect(totals(rowCell(plan, (r) => r.kind === "group" && r.name === "Subscriptions", "2026-10"))).toEqual([9548n, 0n, 1649n, 7899n]);
    expect(totals(rowCell(plan, (r) => r.kind === "group" && r.name === "Housing", "2026-10"))).toEqual([180000n, 0n, 180000n, 0n]);
    const bills = (m: MonthKey) => totals(rowCell(plan, (r) => r.kind === "bucket" && r.bucket === "bills", m));
    expect(bills("2026-09")).toEqual([189548n, 0n, 189548n, 0n]);
    expect(bills("2026-10")).toEqual([189548n, 0n, 181649n, 7899n]);
    expect(bills("2026-12")).toEqual([234548n, 0n, 0n, 234548n]);

    const c = (m: MonthKey) => Object.values(summaryOf(plan, m).committed);
    expect(c("2026-08")).toEqual([0n, 0n, 0n, 7000n]);
    expect(c("2026-09")).toEqual([500000n, 189548n, 50000n, 84000n]);
    expect(c("2026-10")).toEqual([500000n, 189648n, 50000n, 85000n]);
    expect(c("2026-11")).toEqual([500000n, 189548n, 50000n, 50000n]);
    expect(c("2026-12")).toEqual([0n, 234548n, 50000n, 0n]);
    expect(plan.summary.map((s) => s.leftToSpendCents)).toEqual([-7000n, 176452n, 175352n, 210452n, -284548n, -239548n]);
    expect(plan.summary.map((s) => s.toAssignCents)).toEqual([0n, 190452n, 175452n, 210452n, -284548n, -239548n]);
    expect(plan.summary.map((s) => s.warning)).toEqual([true, false, false, false, true, true]);
    expect(plan.summary.map((s) => s.pace)).toEqual([null, null, { daysLeft: 19, perDayCents: 9229n, overCents: 0n }, null, null, null]);
    expect(summaryOf(plan, "2026-10").uncategorized).toEqual({ count: 1, cents: -4500n });
    expect(summaryOf(plan, "2026-09").uncategorized).toEqual({ count: 0, cents: 0n });
  });

  it("rejects a bad range", async () => {
    await expect(getPlan(t.db, { from: "2026-10", to: "2026-09", today: PLAN_SEED_TODAY })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(getPlan(t.db, { from: "2024-01", to: "2026-12", today: PLAN_SEED_TODAY })).rejects.toThrow(/At most 24 months/);
    await expect(getPlan(t.db, { from: "2026-13", to: "2026-12", today: PLAN_SEED_TODAY })).rejects.toThrow(PlanError);
  });

  it("fill right: one audit batch, identical re-run changes nothing, clearing deletes the rows", async () => {
    const edits = ["2026-11", "2026-12", "2027-01"].map((month) => ({ month, categoryId: C.dining, plannedCents: 20000n }));
    const batch = randomUUID();
    expect(await setPlanCells(t.db, edits, ctx(batch))).toEqual({ changed: 3 });
    const plan = await getPlan(t.db, RANGE);
    // Dining carries its surplus, so each unspent 20000 rolls into the next month.
    expect(brief(cellOf(plan, C.dining, "2026-11"))).toEqual([20000n, 0n, 0n, 20000n, "manual"]);
    expect(brief(cellOf(plan, C.dining, "2026-12"))).toEqual([20000n, 20000n, 0n, 40000n, "manual"]);
    expect(brief(cellOf(plan, C.dining, "2027-01"))).toEqual([20000n, 40000n, 0n, 60000n, "manual"]);
    for (const m of ["2026-11", "2026-12", "2027-01"]) expect(cellOf(plan, C.dining, m)).toMatchObject({ hasExplicitPlan: true, committedCents: 20000n });
    expect(summaryOf(plan, "2026-11")).toMatchObject({ leftToSpendCents: 190452n, toAssignCents: 190452n });
    expect(summaryOf(plan, "2026-11").committed.spending).toBe(70000n);
    expect(summaryOf(plan, "2026-12").leftToSpendCents).toBe(-304548n);

    const audit = await listAudit(t.db, { entity: "month_plan", limit: 50 });
    expect(audit.items).toHaveLength(3);
    expect(audit.items.every((e) => e.batchId === batch && e.action === "create" && e.before === null)).toBe(true);
    expect(audit.items.map((e) => e.entityId).sort()).toEqual(["2026-11", "2026-12", "2027-01"].map((m) => `${m}:${C.dining}`));
    expect(audit.items[0]!.after).toEqual({ plannedCents: "20000", source: "manual", rolloverMode: null, carriedInOverrideCents: null, note: null });

    expect(await setPlanCells(t.db, edits, ctx())).toEqual({ changed: 0 });
    expect((await listAudit(t.db, { entity: "month_plan", limit: 50 })).items).toHaveLength(3);

    // Clearing deletes the rows (every nullable column null) and audits a delete per cell.
    expect(await setPlanCells(t.db, edits.map((e) => ({ ...e, plannedCents: null })), ctx())).toEqual({ changed: 3 });
    const after = await getPlan(t.db, RANGE);
    for (const m of ["2026-11", "2026-12", "2027-01"]) expect(brief(cellOf(after, C.dining, m))).toEqual([0n, 0n, 0n, 0n, "none"]);
    const deletes = (await listAudit(t.db, { entity: "month_plan", limit: 50 })).items.filter((e) => e.action === "delete");
    expect(deletes).toHaveLength(3);
    expect(deletes[0]!.after).toBeNull();
  });

  it("override a recurring bill, then clear to auto; audit newest first; negative cents rejected", async () => {
    const rentOct = `2026-10:${C.rent}`;
    expect(await setPlanCells(t.db, [{ month: "2026-10", categoryId: C.rent, plannedCents: 190000n }], ctx())).toEqual({ changed: 1 });
    let plan = await getPlan(t.db, RANGE);
    expect(brief(cellOf(plan, C.rent, "2026-10"))).toEqual([190000n, 0n, 180000n, 10000n, "manual"]);
    expect(summaryOf(plan, "2026-10").committed.bills).toBe(199648n);
    expect(summaryOf(plan, "2026-10")).toMatchObject({ leftToSpendCents: 165352n, toAssignCents: 165452n });

    expect(await setPlanCells(t.db, [{ month: "2026-10", categoryId: C.rent, plannedCents: null }], ctx())).toEqual({ changed: 1 });
    plan = await getPlan(t.db, RANGE);
    expect(brief(cellOf(plan, C.rent, "2026-10"))).toEqual([180000n, 0n, 180000n, 0n, "recurring"]);
    expect(summaryOf(plan, "2026-10").leftToSpendCents).toBe(175352n);

    const audit = await listAudit(t.db, { entity: "month_plan", entityId: rentOct, limit: 10 });
    expect(audit.items.map((e) => e.action)).toEqual(["delete", "create"]);
    expect(audit.items[0]!.before).toMatchObject({ plannedCents: "190000", source: "manual" });
    expect(audit.items[0]!.after).toBeNull();
    expect(audit.items[1]!.before).toBeNull();
    expect(audit.items[1]!.after).toMatchObject({ plannedCents: "190000", source: "manual" });

    await expect(setPlanCells(t.db, [{ month: "2026-10", categoryId: C.rent, plannedCents: -100n }], ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
    expect((await listAudit(t.db, { entity: "month_plan", entityId: rentOct, limit: 10 })).items).toHaveLength(2);
    await expect(setPlanCells(t.db, [{ month: "2026-10", categoryId: randomUUID(), plannedCents: 1n }], ctx())).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("T26: writes before the plan start are rejected; an emptied row is deleted; income never rolls over", async () => {
    await expect(setPlanCells(t.db, [{ month: "2026-07", categoryId: C.groceries, plannedCents: 1n }], ctx())).rejects.toMatchObject({ status: 400, code: "before_plan_start" });
    const key = `2026-11:${C.shopping}`;
    expect(await setPlanCells(t.db, [{ month: "2026-11", categoryId: C.shopping, plannedCents: 1000n, note: "test" }], ctx())).toEqual({ changed: 1 });
    expect(await setPlanCells(t.db, [{ month: "2026-11", categoryId: C.shopping, plannedCents: null }], ctx())).toEqual({ changed: 1 });
    // The note keeps the row alive; clearing it too deletes the row.
    expect(await t.db.select().from(monthPlan).where(eq(monthPlan.categoryId, C.shopping))).toHaveLength(1);
    expect(await setPlanCells(t.db, [{ month: "2026-11", categoryId: C.shopping, note: null }], ctx())).toEqual({ changed: 1 });
    expect(await t.db.select().from(monthPlan).where(eq(monthPlan.categoryId, C.shopping))).toHaveLength(0);
    const plan = await getPlan(t.db, RANGE);
    expect(brief(cellOf(plan, C.shopping, "2026-11"))).toEqual([0n, 0n, 0n, 0n, "none"]);
    expect((await listAudit(t.db, { entity: "month_plan", entityId: key, limit: 10 })).items.map((e) => e.action)).toEqual(["delete", "update", "create"]);

    await expect(setPlanCells(t.db, [{ month: "2026-10", categoryId: C.paycheck, carriedInOverrideCents: 1000n }], ctx())).rejects.toMatchObject({ status: 400, code: "income_no_rollover" });
    await expect(setPlanCells(t.db, [{ month: "2026-10", categoryId: C.paycheck, rolloverMode: "all" }], ctx())).rejects.toMatchObject({ status: 400, code: "income_no_rollover" });
  });

  it("carried-in override pins the chain and feeds forward", async () => {
    expect(await setPlanCells(t.db, [{ month: "2026-10", categoryId: C.groceries, carriedInOverrideCents: 0n }], ctx())).toEqual({ changed: 1 });
    const plan = await getPlan(t.db, RANGE);
    expect(cellOf(plan, C.groceries, "2026-10")).toMatchObject({ carriedInCents: 0n, carriedInSource: "override", remainingCents: -4500n });
    expect(cellOf(plan, C.groceries, "2026-11")).toMatchObject({ carriedInCents: -4500n, carriedInSource: "chain" });
    expect(await setPlanCells(t.db, [{ month: "2026-10", categoryId: C.groceries, carriedInOverrideCents: null }], ctx())).toEqual({ changed: 1 });
    expect(cellOf(await getPlan(t.db, RANGE), C.groceries, "2026-10")).toMatchObject({ carriedInCents: 10000n, carriedInSource: "chain", remainingCents: 5500n });
  });

  it("averages divide by months with data and truncate", async () => {
    const three = await planAverages(t.db, { months: 3, today: PLAN_SEED_TODAY });
    expect(three.window).toEqual({ from: "2026-07", to: "2026-09", monthsWithData: 2 });
    const avg = (r: typeof three, id: string) => r.averages.find((a) => a.categoryId === id)?.averageCents;
    expect(avg(three, C.groceries)).toBe(23500n);
    expect(avg(three, C.dining)).toBe(13000n);
    expect(avg(three, C.fuel)).toBe(3000n);
    expect(avg(three, C.oldHobby)).toBe(1000n);
    expect(avg(three, C.rent)).toBe(90000n);
    expect(avg(three, C.netflix)).toBe(774n);
    expect(avg(three, C.internet)).toBe(3999n);
    expect(avg(three, C.paycheck)).toBe(250000n);
    expect(avg(three, C.emergencyFund)).toBe(25000n);
    for (const id of [C.carInsurance, C.music, C.shopping]) expect(avg(three, id)).toBe(0n);
    expect(three.averages).toHaveLength(12);

    const twelve = await planAverages(t.db, { months: 12, asOf: "2026-10", today: PLAN_SEED_TODAY });
    expect(twelve.window).toEqual({ from: "2025-10", to: "2026-09", monthsWithData: 2 });
    expect(twelve.averages).toEqual(three.averages);
  });

  it("an average-sourced edit feeds the carry chain", async () => {
    expect(await setPlanCells(t.db, [{ month: "2026-11", categoryId: C.groceries, plannedCents: 23500n, source: "average" }], ctx())).toEqual({ changed: 1 });
    const plan = await getPlan(t.db, RANGE);
    expect(brief(cellOf(plan, C.groceries, "2026-11"))).toEqual([23500n, 5500n, 0n, 29000n, "average"]);
    expect(brief(cellOf(plan, C.groceries, "2026-12"))).toEqual([0n, 29000n, 0n, 29000n, "none"]);
    expect(brief(cellOf(plan, C.groceries, "2027-01"))).toEqual([0n, 29000n, 0n, 29000n, "none"]);
    expect(summaryOf(plan, "2026-11").committed.spending).toBe(23500n);
    expect(summaryOf(plan, "2026-11")).toMatchObject({ leftToSpendCents: 236952n, toAssignCents: 236952n });
    // Fill right over an average cell overwrites it with source manual (same value, different provenance).
    expect(await setPlanCells(t.db, [{ month: "2026-11", categoryId: C.groceries, plannedCents: 23500n, source: "manual" }], ctx())).toEqual({ changed: 1 });
    expect(cellOf(await getPlan(t.db, RANGE), C.groceries, "2026-11").source).toBe("manual");
    // Restore the seed value for the tests below.
    expect(await setPlanCells(t.db, [{ month: "2026-11", categoryId: C.groceries, plannedCents: 50000n }], ctx())).toEqual({ changed: 1 });
  });

  it("rollover mode change re-derives carries without moving LTS; income rejects rollover; none clears the start", async () => {
    const batch = randomUUID();
    const dining = await updateCategory(t.db, C.dining, { rolloverMode: "all", rolloverFromMonth: "2026-09" }, { ...ctx(batch), today: PLAN_SEED_TODAY });
    expect(dining).toMatchObject({ rolloverMode: "all", rolloverFromMonth: "2026-09" });
    let plan = await getPlan(t.db, RANGE);
    expect(brief(cellOf(plan, C.dining, "2026-09"))).toEqual([20000n, 0n, 26000n, -6000n, "manual"]);
    expect(brief(cellOf(plan, C.dining, "2026-10"))).toEqual([20000n, -6000n, 20000n, -6000n, "manual"]);
    expect(brief(cellOf(plan, C.dining, "2026-11"))).toEqual([0n, -6000n, 0n, -6000n, "none"]);
    expect(brief(cellOf(plan, C.dining, "2027-01"))).toEqual([0n, -6000n, 0n, -6000n, "none"]);
    expect(plan.summary.slice(1, 4).map((s) => s.leftToSpendCents)).toEqual([176452n, 175352n, 210452n]);

    await expect(updateCategory(t.db, C.paycheck, { rolloverMode: "surplus" }, { ...ctx(), today: PLAN_SEED_TODAY })).rejects.toMatchObject({ status: 400, code: "income_no_rollover" });

    const none = await updateCategory(t.db, C.dining, { rolloverMode: "none" }, { ...ctx(), today: PLAN_SEED_TODAY });
    expect(none).toMatchObject({ rolloverMode: "none", rolloverFromMonth: null });
    plan = await getPlan(t.db, RANGE);
    expect(cellOf(plan, C.dining, "2026-10")).toMatchObject({ carriedInCents: 0n, rolloverMode: "none" });
    const audit = await listAudit(t.db, { entity: "category", entityId: C.dining, limit: 10 });
    expect(audit.items[0]).toMatchObject({ action: "update" });
    expect(audit.items[0]!.before).toMatchObject({ rolloverMode: "all", rolloverFromMonth: "2026-09" });
    expect(audit.items[0]!.after).toMatchObject({ rolloverMode: "none", rolloverFromMonth: null });

    // Enabling a carrying mode without a start month uses the current month.
    const enabled = await updateCategory(t.db, C.dining, { rolloverMode: "surplus" }, { ...ctx(), today: PLAN_SEED_TODAY });
    expect(enabled.rolloverFromMonth).toBe("2026-10");
    await expect(updateCategory(t.db, C.dining, { rolloverFromMonth: "2026-07" }, { ...ctx(), today: PLAN_SEED_TODAY })).rejects.toMatchObject({ code: "before_plan_start" });
    // Back to the seed's setting.
    await updateCategory(t.db, C.dining, { rolloverMode: "surplus", rolloverFromMonth: "2026-09" }, { ...ctx(), today: PLAN_SEED_TODAY });
  });

  it("drill-down filters (category, goal, uncategorized) and drag-to-categorize", async () => {
    const groceries = await listPlanTransactions(t.db, { month: "2026-10", categoryId: C.groceries });
    expect(groceries.items.map((i) => [i.date, i.amountCents])).toEqual([
      ["2026-10-12", 1500n],
      ["2026-10-11", -21000n],
      ["2026-10-02", -35000n],
    ]);
    const goal = await listPlanTransactions(t.db, { month: "2026-10", goalId: S.goals.emergencyFund });
    expect(goal.items.map((i) => [i.date, i.amountCents, i.accountId, i.isTransfer])).toEqual([
      ["2026-10-10", -20000n, S.accounts.savings, true],
      ["2026-10-02", 50000n, S.accounts.savings, true],
    ]);
    const unc = await listPlanTransactions(t.db, { month: "2026-10", uncategorized: true });
    expect(unc.items.map((i) => i.rawDescription)).toEqual(["AMAZON"]);
    await expect(listPlanTransactions(t.db, { month: "2026-10" })).rejects.toMatchObject({ status: 400 });

    const patched = await updateTransaction(t.db, S.transactions.amazon, { categoryId: C.shopping });
    expect(patched).toMatchObject({ categoryId: C.shopping, categoryLocked: true });
    const plan = await getPlan(t.db, RANGE);
    expect(brief(cellOf(plan, C.shopping, "2026-10"))).toEqual([0n, 0n, 4500n, -4500n, "none"]);
    expect(cellOf(plan, C.shopping, "2026-10").overspent).toBe(true);
    expect(summaryOf(plan, "2026-10").uncategorized).toEqual({ count: 0, cents: 0n });
    expect(summaryOf(plan, "2026-10").committed.spending).toBe(89500n);
    expect(summaryOf(plan, "2026-10")).toMatchObject({ leftToSpendCents: 170852n, toAssignCents: 175452n, pace: { daysLeft: 19, perDayCents: 8992n, overCents: 0n } });
    expect((await listPlanTransactions(t.db, { month: "2026-10", uncategorized: true })).items).toHaveLength(0);
  });

  it("groups: create, reorder across groups, bucket mismatch, category delete rules, group delete", async () => {
    const transport = await createCategoryGroup(t.db, { name: "Transport", bucket: "spending" }, ctx());
    expect(transport).toMatchObject({ bucket: "spending", position: 2, categoryCount: 0 });
    await expect(createCategoryGroup(t.db, { name: "Transport", bucket: "spending" }, ctx())).rejects.toMatchObject({ status: 409, code: "conflict" });

    const cats = await reorderCategories(t.db, { groupId: transport.id, ids: [C.fuel] }, ctx());
    expect(cats.find((c) => c.id === C.fuel)).toMatchObject({ groupId: transport.id, position: 1 });
    expect((await listCategoryGroups(t.db)).find((g) => g.id === transport.id)?.categoryCount).toBe(1);
    let plan = await getPlan(t.db, RANGE);
    expect(rowOrder(plan, "spending")).toEqual(["bucket:spending", "group:Everyday", "Groceries", "Dining", "Old Hobby", "group:Transport", "Fuel", "Shopping"]);
    const transportOct = rowCell(plan, (r) => r.kind === "group" && r.name === "Transport", "2026-10");
    expect(totals(transportOct)).toEqual([15000n, 0n, 5500n, 9500n]);
    expect(transportOct.pendingCents).toBe(2500n);

    await expect(reorderCategories(t.db, { groupId: S.groups.housing, ids: [C.fuel] }, ctx())).rejects.toMatchObject({ status: 400, code: "bucket_mismatch" });
    await expect(updateCategory(t.db, C.fuel, { groupId: S.groups.housing }, { ...ctx(), today: PLAN_SEED_TODAY })).rejects.toMatchObject({ status: 400, code: "bucket_mismatch" });

    // Reorder within Everyday: Dining first, Groceries keeps its relative order after.
    const reordered = await reorderCategories(t.db, { groupId: S.groups.everyday, ids: [C.dining, randomUUID()] }, ctx());
    const everyday = reordered.filter((c) => c.groupId === S.groups.everyday).map((c) => [c.name, c.position]);
    expect(everyday).toEqual([
      ["Dining", 1],
      ["Groceries", 2],
      ["Old Hobby", 3],
    ]);
    await reorderCategories(t.db, { groupId: S.groups.everyday, ids: [C.groceries, C.dining, C.oldHobby] }, ctx());

    const groups = await reorderCategoryGroups(t.db, { bucket: "spending", ids: [transport.id] }, ctx());
    expect(groups.filter((g) => g.bucket === "spending").map((g) => [g.name, g.position])).toEqual([
      ["Transport", 1],
      ["Everyday", 2],
    ]);
    await expect(reorderCategoryGroups(t.db, { bucket: "bills", ids: [transport.id] }, ctx())).rejects.toMatchObject({ code: "bucket_mismatch" });
    await reorderCategoryGroups(t.db, { bucket: "spending", ids: [S.groups.everyday] }, ctx());

    await expect(deleteCategory(t.db, C.groceries, ctx())).rejects.toMatchObject({ status: 409, code: "in_use" });
    await expect(deleteCategory(t.db, C.emergencyFund, ctx())).rejects.toMatchObject({ status: 409, code: "in_use" });
    await expect(deleteCategory(t.db, C.rent, ctx())).rejects.toMatchObject({ status: 409, code: "in_use" });
    await deleteCategory(t.db, C.music, ctx());
    plan = await getPlan(t.db, RANGE);
    expect(plan.rows.some((r) => r.kind === "category" && r.categoryId === C.music)).toBe(false);
    expect((await listAudit(t.db, { entity: "category", entityId: C.music, limit: 5 })).items[0]).toMatchObject({ action: "delete", after: null });
    await expect(deleteCategory(t.db, C.music, ctx())).rejects.toMatchObject({ status: 404 });

    await deleteCategoryGroup(t.db, transport.id, ctx());
    expect((await listCategories(t.db)).find((c) => c.id === C.fuel)?.groupId).toBeNull();
    plan = await getPlan(t.db, RANGE);
    expect(rowOrder(plan, "spending")).toEqual(["bucket:spending", "group:Everyday", "Groceries", "Dining", "Old Hobby", "Fuel", "Shopping"]);
  });

  it("splits attribute by split category and never double count", async () => {
    const [parent] = await t.db
      .insert(transaction)
      .values({ accountId: S.accounts.checking, source: "manual", date: "2026-11-03", amountCents: -10000n, rawDescription: "COSTCO", categoryId: null })
      .returning({ id: transaction.id });
    await t.db.insert(split).values([
      { transactionId: parent!.id, categoryId: C.groceries, amountCents: -6000n },
      { transactionId: parent!.id, categoryId: C.dining, amountCents: -4000n },
    ]);
    const plan = await getPlan(t.db, RANGE);
    expect(cellOf(plan, C.groceries, "2026-11")).toMatchObject({ actualCents: 6000n, remainingCents: 49500n, txnCount: 1 });
    expect(cellOf(plan, C.dining, "2026-11")).toMatchObject({ actualCents: 4000n, remainingCents: -4000n, txnCount: 1 });
    expect(summaryOf(plan, "2026-11").uncategorized).toEqual({ count: 0, cents: 0n });
    expect(summaryOf(plan, "2026-11").actual.spending).toBe(10000n);
  });

  it("household settings: patch is audited, bad time zone rejected, zero-based drives the warning", async () => {
    const before = await getHouseholdSetting(t.db, PLAN_SEED_TODAY);
    expect(before).toMatchObject({ planStartMonth: "2026-08", zeroBased: false, timezone: "America/Denver" });
    await expect(updateHouseholdSetting(t.db, { timezone: "Mars/Olympus" }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
    const after = await updateHouseholdSetting(t.db, { zeroBased: true, lowBalanceThresholdCents: 50000n }, ctx());
    expect(after).toMatchObject({ zeroBased: true, lowBalanceThresholdCents: 50000n });
    const audit = await listAudit(t.db, { entity: "household_setting", limit: 5 });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ entityId: "1", action: "update" });
    expect(audit.items[0]!.before).toMatchObject({ zeroBased: false, lowBalanceThresholdCents: "0" });
    expect(audit.items[0]!.after).toMatchObject({ zeroBased: true, lowBalanceThresholdCents: "50000" });
    // Identical patch: nothing written.
    await updateHouseholdSetting(t.db, { zeroBased: true }, ctx());
    expect((await listAudit(t.db, { entity: "household_setting", limit: 5 })).items).toHaveLength(1);
    const plan = await getPlan(t.db, RANGE);
    expect(plan.zeroBased).toBe(true);
    await updateHouseholdSetting(t.db, { zeroBased: false }, ctx());
  });

  it("writes nothing to audit_log for reads", async () => {
    const [before] = await t.db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
    await getPlan(t.db, RANGE);
    await planAverages(t.db, { months: 6, today: PLAN_SEED_TODAY });
    const [after] = await t.db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
    expect(after!.n).toBe(before!.n);
    const [hidden] = await t.db.select({ hidden: category.hidden }).from(category).where(eq(category.id, C.oldHobby));
    expect(hidden!.hidden).toBe(true);
  });
});
