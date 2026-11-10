import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../index.js";
import { account, category, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { loadCashFlowInput } from "./cashflow.js";
import { seedDefaultCategories } from "./categories.js";
import { planAverages } from "./plan.js";

/**
 * A first sync on 2026-11-10 reaches back 93 days, to 2026-08-09: August arrives without its
 * first eight days (and without the rent taken on the 1st). Rent is 1,800.00 every month.
 * Groceries: 200.00 in what is visible of August, 300.00 in September, 400.00 in October.
 */

const TODAY = "2026-11-10";

describe.skipIf(!TEST_DATABASE_URL)("plan averages over a ledger that opens mid-month", () => {
  let t: TestDb;
  let db: Db;
  let checking: string;
  let brokerage: string;
  let cat: (name: string) => string;

  async function add(accountId: string, date: string, cents: bigint, categoryName: string | null): Promise<void> {
    await db.insert(transaction).values({ accountId, source: "manual", date, amountCents: cents, rawDescription: categoryName ?? "x", categoryId: categoryName === null ? null : cat(categoryName) });
  }
  const average = (r: Awaited<ReturnType<typeof planAverages>>, name: string) => r.averages.find((a) => a.categoryId === cat(name))!.averageCents;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    await seedDefaultCategories(db);
    const accounts = await db
      .insert(account)
      .values([
        { name: "Checking", type: "checking", taxTreatment: "none", onBudget: true, balanceCents: 500000n, balanceDate: TODAY },
        { name: "Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false },
      ])
      .returning({ id: account.id, name: account.name });
    checking = accounts.find((a) => a.name === "Checking")!.id;
    brokerage = accounts.find((a) => a.name === "Brokerage")!.id;
    const cats = await db.select({ id: category.id, name: category.name }).from(category);
    cat = (name) => cats.find((c) => c.name === name)!.id;

    await add(checking, "2026-08-10", -500n, "Dining");
    await add(checking, "2026-08-15", -20000n, "Groceries");
    await add(checking, "2026-09-01", -180000n, "Rent / Mortgage");
    await add(checking, "2026-09-12", -30000n, "Groceries");
    await add(checking, "2026-10-01", -180000n, "Rent / Mortgage");
    await add(checking, "2026-10-20", -40000n, "Groceries");
    await add(checking, "2026-11-01", -180000n, "Rent / Mortgage");
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("does not count the partially synced first month: rent averages 1,800.00, not 1,200.00", async () => {
    const three = await planAverages(db, { months: 3, today: TODAY });
    // Window Aug..Oct; August opens on the 10th, so September and October are the two months of history.
    expect(three.window).toEqual({ from: "2026-08", to: "2026-10", monthsWithData: 2 });
    expect(average(three, "Rent / Mortgage")).toBe(180000n); // (1,800.00 + 1,800.00) / 2
    expect(average(three, "Groceries")).toBe(35000n); // (300.00 + 400.00) / 2
    expect(average(three, "Dining")).toBe(0n); // the August coffee is outside the counted months
  });

  it("reports no history, and averages of zero, while the only data is a partial month", async () => {
    const early = await planAverages(db, { months: 3, asOf: "2026-09", today: TODAY });
    expect(early.window).toEqual({ from: "2026-06", to: "2026-08", monthsWithData: 0 });
    expect(average(early, "Groceries")).toBe(0n);
    // The cash-flow projection says so instead of silently projecting an optimistic 0.
    const input = await loadCashFlowInput(db, { today: "2026-08-20", horizonDays: 30 });
    expect(input.spendingPlan).toEqual([
      { month: "2026-08", remainingCents: 0n },
      { month: "2026-09", remainingCents: 0n },
    ]);
    expect(input.warnings).toContain("1 month has unplanned spending categories and there is no complete month of history to average yet: they are projected at 0");
  });

  it("ignores the history of off-budget accounts, which the plan never reads", async () => {
    await add(brokerage, "2025-01-15", -250000n, null);
    const six = await planAverages(db, { months: 6, today: TODAY });
    // Window May..Oct: still only September and October, not six months of zeros.
    expect(six.window).toEqual({ from: "2026-05", to: "2026-10", monthsWithData: 2 });
    expect(average(six, "Rent / Mortgage")).toBe(180000n);
  });

  it("counts the first month when the ledger covers it from the 1st", async () => {
    await add(checking, "2026-08-01", -180000n, "Rent / Mortgage"); // e.g. history imported from a CSV export
    const three = await planAverages(db, { months: 3, today: TODAY });
    expect(three.window).toEqual({ from: "2026-08", to: "2026-10", monthsWithData: 3 });
    expect(average(three, "Rent / Mortgage")).toBe(180000n); // 5,400.00 / 3
    expect(average(three, "Groceries")).toBe(30000n); // (200.00 + 300.00 + 400.00) / 3
    expect(average(three, "Dining")).toBe(166n); // 5.00 / 3, truncated
  });
});
