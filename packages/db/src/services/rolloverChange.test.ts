import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IsoDate, MonthKey, PlanCategoryRowResult, PlanResult } from "@meridian/shared";
import type { Db } from "../index.js";
import { account, category, monthPlan, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { listAudit } from "./audit.js";
import { seedDefaultCategories, updateCategory } from "./categories.js";
import { getPlan, setPlanCells } from "./plan.js";

/**
 * Changing a category's rollover setting applies from the current month on. The months that
 * already happened keep the carry they had, so closed months' numbers never move.
 * Today is 2027-01-12; the plan starts in 2026-10 (the first ledger month).
 */

const TODAY: IsoDate = "2027-01-12";
const MONTHS: MonthKey[] = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02"];

describe.skipIf(!TEST_DATABASE_URL)("changing a category's rollover setting", () => {
  let t: TestDb;
  let db: Db;
  let visa: string;
  let cat: (name: string) => string;
  const ctx = (today: IsoDate = TODAY) => ({ userId: null, batchId: randomUUID(), today });

  async function spend(categoryName: string, date: IsoDate, cents: bigint): Promise<void> {
    await db.insert(transaction).values({ accountId: visa, source: "manual", date, amountCents: -cents, rawDescription: categoryName, categoryId: cat(categoryName) });
  }
  async function planFlat(categoryName: string, cents: bigint): Promise<void> {
    await setPlanCells(db, MONTHS.map((month) => ({ month, categoryId: cat(categoryName), plannedCents: cents })), ctx());
  }
  const cells = (plan: PlanResult, categoryName: string) => plan.rows.find((r): r is PlanCategoryRowResult => r.kind === "category" && r.categoryId === cat(categoryName))!.cells;
  const carried = (plan: PlanResult, categoryName: string) => cells(plan, categoryName).map((c) => c.carriedInCents);
  const read = (today: IsoDate = TODAY) => getPlan(db, { from: "2026-10", to: "2027-02", today });
  const pins = async (categoryName: string) =>
    (
      await db
        .select({ month: monthPlan.month, mode: monthPlan.rolloverMode })
        .from(monthPlan)
        .where(and(eq(monthPlan.categoryId, cat(categoryName)), isNotNull(monthPlan.rolloverMode)))
        .orderBy(asc(monthPlan.month))
    ).map((r) => [r.month, r.mode]);

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    await seedDefaultCategories(db);
    const [a] = await db.insert(account).values({ name: "Visa", type: "credit", taxTreatment: "none", onBudget: true }).returning({ id: account.id });
    visa = a!.id;
    const cats = await db.select({ id: category.id, name: category.name }).from(category);
    cat = (name) => cats.find((c) => c.name === name)!.id;

    // Dining: 200.00 a month; spent 260.00, 150.00, 300.00, then 230.00 in January.
    for (const [date, cents] of [["2026-10-10", 26000n], ["2026-11-10", 15000n], ["2026-12-10", 30000n], ["2027-01-10", 23000n]] as const) await spend("Dining", date, cents);
    // Fuel: 100.00 a month; spent 80.00, 130.00, 70.00.
    for (const [date, cents] of [["2026-10-05", 8000n], ["2026-11-05", 13000n], ["2026-12-05", 7000n]] as const) await spend("Fuel", date, cents);
    // Groceries: 300.00 a month; spent 250.00, 280.00, 310.00.
    for (const [date, cents] of [["2026-10-03", 25000n], ["2026-11-03", 28000n], ["2026-12-03", 31000n]] as const) await spend("Groceries", date, cents);
    // Pets: 50.00 a month; spent 70.00, 20.00, 40.00.
    for (const [date, cents] of [["2026-10-07", 7000n], ["2026-11-07", 2000n], ["2026-12-07", 4000n]] as const) await spend("Pets", date, cents);

    await updateCategory(db, cat("Dining"), { rolloverMode: "surplus", rolloverFromMonth: "2026-10" }, ctx());
    await updateCategory(db, cat("Fuel"), { rolloverMode: "all", rolloverFromMonth: "2026-10" }, ctx());
    await updateCategory(db, cat("Groceries"), { rolloverMode: "surplus", rolloverFromMonth: "2026-10" }, ctx());
    await updateCategory(db, cat("Pets"), { rolloverMode: "surplus", rolloverFromMonth: "2026-12" }, ctx());
    await planFlat("Dining", 20000n);
    await planFlat("Fuel", 10000n);
    await planFlat("Groceries", 30000n);
    await planFlat("Pets", 5000n);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("surplus only → surplus and overspend keeps closed months and this month's carried-in; the new mode carries out of this month", async () => {
    const before = await read();
    // Oct 200 − 260 = −60 (forgiven) | Nov 200 − 150 = +50 → Dec | Dec 200 + 50 − 300 = −50 (forgiven) | Jan 200 − 230 = −30 (forgiven).
    expect(carried(before, "Dining")).toEqual([0n, 0n, 5000n, 0n, 0n]);
    const closedBefore = before.summary.slice(0, 3).map((s) => s.leftToSpendCents);

    const batch = ctx();
    const updated = await updateCategory(db, cat("Dining"), { rolloverMode: "all", rolloverFromMonth: "2026-10" }, batch);
    expect(updated).toMatchObject({ rolloverMode: "all", rolloverFromMonth: "2026-10" });

    const after = await read();
    // Closed months and January's carried-in are as they were; January's −30.00 now carries into February.
    expect(carried(after, "Dining")).toEqual([0n, 0n, 5000n, 0n, -3000n]);
    expect(after.summary.slice(0, 3).map((s) => s.leftToSpendCents)).toEqual(closedBefore);
    expect(cells(after, "Dining").map((c) => c.rolloverMode)).toEqual(["surplus", "surplus", "surplus", "all", "all"]);
    expect(await pins("Dining")).toEqual([
      ["2026-10", "surplus"],
      ["2026-11", "surplus"],
      ["2026-12", "surplus"],
    ]);

    // The pins are part of the same reviewable batch as the category change.
    const audit = await listAudit(db, { limit: 20 });
    const mine = audit.items.filter((a) => a.batchId === batch.batchId);
    expect(mine.filter((a) => a.entity === "category")).toHaveLength(1);
    expect(mine.filter((a) => a.entity === "month_plan").map((a) => a.entityId).sort()).toEqual(["2026-10", "2026-11", "2026-12"].map((m) => `${m}:${cat("Dining")}`));

    // Saving the same setting again writes nothing.
    const again = ctx();
    await updateCategory(db, cat("Dining"), { rolloverMode: "all", rolloverFromMonth: "2026-10" }, again);
    expect((await listAudit(db, { limit: 20 })).items.filter((a) => a.batchId === again.batchId)).toHaveLength(0);
  });

  it("turning rollover off keeps what was carried so far, and turning it on again later does not rewrite those months", async () => {
    const before = await read();
    // Oct 100 − 80 = +20 → Nov | Nov 100 + 20 − 130 = −10 → Dec | Dec 100 − 10 − 70 = +20 → Jan | Jan 100 + 20 = +120 → Feb.
    expect(carried(before, "Fuel")).toEqual([0n, 2000n, -1000n, 2000n, 12000n]);
    const closedBefore = before.summary.slice(0, 3).map((s) => s.leftToSpendCents);

    expect(await updateCategory(db, cat("Fuel"), { rolloverMode: "none" }, ctx())).toMatchObject({ rolloverMode: "none", rolloverFromMonth: null });
    const off = await read();
    // January keeps the 20.00 it was handed; nothing leaves January.
    expect(carried(off, "Fuel")).toEqual([0n, 2000n, -1000n, 2000n, 0n]);
    expect(off.summary.slice(0, 3).map((s) => s.leftToSpendCents)).toEqual(closedBefore);

    // March 5: carrying again, starting with March by default. October to February stay as they were.
    expect(await updateCategory(db, cat("Fuel"), { rolloverMode: "surplus" }, ctx("2027-03-05"))).toMatchObject({ rolloverMode: "surplus", rolloverFromMonth: "2027-03" });
    const on = await getPlan(db, { from: "2026-10", to: "2027-03", today: "2027-03-05" });
    expect(carried(on, "Fuel")).toEqual([0n, 2000n, -1000n, 2000n, 0n, 0n]);
    expect(cells(on, "Fuel")[5]).toMatchObject({ carriedInSource: "start", rolloverMode: "surplus" });
    expect(on.summary.slice(0, 3).map((s) => s.leftToSpendCents)).toEqual(closedBefore);
  });

  it("restarting the chain at the current month drops the carried balance from now on and leaves closed months alone", async () => {
    const before = await read();
    // Oct 300 − 250 = +50 → Nov | Nov 300 + 50 − 280 = +70 → Dec | Dec 300 + 70 − 310 = +60 → Jan | Jan 300 + 60 → Feb.
    expect(carried(before, "Groceries")).toEqual([0n, 5000n, 7000n, 6000n, 36000n]);
    const closedBefore = before.summary.slice(0, 3).map((s) => s.leftToSpendCents);

    await updateCategory(db, cat("Groceries"), { rolloverMode: "all", rolloverFromMonth: "2027-01" }, ctx());
    const after = await read();
    expect(carried(after, "Groceries")).toEqual([0n, 5000n, 7000n, 0n, 30000n]);
    expect(cells(after, "Groceries")[3]).toMatchObject({ carriedInSource: "start", rolloverMode: "all" });
    expect(after.summary.slice(0, 3).map((s) => s.leftToSpendCents)).toEqual(closedBefore);
  });

  it("an earlier start month is a request to recompute: the whole chain follows the new setting", async () => {
    // Surplus from December: Dec 50 − 40 = +10 → Jan.
    expect(carried(await read(), "Pets")).toEqual([0n, 0n, 0n, 1000n, 6000n]);
    await updateCategory(db, cat("Pets"), { rolloverMode: "all", rolloverFromMonth: "2026-10" }, ctx());
    // All from October: Oct 50 − 70 = −20 → Nov | Nov 50 − 20 − 20 = +10 → Dec | Dec 50 + 10 − 40 = +20 → Jan | Jan 50 + 20 → Feb.
    expect(carried(await read(), "Pets")).toEqual([0n, -2000n, 1000n, 2000n, 7000n]);
    expect(await pins("Pets")).toEqual([]);
  });
});
