import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MonthKey, PlanCategoryRowResult, PlanResult } from "@meridian/shared";
import { monthPlan, recurring, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "../test/planSeed.js";
import { closeMonth } from "./closeMonth.js";
import { getPlan, setPlanCells } from "./plan.js";

const RANGE = { from: "2026-08", to: "2026-12", today: PLAN_SEED_TODAY };
/** The nightly close of October runs in early November. */
const NOV_2 = "2026-11-02";

function cell(result: PlanResult, categoryId: string, month: MonthKey) {
  const r = result.rows.find((x): x is PlanCategoryRowResult => x.kind === "category" && x.categoryId === categoryId);
  return r!.cells[result.months.indexOf(month)]!;
}

describe.skipIf(!TEST_DATABASE_URL)("plan.close_month", () => {
  let t: TestDb;
  let S: PlanSeed;

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedPlanFixture(t.db);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  async function frozenRows() {
    return t.db
      .select({ categoryId: monthPlan.categoryId, month: monthPlan.month, plannedCents: monthPlan.plannedCents, plannedSource: monthPlan.plannedSource })
      .from(monthPlan)
      .where(eq(monthPlan.plannedSource, "recurring"))
      .orderBy(asc(monthPlan.month));
  }

  it("T19: freezes the auto values once; a re-run inserts nothing; manual rows are never overwritten", async () => {
    expect(await closeMonth(t.db, "2026-07", { today: PLAN_SEED_TODAY })).toEqual({ inserted: 0, through: "2026-07" });

    // Aug has nothing to freeze (bills first seen in Sep, goal starts in Sep); Sep freezes Rent, Netflix, Internet and the goal.
    expect(await closeMonth(t.db, "2026-09", { today: PLAN_SEED_TODAY })).toEqual({ inserted: 4, through: "2026-09" });
    const C = S.categories;
    const rows = await t.db.select().from(monthPlan).where(eq(monthPlan.month, "2026-09"));
    const byCategory = Object.fromEntries(rows.map((r) => [r.categoryId, [r.plannedCents, r.plannedSource]]));
    expect(byCategory[C.rent]).toEqual([180000n, "recurring"]);
    expect(byCategory[C.netflix]).toEqual([1549n, "recurring"]);
    expect(byCategory[C.internet]).toEqual([7999n, "recurring"]);
    expect(byCategory[C.emergencyFund]).toEqual([50000n, "goal"]);
    expect(byCategory[C.paycheck]).toEqual([500000n, "manual"]);
    expect(byCategory[C.groceries]).toEqual([50000n, "manual"]);
    expect(rows.filter((r) => r.month === "2026-09")).toHaveLength(7);
    expect(await t.db.select().from(monthPlan).where(eq(monthPlan.month, "2026-08"))).toHaveLength(0);

    expect(await closeMonth(t.db, "2026-09", { today: PLAN_SEED_TODAY })).toEqual({ inserted: 0, through: "2026-09" });

    // Only completed months freeze: on Oct 13 a request through October stops at September.
    expect(await closeMonth(t.db, "2026-10", { today: PLAN_SEED_TODAY })).toEqual({ inserted: 0, through: "2026-10" });
    expect(await t.db.select().from(monthPlan).where(eq(monthPlan.plannedSource, "recurring"))).toHaveLength(3);

    // A manual override set before the freeze survives it.
    await setPlanCells(t.db, [{ month: "2026-10", categoryId: C.internet, plannedCents: 8500n }], { userId: null, batchId: randomUUID() });
    expect(await closeMonth(t.db, "2026-10", { today: NOV_2 })).toEqual({ inserted: 3, through: "2026-10" }); // Rent, Netflix (both paid in Oct), goal; Internet is manual
    const oct = await t.db.select().from(monthPlan).where(eq(monthPlan.month, "2026-10"));
    expect(oct.find((r) => r.categoryId === C.internet)).toMatchObject({ plannedCents: 8500n, plannedSource: "manual" });
    expect(oct.find((r) => r.categoryId === C.carInsurance)).toBeUndefined();
    expect(await closeMonth(t.db, "2026-10", { today: NOV_2 })).toEqual({ inserted: 0, through: "2026-10" });
  });

  it("a price change moves only months that are not frozen", async () => {
    const C = S.categories;
    await t.db.update(recurring).set({ expectedCents: -190000n }).where(eq(recurring.id, S.recurring.rent));
    const plan = await getPlan(t.db, RANGE);
    expect(cell(plan, C.rent, "2026-09")).toMatchObject({ plannedCents: 180000n, source: "recurring", hasExplicitPlan: true });
    expect(cell(plan, C.rent, "2026-10")).toMatchObject({ plannedCents: 180000n, source: "recurring", hasExplicitPlan: true });
    expect(cell(plan, C.rent, "2026-11")).toMatchObject({ plannedCents: 190000n, source: "recurring", hasExplicitPlan: false });
    expect(cell(plan, C.netflix, "2026-10")).toMatchObject({ plannedCents: 1549n, source: "recurring", hasExplicitPlan: true });
    expect((await frozenRows()).every((r) => r.plannedCents !== null)).toBe(true);
  });

  it("a cleared frozen cell (planned null) is frozen again on the next run; a row with only a note is filled", async () => {
    const C = S.categories;
    // Clearing a frozen cell deletes the row; the next run re-freezes it at the current auto value.
    await setPlanCells(t.db, [{ month: "2026-10", categoryId: C.rent, plannedCents: null }], { userId: null, batchId: randomUUID() });
    expect(cell(await getPlan(t.db, RANGE), C.rent, "2026-10")).toMatchObject({ plannedCents: 190000n, hasExplicitPlan: false });
    expect(await closeMonth(t.db, "2026-10", { today: NOV_2 })).toEqual({ inserted: 1, through: "2026-10" });
    expect(cell(await getPlan(t.db, RANGE), C.rent, "2026-10")).toMatchObject({ plannedCents: 190000n, source: "recurring", hasExplicitPlan: true });

    // A row holding only a note has planned_cents null: the freeze fills it in place.
    // November: Netflix is charged on the 5th (its next due date moves to December); rent and internet never post.
    await setPlanCells(t.db, [{ month: "2026-11", categoryId: C.netflix, note: "price went up" }], { userId: null, batchId: randomUUID() });
    await t.db.insert(transaction).values({ accountId: S.accounts.checking, source: "manual", date: "2026-11-05", amountCents: -1549n, rawDescription: "NETFLIX.COM", categoryId: C.netflix, recurringId: S.recurring.netflix });
    await t.db.update(recurring).set({ nextDueDate: "2026-12-05" }).where(eq(recurring.id, S.recurring.netflix));
    expect(await closeMonth(t.db, "2026-11", { today: "2026-12-01" })).toEqual({ inserted: 2, through: "2026-11" }); // Netflix (paid) and the goal
    const nov = await t.db.select().from(monthPlan).where(eq(monthPlan.month, "2026-11"));
    expect(nov.find((r) => r.categoryId === C.netflix)).toMatchObject({ plannedCents: 1549n, plannedSource: "recurring", note: "price went up" });
    // Rent was due Nov 1 and Internet Oct 20 and neither was paid: a closed month keeps only what was paid in it.
    expect(nov.find((r) => r.categoryId === C.rent)).toBeUndefined();
    expect(nov.find((r) => r.categoryId === C.internet)).toBeUndefined();
    expect(await closeMonth(t.db, "2026-11", { today: "2026-12-01" })).toEqual({ inserted: 0, through: "2026-11" });
  });
});
