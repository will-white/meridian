import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MonthKey, PlanCategoryRowResult, PlanCell, PlanResult } from "@meridian/shared";
import { auditLog, monthPlan, recurring, savingsGoal, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "../test/planSeed.js";
import { listAudit } from "./audit.js";
import { updateCategory } from "./categories.js";
import { closeMonth } from "./closeMonth.js";
import { deleteGoal, listGoals } from "./goals.js";
import { getPlan, planAverages, setPlanCells } from "./plan.js";
import { updateHouseholdSetting } from "./settings.js";

const RANGE = { from: "2026-08", to: "2027-01", today: PLAN_SEED_TODAY };

function catRow(result: PlanResult, categoryId: string): PlanCategoryRowResult {
  const r = result.rows.find((x): x is PlanCategoryRowResult => x.kind === "category" && x.categoryId === categoryId);
  if (!r) throw new Error(`no row for ${categoryId}`);
  return r;
}
function cellOf(result: PlanResult, categoryId: string, month: MonthKey): PlanCell {
  const c = catRow(result, categoryId).cells[result.months.indexOf(month)];
  if (!c) throw new Error(`no cell ${categoryId} ${month}`);
  return c;
}
function summaryOf(result: PlanResult, month: MonthKey) {
  const s = result.summary[result.months.indexOf(month)];
  if (!s) throw new Error(`no summary for ${month}`);
  return s;
}
const ctx = (batchId = randomUUID()) => ({ userId: null, batchId });

describe.skipIf(!TEST_DATABASE_URL)("plan review probes", () => {
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

  it("R1 audit equality: re-sending the same per-month rollover override writes nothing", async () => {
    const a = await setPlanCells(t.db, [{ month: "2026-09", categoryId: C.dining, rolloverMode: "all" }], ctx());
    expect(a.changed).toBe(1);
    const b = await setPlanCells(t.db, [{ month: "2026-09", categoryId: C.dining, rolloverMode: "all" }], ctx());
    expect(b.changed).toBe(0);
    const audit = await listAudit(t.db, { entity: "month_plan", entityId: `2026-09:${C.dining}`, limit: 10 });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]!.after).toMatchObject({ plannedCents: "20000", source: "manual", rolloverMode: "all" });
  });

  it("R2 per-month override decides the carry OUT of that month only (Dining Sep 'all' → Oct −6000; Oct stays category 'surplus' → Nov 0)", async () => {
    const plan = await getPlan(t.db, RANGE);
    expect(cellOf(plan, C.dining, "2026-09").rolloverMode).toBe("all");
    expect(cellOf(plan, C.dining, "2026-10")).toMatchObject({ carriedInCents: -6000n, carriedInSource: "chain", remainingCents: -6000n, committedCents: 20000n, rolloverMode: "surplus" });
    expect(cellOf(plan, C.dining, "2026-11")).toMatchObject({ carriedInCents: 0n });
    // LTS unchanged by the carry: Oct committed = max(14000, 20000) - 0 = 20000.
    expect(summaryOf(plan, "2026-10").leftToSpendCents).toBe(175352n);
    // Clean up.
    await setPlanCells(t.db, [{ month: "2026-09", categoryId: C.dining, rolloverMode: null }], ctx());
  });

  it("R3 a per-month override on a 'none' category carries from the household start month", async () => {
    await setPlanCells(t.db, [{ month: "2026-10", categoryId: C.fuel, rolloverMode: "surplus" }], ctx());
    const plan = await getPlan(t.db, RANGE);
    expect(cellOf(plan, C.fuel, "2026-10")).toMatchObject({ remainingCents: 9500n, rolloverMode: "surplus" });
    expect(cellOf(plan, C.fuel, "2026-11")).toMatchObject({ carriedInCents: 9500n, carriedInSource: "chain", rolloverMode: "none" });
    expect(cellOf(plan, C.fuel, "2026-12")).toMatchObject({ carriedInCents: 0n });
    await setPlanCells(t.db, [{ month: "2026-10", categoryId: C.fuel, rolloverMode: null }], ctx());
  });

  it("R4 income: carried-in override and per-month mode rejected; clearing (null) allowed", async () => {
    await expect(setPlanCells(t.db, [{ month: "2026-10", categoryId: C.paycheck, carriedInOverrideCents: 1000n }], ctx())).rejects.toMatchObject({ status: 400, code: "income_no_rollover" });
    await expect(setPlanCells(t.db, [{ month: "2026-10", categoryId: C.paycheck, rolloverMode: "surplus" }], ctx())).rejects.toMatchObject({ status: 400, code: "income_no_rollover" });
    const r = await setPlanCells(t.db, [{ month: "2026-10", categoryId: C.paycheck, rolloverMode: null, carriedInOverrideCents: null }], ctx());
    expect(r.changed).toBe(0);
  });

  it("R5 range boundaries: 24 months ok, 25 rejected, inverted rejected", async () => {
    await expect(getPlan(t.db, { from: "2026-01", to: "2027-12", today: PLAN_SEED_TODAY })).resolves.toBeTruthy();
    await expect(getPlan(t.db, { from: "2026-01", to: "2028-01", today: PLAN_SEED_TODAY })).rejects.toMatchObject({ status: 400 });
    await expect(getPlan(t.db, { from: "2026-10", to: "2026-09", today: PLAN_SEED_TODAY })).rejects.toMatchObject({ status: 400 });
  });

  it("R6 averages: asOf before the current month shrinks the window; partial current month excluded by default", async () => {
    const sep = await planAverages(t.db, { months: 3, asOf: "2026-09", today: PLAN_SEED_TODAY });
    expect(sep.window).toEqual({ from: "2026-06", to: "2026-08", monthsWithData: 1 });
    expect(sep.averages.find((a) => a.categoryId === C.groceries)!.averageCents).toBe(7000n);
    const def = await planAverages(t.db, { months: 3, today: PLAN_SEED_TODAY });
    expect(def.window).toEqual({ from: "2026-07", to: "2026-09", monthsWithData: 2 });
  });

  it("R7 close_month: a deleted goal's frozen rows persist, the re-run inserts 0, and live months revert", async () => {
    const first = await closeMonth(t.db, "2026-09", { today: PLAN_SEED_TODAY });
    expect(first.inserted).toBe(4);
    const again = await closeMonth(t.db, "2026-09", { today: PLAN_SEED_TODAY });
    expect(again.inserted).toBe(0);
    await deleteGoal(t.db, S.goals.emergencyFund, ctx());
    const third = await closeMonth(t.db, "2026-09", { today: PLAN_SEED_TODAY });
    expect(third.inserted).toBe(0);
    const plan = await getPlan(t.db, RANGE);
    expect(cellOf(plan, C.emergencyFund, "2026-09")).toMatchObject({ plannedCents: 50000n, source: "goal", hasExplicitPlan: true });
    expect(cellOf(plan, C.emergencyFund, "2026-10")).toMatchObject({ plannedCents: 0n, source: "none" });
    // Goal net is gone with the goal: Oct actual is only the categorized rows (none).
    expect(cellOf(plan, C.emergencyFund, "2026-10").actualCents).toBe(0n);
    expect(await listGoals(t.db, { today: PLAN_SEED_TODAY })).toHaveLength(0);
  });

  it("R8 audit cursor pagination neither skips nor repeats", async () => {
    const all = await listAudit(t.db, { limit: 200 });
    const ids: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await listAudit(t.db, { limit: 2, ...(cursor ? { cursor } : {}) });
      ids.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(ids).toEqual(all.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("R9 moving the plan start later restarts every chain and freezes nothing before it", async () => {
    await updateHouseholdSetting(t.db, { planStartMonth: "2026-10" }, ctx());
    const plan = await getPlan(t.db, RANGE);
    expect(cellOf(plan, C.groceries, "2026-09")).toMatchObject({ carriedInCents: 0n, carriedInSource: "none", rolloverMode: "none" });
    expect(cellOf(plan, C.groceries, "2026-10")).toMatchObject({ carriedInCents: 0n, carriedInSource: "start", remainingCents: -4500n });
    expect(cellOf(plan, C.groceries, "2026-11")).toMatchObject({ carriedInCents: -4500n, carriedInSource: "chain" });
    // A row before the (new) start can no longer be cleared.
    await expect(setPlanCells(t.db, [{ month: "2026-09", categoryId: C.groceries, plannedCents: null }], ctx())).rejects.toMatchObject({ code: "before_plan_start" });
    expect((await closeMonth(t.db, "2026-09", { today: PLAN_SEED_TODAY })).inserted).toBe(0);
    await updateHouseholdSetting(t.db, { planStartMonth: "2026-08" }, ctx());
  });

  it("R10 rollover_from_month before the plan start is clamped by the engine; API refuses to set it", async () => {
    await expect(updateCategory(t.db, C.fuel, { rolloverMode: "all", rolloverFromMonth: "2026-07" }, { ...ctx(), today: PLAN_SEED_TODAY })).rejects.toMatchObject({ code: "before_plan_start" });
    const row = await updateCategory(t.db, C.fuel, { rolloverMode: "all", rolloverFromMonth: "2026-08" }, { ...ctx(), today: PLAN_SEED_TODAY });
    expect(row).toMatchObject({ rolloverMode: "all", rolloverFromMonth: "2026-08" });
    const plan = await getPlan(t.db, RANGE);
    // Fuel: Aug 0 (start), Sep carriedIn 0 (Aug remaining 0), Oct carriedIn -6000, Nov carriedIn 9500-6000 = 3500
    expect(cellOf(plan, C.fuel, "2026-09")).toMatchObject({ carriedInCents: 0n, carriedInSource: "chain" });
    expect(cellOf(plan, C.fuel, "2026-10")).toMatchObject({ carriedInCents: -6000n, committedCents: 9000n });
    expect(cellOf(plan, C.fuel, "2026-11")).toMatchObject({ carriedInCents: 3500n });
    await updateCategory(t.db, C.fuel, { rolloverMode: "none" }, { ...ctx(), today: PLAN_SEED_TODAY });
  });

  it("R11 a manual 0 suppresses the auto value; a frozen row re-typed with the same value becomes manual", async () => {
    await setPlanCells(t.db, [{ month: "2026-11", categoryId: C.rent, plannedCents: 0n }], ctx());
    let plan = await getPlan(t.db, RANGE);
    expect(cellOf(plan, C.rent, "2026-11")).toMatchObject({ plannedCents: 0n, source: "manual", hasExplicitPlan: true });
    expect(summaryOf(plan, "2026-11").planned.bills).toBe(9548n);
    await setPlanCells(t.db, [{ month: "2026-11", categoryId: C.rent, plannedCents: null }], ctx());
    const r = await setPlanCells(t.db, [{ month: "2026-09", categoryId: C.rent, plannedCents: 180000n }], ctx());
    expect(r.changed).toBe(1);
    plan = await getPlan(t.db, RANGE);
    expect(cellOf(plan, C.rent, "2026-09")).toMatchObject({ plannedCents: 180000n, source: "manual" });
  });

  it("R12 a recurring item cancelled before close_month loses its past auto value (no occurrences while not active)", async () => {
    // Internet was charged in Sep (-7999, linked) but is not frozen yet: Oct is live.
    await t.db.update(recurring).set({ status: "cancelled" }).where(eq(recurring.id, S.recurring.internet));
    const plan = await getPlan(t.db, RANGE);
    expect(cellOf(plan, C.internet, "2026-10")).toMatchObject({ plannedCents: 0n, source: "none" });
    await t.db.update(recurring).set({ status: "active" }).where(eq(recurring.id, S.recurring.internet));
  });

  it("R13 goal with a categorized inflow in the linked account: inflow counts against progress (bucket-natural)", async () => {
    const [goal] = await t.db
      .insert(savingsGoal)
      .values({ name: "EF2", categoryId: C.emergencyFund, targetCents: 1000000n, linkedAccountId: S.accounts.savings, monthlyContributionCents: 0n, startMonth: "2026-09", startingCents: 0n })
      .returning({ id: savingsGoal.id });
    await t.db.insert(transaction).values({
      accountId: S.accounts.savings,
      externalId: "REVIEW-INT",
      source: "manual",
      date: "2026-10-05",
      amountCents: 100n,
      rawDescription: "INTEREST",
      categoryId: C.emergencyFund,
      isTransfer: false,
    });
    const plan = await getPlan(t.db, RANGE);
    expect(cellOf(plan, C.emergencyFund, "2026-10").actualCents).toBe(30000n - 100n);
    await t.db.delete(transaction).where(eq(transaction.externalId, "REVIEW-INT"));
    await t.db.delete(savingsGoal).where(eq(savingsGoal.id, goal!.id));
  });

  it("R14 clearing a cell before the plan start that has no row is rejected rather than ignored", async () => {
    const rows = await t.db.select().from(monthPlan).where(eq(monthPlan.month, "2026-07"));
    expect(rows).toHaveLength(0);
    await expect(setPlanCells(t.db, [{ month: "2026-07", categoryId: C.groceries, plannedCents: null }], ctx())).rejects.toMatchObject({ code: "before_plan_start" });
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, `2026-07:${C.groceries}`));
    expect(audits).toHaveLength(0);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("plan review probes: settings and audit", () => {
  let t: TestDb;
  let S: PlanSeed;

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedPlanFixture(t.db);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("R15 an unchanged category patch writes no audit row", async () => {
    await updateCategory(t.db, S.categories.fuel, { name: "Fuel", hidden: false }, { ...ctx(), today: PLAN_SEED_TODAY });
    const audit = await listAudit(t.db, { entity: "category", entityId: S.categories.fuel, limit: 10 });
    expect(audit.items).toHaveLength(0);
  });

  it("R16 moving plan_start_month earlier enqueues plan.close_month so the newly covered months freeze", async () => {
    const { job } = await import("../schema/index.js");
    await updateHouseholdSetting(t.db, { planStartMonth: "2026-06" }, ctx());
    const jobs = await t.db.select().from(job);
    expect(jobs.map((j) => j.type)).toEqual(["plan.close_month"]);
  });
});
