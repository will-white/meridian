import { randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "@meridian/db/testing";
import type { GoalView, PlanCellView, PlanResponse, PlanRow } from "@meridian/shared";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";

/** Goal CRUD and its effect on the plan (grid-and-api design, "Goal CRUD and its effect on the plan"). */

const TODAY = PLAN_SEED_TODAY;
const serverClock = () => new Date(`${TODAY}T18:00:00Z`);

type CategoryRowView = Extract<PlanRow, { kind: "category" }>;

async function freshApp(): Promise<{ t: TestApp; S: PlanSeed }> {
  const t = await createTestApp({ now: serverClock });
  const S = await seedPlanFixture(t.db.db);
  await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
  const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
  const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
  await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
  return { t, S };
}

async function getPlan(t: TestApp): Promise<PlanResponse> {
  const res = await t.call({ method: "GET", url: `/api/plan?today=${TODAY}` });
  expect(res.statusCode).toBe(200);
  return res.json() as PlanResponse;
}

function catRow(plan: PlanResponse, categoryId: string): CategoryRowView {
  const r = plan.rows.find((x): x is CategoryRowView => x.kind === "category" && x.categoryId === categoryId);
  if (!r) throw new Error(`no row for ${categoryId}`);
  return r;
}

function cellOf(plan: PlanResponse, categoryId: string, month: string): PlanCellView {
  const c = catRow(plan, categoryId).cells[plan.months.indexOf(month)];
  if (!c) throw new Error(`no cell ${categoryId} ${month}`);
  return c;
}

const brief = (c: PlanCellView) => [c.plannedCents, c.carriedInCents, c.actualCents, c.remainingCents, c.source];
const rowOrder = (plan: PlanResponse, bucket: string) =>
  plan.rows.filter((r) => r.bucket === bucket).map((r) => (r.kind === "bucket" ? `bucket:${r.bucket}` : r.kind === "group" ? `group:${r.name}` : r.name));

describe.skipIf(!TEST_DATABASE_URL)("goals API", () => {
  let t: TestApp;
  let S: PlanSeed;
  let C: PlanSeed["categories"];
  let vacationCategoryId: string;
  let vacationGoalId: string;

  beforeAll(async () => {
    ({ t, S } = await freshApp());
    C = S.categories;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("lists the seeded goal with progress and month history", async () => {
    const res = await t.call({ method: "GET", url: `/api/goals?today=${TODAY}` });
    expect(res.statusCode).toBe(200);
    const goals = res.json() as GoalView[];
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      id: S.goals.emergencyFund,
      name: "Emergency Fund",
      categoryId: C.emergencyFund,
      categoryName: "Emergency Fund",
      targetCents: "1000000",
      targetDate: "2027-09-30",
      linkedAccountId: S.accounts.savings,
      linkedAccountName: "Savings",
      monthlyContributionCents: "50000",
      startMonth: "2026-09",
      startingCents: "200000",
      status: "active",
      progress: { savedCents: "280000", remainingToTargetCents: "720000", monthsLeft: 12, neededPerMonthCents: "60000", projectedCompletionMonth: "2028-01", onTrack: false, progressBp: 2800 },
      history: [
        { month: "2026-09", actualCents: "50000", plannedCents: "50000" },
        { month: "2026-10", actualCents: "30000", plannedCents: "50000" },
      ],
    });
    expect(goals[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const one = await t.call({ method: "GET", url: `/api/goals/${S.goals.emergencyFund}` });
    expect(one.json().progress.savedCents).toBe("280000");
    expect((await t.call({ method: "GET", url: `/api/goals/${randomUUID()}` })).statusCode).toBe(404);
  });

  it("creates a goal on a new savings category and auto-plans its contribution", async () => {
    const category = await t.call({ method: "POST", url: "/api/categories", payload: { name: "Vacation", bucket: "savings" } });
    expect(category.statusCode).toBe(200);
    expect(category.json()).toMatchObject({ name: "Vacation", bucket: "savings", groupId: null, position: 2, rolloverMode: "none", rolloverFromMonth: null, goalId: null });
    vacationCategoryId = category.json().id;

    const created = await t.call({
      method: "POST",
      url: "/api/goals",
      payload: { name: "Vacation", categoryId: vacationCategoryId, targetCents: "300000", targetDate: "2027-06-30", monthlyContributionCents: "25000", startMonth: "2026-10" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      name: "Vacation",
      categoryId: vacationCategoryId,
      categoryName: "Vacation",
      targetCents: "300000",
      linkedAccountId: null,
      linkedAccountName: null,
      startingCents: "0",
      progress: { savedCents: "0", remainingToTargetCents: "300000", monthsLeft: 9, neededPerMonthCents: "33334", projectedCompletionMonth: "2027-10", onTrack: false, progressBp: 0 },
      history: [{ month: "2026-10", actualCents: "0", plannedCents: "25000" }],
    });
    vacationGoalId = created.json().id;
    const categories = await t.call({ method: "GET", url: "/api/categories" });
    expect(categories.json().find((c: { id: string }) => c.id === vacationCategoryId).goalId).toBe(vacationGoalId);

    const plan = await getPlan(t);
    expect(rowOrder(plan, "savings")).toEqual(["bucket:savings", "Emergency Fund", "Vacation"]);
    expect(catRow(plan, vacationCategoryId).goal).toMatchObject({ id: vacationGoalId, progress: { neededPerMonthCents: "33334" } });
    expect(brief(cellOf(plan, vacationCategoryId, "2026-09"))).toEqual(["0", "0", "0", "0", "none"]);
    for (const m of ["2026-10", "2026-11", "2026-12", "2027-01"]) expect(brief(cellOf(plan, vacationCategoryId, m))).toEqual(["25000", "0", "0", "25000", "goal"]);
    const oct = plan.summary[plan.months.indexOf("2026-10")]!;
    expect(oct).toMatchObject({ leftToSpendCents: "150352", toAssignCents: "150452" });
    expect(oct.committed.savings).toBe("75000");

    const audit = await t.call({ method: "GET", url: `/api/audit?entity=savings_goal&entityId=${vacationGoalId}` });
    expect(audit.json().items).toHaveLength(1);
    expect(audit.json().items[0]).toMatchObject({ action: "create", before: null, after: { name: "Vacation", targetCents: "300000", monthlyContributionCents: "25000" } });
  });

  it("patches a goal: a bigger contribution puts it on track and pulls the projection in", async () => {
    const res = await t.call({ method: "PATCH", url: `/api/goals/${vacationGoalId}`, payload: { monthlyContributionCents: "40000" } });
    expect(res.statusCode).toBe(200);
    // ceil(300000 / 40000) = 8 months after 2026-10; 40000 >= the 33334 needed.
    expect(res.json()).toMatchObject({ monthlyContributionCents: "40000", progress: { neededPerMonthCents: "33334", projectedCompletionMonth: "2027-06", onTrack: true } });

    // Linking Checking counts its net transfer legs: Oct −50000 + 20000 − 30000 = −60000, so the target moves 360000 away.
    const linked = await t.call({ method: "PATCH", url: `/api/goals/${vacationGoalId}`, payload: { linkedAccountId: S.accounts.checking } });
    expect(linked.json()).toMatchObject({
      linkedAccountId: S.accounts.checking,
      linkedAccountName: "Checking",
      progress: { savedCents: "-60000", remainingToTargetCents: "360000", neededPerMonthCents: "40000", projectedCompletionMonth: "2027-07", onTrack: true, progressBp: 0 },
    });
    const unlinked = await t.call({ method: "PATCH", url: `/api/goals/${vacationGoalId}`, payload: { linkedAccountId: null } });
    expect(unlinked.json()).toMatchObject({ linkedAccountId: null, linkedAccountName: null, progress: { savedCents: "0", remainingToTargetCents: "300000" } });

    const audit = await t.call({ method: "GET", url: `/api/audit?entity=savings_goal&entityId=${vacationGoalId}` });
    expect(audit.json().items.map((e: { action: string }) => e.action)).toEqual(["update", "update", "update", "create"]);
    expect(audit.json().items[2]).toMatchObject({ before: { monthlyContributionCents: "25000" }, after: { monthlyContributionCents: "40000" } });
    expect(audit.json().items[1]).toMatchObject({ before: { linkedAccountId: null }, after: { linkedAccountId: S.accounts.checking } });

    expect((await t.call({ method: "PATCH", url: `/api/goals/${vacationGoalId}`, payload: { targetCents: "0" } })).statusCode).toBe(400);
    expect((await t.call({ method: "PATCH", url: `/api/goals/${vacationGoalId}`, payload: { categoryId: C.groceries } })).statusCode).toBe(400);
    expect((await t.call({ method: "PATCH", url: `/api/goals/${vacationGoalId}`, payload: { categoryId: C.emergencyFund } })).statusCode).toBe(409);
    expect((await t.call({ method: "PATCH", url: `/api/goals/${vacationGoalId}`, payload: { linkedAccountId: randomUUID() } })).statusCode).toBe(400);
    expect((await t.call({ method: "PATCH", url: `/api/goals/${randomUUID()}`, payload: { name: "x" } })).statusCode).toBe(404);
  });

  it("creates a category and its goal in one call", async () => {
    const res = await t.call({ method: "POST", url: "/api/goals", payload: { name: "Car", newCategory: { name: "Car Fund" }, targetCents: "500000" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Car", categoryName: "Car Fund", monthlyContributionCents: "0", startMonth: "2026-10", progress: { monthsLeft: null, neededPerMonthCents: null, projectedCompletionMonth: null, onTrack: null } });
    const categories = await t.call({ method: "GET", url: "/api/categories" });
    expect(categories.json().find((c: { name: string }) => c.name === "Car Fund")).toMatchObject({ bucket: "savings", position: 3, goalId: res.json().id });
    const both = await t.call({ method: "POST", url: "/api/goals", payload: { name: "x", categoryId: C.emergencyFund, newCategory: { name: "y" }, targetCents: "1" } });
    expect(both.statusCode).toBe(400);
    const withGroup = await t.call({ method: "POST", url: "/api/goals", payload: { name: "x", newCategory: { name: "Boat", groupId: S.groups.housing }, targetCents: "1" } });
    expect(withGroup.statusCode).toBe(400);
    expect(withGroup.json().code).toBe("bucket_mismatch");
  });

  it("deleting a goal keeps the category and reverts its planned cells", async () => {
    const res = await t.call({ method: "DELETE", url: `/api/goals/${vacationGoalId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const plan = await getPlan(t);
    expect(catRow(plan, vacationCategoryId).goal).toBeNull();
    for (const m of plan.months) expect(brief(cellOf(plan, vacationCategoryId, m))).toEqual(["0", "0", "0", "0", "none"]);
    expect(plan.summary[plan.months.indexOf("2026-10")]!.leftToSpendCents).toBe("175352");
    expect((await t.call({ method: "GET", url: "/api/goals" })).json().map((g: { name: string }) => g.name)).toEqual(["Car", "Emergency Fund"]);
    const audit = await t.call({ method: "GET", url: `/api/audit?entity=savings_goal&entityId=${vacationGoalId}` });
    expect(audit.json().items[0]).toMatchObject({ action: "delete", after: null, before: { name: "Vacation" } });
    expect((await t.call({ method: "DELETE", url: `/api/goals/${vacationGoalId}` })).statusCode).toBe(404);
  });

  it("rejects a goal on a non-savings category and a second goal on the same category", async () => {
    const groceries = await t.call({ method: "POST", url: "/api/goals", payload: { name: "x", categoryId: C.groceries, targetCents: "100" } });
    expect(groceries.statusCode).toBe(400);
    expect(groceries.json()).toMatchObject({ code: "goal_category", error: "Goals need a savings category" });
    const second = await t.call({ method: "POST", url: "/api/goals", payload: { name: "x", categoryId: C.emergencyFund, targetCents: "100" } });
    expect(second.statusCode).toBe(409);
    expect((await t.call({ method: "POST", url: "/api/goals", payload: { name: "x", categoryId: C.emergencyFund, targetCents: "0" } })).statusCode).toBe(400);
    expect((await t.call({ method: "POST", url: "/api/goals", payload: { name: "x", categoryId: randomUUID(), targetCents: "100" } })).statusCode).toBe(404);
    expect((await t.call({ method: "POST", url: "/api/goals", payload: { name: "x", categoryId: C.emergencyFund, targetCents: "-5" } })).statusCode).toBe(400);
  });
});
