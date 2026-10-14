import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MonthKey, PlanCategoryRowResult, PlanResult } from "@meridian/shared";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "../test/planSeed.js";
import { listAudit } from "./audit.js";
import { createCategory, listCategories } from "./categories.js";
import { createGoal, deleteGoal, getGoal, listGoals, updateGoal } from "./goals.js";
import { getPlan } from "./plan.js";

const RANGE = { from: "2026-08", to: "2027-01", today: PLAN_SEED_TODAY };
const ctx = (batchId = randomUUID()) => ({ userId: null, batchId, today: PLAN_SEED_TODAY });

function catRow(result: PlanResult, categoryId: string): PlanCategoryRowResult {
  const r = result.rows.find((x): x is PlanCategoryRowResult => x.kind === "category" && x.categoryId === categoryId);
  if (!r) throw new Error(`no row for ${categoryId}`);
  return r;
}
const cell = (result: PlanResult, categoryId: string, month: MonthKey) => catRow(result, categoryId).cells[result.months.indexOf(month)]!;
const summaryOf = (result: PlanResult, month: MonthKey) => result.summary[result.months.indexOf(month)]!;

describe.skipIf(!TEST_DATABASE_URL)("goals", () => {
  let t: TestDb;
  let S: PlanSeed;
  let vacationCategory: string;
  let vacationGoal: string;

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedPlanFixture(t.db);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("lists the seed goal with progress and per-month history from the start month", async () => {
    const goals = await listGoals(t.db, { today: PLAN_SEED_TODAY });
    expect(goals).toHaveLength(1);
    const ef = goals[0]!;
    expect(ef).toMatchObject({
      id: S.goals.emergencyFund,
      name: "Emergency Fund",
      categoryId: S.categories.emergencyFund,
      categoryName: "Emergency Fund",
      targetCents: 1000000n,
      targetDate: "2027-09-30",
      linkedAccountId: S.accounts.savings,
      linkedAccountName: "Savings",
      monthlyContributionCents: 50000n,
      startMonth: "2026-09",
      startingCents: 200000n,
      status: "active",
      progress: { savedCents: 280000n, remainingToTargetCents: 720000n, monthsLeft: 12, neededPerMonthCents: 60000n, projectedCompletionMonth: "2028-01", onTrack: false, progressBp: 2800 },
    });
    expect(ef.history).toEqual([
      { month: "2026-09", actualCents: 50000n, plannedCents: 50000n },
      { month: "2026-10", actualCents: 30000n, plannedCents: 50000n },
    ]);
    expect(ef.createdAt).toBeInstanceOf(Date);
    expect(await getGoal(t.db, randomUUID(), { today: PLAN_SEED_TODAY })).toBeUndefined();
  });

  it("creates a goal on a new savings category and auto-plans its contribution from the start month", async () => {
    const vacation = await createCategory(t.db, { name: "Vacation", bucket: "savings" }, ctx());
    vacationCategory = vacation.id;
    expect(vacation).toMatchObject({ bucket: "savings", groupId: null, position: 2, goalId: null });

    const goal = await createGoal(
      t.db,
      { name: "Vacation", categoryId: vacation.id, targetCents: 300000n, targetDate: "2027-06-30", monthlyContributionCents: 25000n, startMonth: "2026-10" },
      ctx(),
    );
    vacationGoal = goal.id;
    expect(goal).toMatchObject({
      name: "Vacation",
      categoryId: vacation.id,
      categoryName: "Vacation",
      linkedAccountId: null,
      linkedAccountName: null,
      startingCents: 0n,
      progress: { savedCents: 0n, remainingToTargetCents: 300000n, monthsLeft: 9, neededPerMonthCents: 33334n, projectedCompletionMonth: "2027-10", onTrack: false, progressBp: 0 },
    });
    expect(goal.history).toEqual([{ month: "2026-10", actualCents: 0n, plannedCents: 25000n }]);
    expect((await listCategories(t.db)).find((c) => c.id === vacation.id)?.goalId).toBe(goal.id);

    const plan = await getPlan(t.db, RANGE);
    const savingsRows = plan.rows.filter((r) => r.bucket === "savings").map((r) => (r.kind === "category" ? r.name : r.kind));
    expect(savingsRows).toEqual(["bucket", "Emergency Fund", "Vacation"]);
    expect(cell(plan, vacation.id, "2026-09")).toMatchObject({ plannedCents: 0n, source: "none" });
    for (const m of ["2026-10", "2026-11", "2026-12", "2027-01"]) expect(cell(plan, vacation.id, m)).toMatchObject({ plannedCents: 25000n, source: "goal" });
    expect(catRow(plan, vacation.id).goal?.id).toBe(goal.id);
    expect(summaryOf(plan, "2026-10")).toMatchObject({ leftToSpendCents: 150352n, toAssignCents: 150452n });

    const audit = await listAudit(t.db, { entity: "savings_goal", entityId: goal.id, limit: 5 });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ action: "create", before: null });
    expect(audit.items[0]!.after).toMatchObject({ targetCents: "300000", monthlyContributionCents: "25000", startMonth: "2026-10" });
  });

  it("rejects a goal on a non-savings category and a second goal on the same category", async () => {
    await expect(createGoal(t.db, { name: "Bad", categoryId: S.categories.groceries, targetCents: 1000n }, ctx())).rejects.toMatchObject({ status: 400, code: "goal_category" });
    await expect(createGoal(t.db, { name: "Dupe", categoryId: S.categories.emergencyFund, targetCents: 1000n }, ctx())).rejects.toMatchObject({ status: 409, code: "conflict" });
    await expect(createGoal(t.db, { name: "Zero", categoryId: vacationCategory, targetCents: 0n }, ctx())).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(createGoal(t.db, { name: "Both", categoryId: vacationCategory, newCategory: { name: "X" }, targetCents: 1n }, ctx())).rejects.toMatchObject({ status: 400 });
    await expect(createGoal(t.db, { name: "Missing", categoryId: randomUUID(), targetCents: 1n }, ctx())).rejects.toMatchObject({ status: 404 });
  });

  it("updates a goal: contribution, link, target date and status flow into the plan", async () => {
    const updated = await updateGoal(t.db, vacationGoal, { monthlyContributionCents: 30000n, linkedAccountId: S.accounts.visa, targetDate: null }, ctx());
    expect(updated).toMatchObject({ monthlyContributionCents: 30000n, linkedAccountId: S.accounts.visa, linkedAccountName: "Visa", targetDate: null });
    // saved 30000, remaining 270000, ceil(270000 / 30000) = 9 months after 2026-10.
    expect(updated.progress).toMatchObject({ monthsLeft: null, neededPerMonthCents: null, onTrack: null, projectedCompletionMonth: "2027-07" });
    // The card payment leg in Visa (+30000 on 10-08) now counts as the goal's net transfers.
    expect(updated.history).toEqual([{ month: "2026-10", actualCents: 30000n, plannedCents: 30000n }]);
    expect(updated.progress.savedCents).toBe(30000n);

    const paused = await updateGoal(t.db, vacationGoal, { status: "archived", linkedAccountId: null }, ctx());
    expect(paused.status).toBe("archived");
    const plan = await getPlan(t.db, RANGE);
    expect(cell(plan, vacationCategory, "2026-11")).toMatchObject({ plannedCents: 0n, source: "none" });
    await updateGoal(t.db, vacationGoal, { status: "active" }, ctx());
    expect(cell(await getPlan(t.db, RANGE), vacationCategory, "2026-11")).toMatchObject({ plannedCents: 30000n, source: "goal" });

    await expect(updateGoal(t.db, vacationGoal, { categoryId: S.categories.emergencyFund }, ctx())).rejects.toMatchObject({ status: 409 });
    await expect(updateGoal(t.db, randomUUID(), { name: "x" }, ctx())).rejects.toMatchObject({ status: 404 });
    const audit = await listAudit(t.db, { entity: "savings_goal", entityId: vacationGoal, limit: 10 });
    expect(audit.items.map((e) => e.action)).toEqual(["update", "update", "update", "create"]);
  });

  it("creates a goal together with a new category and starts it in the current month by default", async () => {
    const goal = await createGoal(t.db, { name: "New Car", newCategory: { name: "New Car" }, targetCents: 1500000n, startingCents: 100000n }, ctx());
    expect(goal).toMatchObject({ categoryName: "New Car", startMonth: "2026-10", startingCents: 100000n, monthlyContributionCents: 0n });
    expect(goal.progress).toMatchObject({ savedCents: 100000n, remainingToTargetCents: 1400000n, progressBp: 666, projectedCompletionMonth: null });
    const cat = (await listCategories(t.db)).find((c) => c.name === "New Car");
    expect(cat).toMatchObject({ bucket: "savings", goalId: goal.id });
    await expect(createGoal(t.db, { name: "Clash", newCategory: { name: "Groceries" }, targetCents: 1n }, ctx())).rejects.toMatchObject({ status: 409 });
    await deleteGoal(t.db, goal.id, ctx());
  });

  it("deleting a goal keeps the category and reverts its planned cells to 0", async () => {
    await deleteGoal(t.db, vacationGoal, ctx());
    expect(await getGoal(t.db, vacationGoal, { today: PLAN_SEED_TODAY })).toBeUndefined();
    const plan = await getPlan(t.db, RANGE);
    expect(catRow(plan, vacationCategory).goal).toBeNull();
    for (const m of ["2026-10", "2026-11"]) expect(cell(plan, vacationCategory, m)).toMatchObject({ plannedCents: 0n, source: "none" });
    expect(summaryOf(plan, "2026-10").leftToSpendCents).toBe(175352n);
    expect((await listAudit(t.db, { entity: "savings_goal", entityId: vacationGoal, limit: 1 })).items[0]).toMatchObject({ action: "delete", after: null });
    await expect(deleteGoal(t.db, vacationGoal, ctx())).rejects.toMatchObject({ status: 404 });
    expect((await listGoals(t.db, { today: PLAN_SEED_TODAY })).map((g) => g.name)).toEqual(["Emergency Fund"]);
  });

  it("a goal starting in the future has empty history and progress = starting cents", async () => {
    const goal = await createGoal(t.db, { name: "Later", categoryId: vacationCategory, targetCents: 50000n, startMonth: "2027-01", startingCents: 5000n, monthlyContributionCents: 1000n }, ctx());
    expect(goal.history).toEqual([]);
    expect(goal.progress).toMatchObject({ savedCents: 5000n, remainingToTargetCents: 45000n, projectedCompletionMonth: "2030-07" });
    const plan = await getPlan(t.db, RANGE);
    expect(cell(plan, vacationCategory, "2026-12")).toMatchObject({ plannedCents: 0n, source: "none" });
    expect(cell(plan, vacationCategory, "2027-01")).toMatchObject({ plannedCents: 1000n, source: "goal" });
  });

  it("a goal that started years ago gets its full history (beyond the grid's 24-month cap)", async () => {
    const goals = await listGoals(t.db, { today: PLAN_SEED_TODAY });
    const later = goals.find((g) => g.name === "Later")!;
    const old = await updateGoal(t.db, later.id, { startMonth: "2024-01" }, ctx());
    expect(old.history).toHaveLength(34);
    expect(old.history[0]).toEqual({ month: "2024-01", actualCents: 0n, plannedCents: 1000n });
    expect(old.history[33]).toEqual({ month: "2026-10", actualCents: 0n, plannedCents: 1000n });
    expect(old.progress.savedCents).toBe(5000n);
    await expect(getPlan(t.db, { from: "2024-01", to: "2026-10", today: PLAN_SEED_TODAY })).rejects.toMatchObject({ status: 400 });
  });
});
