import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlanCategoryRowResult } from "@meridian/shared";
import type { Db } from "../index.js";
import { account, category, split, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { seedDefaultCategories } from "./categories.js";
import { createGoal } from "./goals.js";
import { ingestTransactions } from "./ingest.js";
import { getPlan, listPlanTransactions } from "./plan.js";
import { updateHouseholdSetting } from "./settings.js";
import { countUncategorized, getTransaction, listTransactions, setTransactionSplits, updateTransaction, type TransactionListRow } from "./transactions.js";

/**
 * The list behind a plan cell adds up to the cell. January 2027, today the 25th:
 * - Groceries: −25.00 (Jan 4), −15.00 (Jan 9) and 60.00 of a 100.00 warehouse run split
 *   60.00 Groceries / 40.00 Home → actual 100.00 in 3 lines;
 * - Home: the other 40.00 → actual 40.00 in 1 line;
 * - Fees & Charges: a −99.00 row in the off-budget brokerage → not in the plan at all;
 * - uncategorized: −12.00 on budget (counts), −5.00 in the brokerage (does not).
 */

const TODAY = "2027-01-25";

/** What a row contributes to a category: its split lines there, or the whole row. */
function inCategory(row: TransactionListRow, categoryId: string): bigint {
  if (row.splits.length === 0) return row.amountCents;
  return row.splits.filter((s) => s.categoryId === categoryId).reduce((sum, s) => sum + s.amountCents, 0n);
}

describe.skipIf(!TEST_DATABASE_URL)("plan drill-down, split lines and the review count", () => {
  let t: TestDb;
  let db: Db;
  let checking: string;
  let brokerage: string;
  let cat: (name: string) => string;
  let warehouse: string;
  let transferLeg: string;

  async function add(accountId: string, date: string, cents: bigint, description: string, categoryName: string | null, isTransfer = false): Promise<string> {
    const [row] = await db
      .insert(transaction)
      .values({ accountId, source: "manual", date, amountCents: cents, rawDescription: description, categoryId: categoryName === null ? null : cat(categoryName), isTransfer })
      .returning({ id: transaction.id });
    return row!.id;
  }
  async function januaryCell(categoryName: string) {
    const plan = await getPlan(db, { from: "2027-01", to: "2027-01", today: TODAY });
    return plan.rows.find((r): r is PlanCategoryRowResult => r.kind === "category" && r.categoryId === cat(categoryName))!.cells[0]!;
  }

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    await seedDefaultCategories(db);
    const accounts = await db
      .insert(account)
      .values([
        { name: "Checking", type: "checking", taxTreatment: "none", onBudget: true },
        { name: "Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false },
      ])
      .returning({ id: account.id, name: account.name });
    checking = accounts.find((a) => a.name === "Checking")!.id;
    brokerage = accounts.find((a) => a.name === "Brokerage")!.id;
    const cats = await db.select({ id: category.id, name: category.name }).from(category);
    cat = (name) => cats.find((c) => c.name === name)!.id;

    await add(checking, "2027-01-04", -2500n, "KING SOOPERS", "Groceries");
    await add(checking, "2027-01-09", -1500n, "KING SOOPERS", "Groceries");
    warehouse = await add(checking, "2027-01-12", -10000n, "COSTCO", null);
    await db.insert(split).values([
      { transactionId: warehouse, categoryId: cat("Groceries"), amountCents: -6000n },
      { transactionId: warehouse, categoryId: cat("Home"), amountCents: -4000n },
    ]);
    await add(brokerage, "2027-01-15", -9900n, "ADVISORY FEE", "Fees & Charges");
    await add(checking, "2027-01-20", -1200n, "MYSTERY", null);
    await add(brokerage, "2027-01-21", -500n, "SWEEP", null);
    transferLeg = await add(checking, "2027-01-22", -30000n, "TO SAVINGS", null, true);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("a category's drill-down holds every line the cell counts, split lines included", async () => {
    expect(await januaryCell("Groceries")).toMatchObject({ actualCents: 10000n, txnCount: 3 });
    const groceries = await listPlanTransactions(db, { categoryId: cat("Groceries"), month: "2027-01" });
    expect(groceries.items.map((r) => [r.date, r.amountCents, inCategory(r, cat("Groceries"))])).toEqual([
      ["2027-01-12", -10000n, -6000n],
      ["2027-01-09", -1500n, -1500n],
      ["2027-01-04", -2500n, -2500n],
    ]);
    expect(groceries.items[0]!.splits.map((s) => [s.categoryName, s.amountCents])).toEqual([
      ["Groceries", -6000n],
      ["Home", -4000n],
    ]);

    expect(await januaryCell("Home")).toMatchObject({ actualCents: 4000n, txnCount: 1 });
    const home = await listPlanTransactions(db, { categoryId: cat("Home"), month: "2027-01" });
    expect(home.items.map((r) => [r.id, inCategory(r, cat("Home"))])).toEqual([[warehouse, -4000n]]);
  });

  it("leaves out rows of off-budget accounts, which the cell does not count either", async () => {
    expect(await januaryCell("Fees & Charges")).toMatchObject({ actualCents: 0n, txnCount: 0 });
    expect((await listPlanTransactions(db, { categoryId: cat("Fees & Charges"), month: "2027-01" })).items).toEqual([]);
    // The register itself still finds the row.
    const register = await listTransactions(db, { categoryId: cat("Fees & Charges"), limit: 50 });
    expect(register.items.map((r) => [r.accountName, r.amountCents])).toEqual([["Brokerage", -9900n]]);
  });

  it("counts a split transaction as categorized everywhere: plan badge, dashboard review count and the uncategorized lists", async () => {
    const plan = await getPlan(db, { from: "2027-01", to: "2027-01", today: TODAY });
    expect(plan.summary[0]!.uncategorized).toEqual({ count: 1, cents: -1200n });
    expect(await countUncategorized(db)).toBe(1);
    expect((await listPlanTransactions(db, { uncategorized: true, month: "2027-01" })).items.map((r) => r.amountCents)).toEqual([-1200n]);
    // The register's own filter is not limited to the plan's accounts, but a split row is never "uncategorized".
    const register = await listTransactions(db, { uncategorized: true, limit: 50 });
    expect(register.items.map((r) => r.amountCents)).toEqual([-500n, -1200n]);
  });

  it("splits a transaction across categories and keeps the lines equal to the amount", async () => {
    const [plain] = (await listTransactions(db, { categoryId: cat("Groceries"), from: "2027-01-04", to: "2027-01-04", limit: 5 })).items;
    const row = await setTransactionSplits(db, plain!.id, [
      { categoryId: cat("Groceries"), amountCents: -2000n },
      { categoryId: cat("Pets"), amountCents: -500n, memo: " dog food " },
    ]);
    expect(row).toMatchObject({ categoryId: null, categoryLocked: true, amountCents: -2500n });
    expect(row!.splits.map((s) => [s.categoryName, s.amountCents, s.memo])).toEqual([
      ["Groceries", -2000n, null],
      ["Pets", -500n, "dog food"],
    ]);
    // Groceries: 20.00 + 15.00 + 60.00 = 95.00 in 3 lines; Pets 5.00.
    expect(await januaryCell("Groceries")).toMatchObject({ actualCents: 9500n, txnCount: 3 });
    expect(await januaryCell("Pets")).toMatchObject({ actualCents: 500n, txnCount: 1 });
    expect(await countUncategorized(db)).toBe(1);

    // Replacing the lines is a full replace.
    const again = await setTransactionSplits(db, plain!.id, [
      { categoryId: cat("Groceries"), amountCents: -1000n },
      { categoryId: cat("Pets"), amountCents: -1500n },
    ]);
    expect(again!.splits.map((s) => s.amountCents)).toEqual([-1500n, -1000n]);
    expect(await januaryCell("Pets")).toMatchObject({ actualCents: 1500n });
  });

  it("refuses lines that do not add up, a single line, a zero line, an unknown category and a transfer", async () => {
    const lines = (a: bigint, b: bigint) => [
      { categoryId: cat("Groceries"), amountCents: a },
      { categoryId: cat("Home"), amountCents: b },
    ];
    await expect(setTransactionSplits(db, warehouse, lines(-6000n, -3999n))).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(setTransactionSplits(db, warehouse, [{ categoryId: cat("Groceries"), amountCents: -10000n }])).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(setTransactionSplits(db, warehouse, lines(-10000n, 0n))).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(
      setTransactionSplits(db, warehouse, [
        { categoryId: cat("Groceries"), amountCents: -6000n },
        { categoryId: "00000000-0000-4000-8000-000000000000", amountCents: -4000n },
      ]),
    ).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(setTransactionSplits(db, transferLeg, lines(-20000n, -10000n))).rejects.toMatchObject({ status: 400, code: "validation" });
    expect(await setTransactionSplits(db, "00000000-0000-4000-8000-000000000000", lines(-1n, -1n))).toBeUndefined();
    // Nothing was written by the refused calls.
    expect((await getTransaction(db, warehouse))!.splits.map((s) => s.amountCents)).toEqual([-6000n, -4000n]);
    // A cash-back line may run the other way as long as the lines add up: 120.00 of groceries, 20.00 back.
    const mixed = await setTransactionSplits(db, warehouse, [
      { categoryId: cat("Groceries"), amountCents: -12000n },
      { categoryId: cat("Other Income"), amountCents: 2000n },
    ]);
    expect(mixed!.splits.map((s) => s.amountCents)).toEqual([-12000n, 2000n]);
    await setTransactionSplits(db, warehouse, lines(-6000n, -4000n));
  });

  it("picking one category, or clearing the lines, removes the split", async () => {
    const picked = await updateTransaction(db, warehouse, { categoryId: cat("Home") });
    expect(picked).toMatchObject({ categoryId: cat("Home"), splits: [] });
    expect(await db.select().from(split).where(eq(split.transactionId, warehouse))).toEqual([]);
    expect(await januaryCell("Home")).toMatchObject({ actualCents: 10000n, txnCount: 1 });

    await setTransactionSplits(db, warehouse, [
      { categoryId: cat("Groceries"), amountCents: -6000n },
      { categoryId: cat("Home"), amountCents: -4000n },
    ]);
    const cleared = await setTransactionSplits(db, warehouse, []);
    expect(cleared).toMatchObject({ categoryId: null, splits: [] });
    expect(await countUncategorized(db)).toBe(2);
  });

  it("a split row whose amount the bank changes goes back to review instead of keeping lines that no longer add up", async () => {
    // A synced restaurant charge of 80.00, split 50.00 Dining / 30.00 Gifts; the bank then re-sends it with the tip: 92.00.
    await ingestTransactions(db, [{ externalId: "BANK-1", date: "2027-01-23", amountCents: -8000n, description: "BISTRO", pending: false }], { accountId: checking, source: "simplefin", rules: [] });
    const [bistro] = (await listTransactions(db, { from: "2027-01-23", to: "2027-01-23", limit: 5 })).items;
    await setTransactionSplits(db, bistro!.id, [
      { categoryId: cat("Dining"), amountCents: -5000n },
      { categoryId: cat("Gifts"), amountCents: -3000n },
    ]);
    expect(await januaryCell("Dining")).toMatchObject({ actualCents: 5000n });
    const before = await countUncategorized(db);

    await ingestTransactions(db, [{ externalId: "BANK-1", date: "2027-01-23", amountCents: -9200n, description: "BISTRO", pending: false }], { accountId: checking, source: "simplefin", rules: [] });
    const after = await getTransaction(db, bistro!.id);
    expect(after).toMatchObject({ amountCents: -9200n, categoryId: null, splits: [] });
    expect(await januaryCell("Dining")).toMatchObject({ actualCents: 0n, txnCount: 0 });
    expect(await countUncategorized(db)).toBe(before + 1);

    // A re-sync that changes nothing about the amount leaves a split alone.
    await setTransactionSplits(db, bistro!.id, [
      { categoryId: cat("Dining"), amountCents: -6200n },
      { categoryId: cat("Gifts"), amountCents: -3000n },
    ]);
    await ingestTransactions(db, [{ externalId: "BANK-1", date: "2027-01-24", amountCents: -9200n, description: "BISTRO DENVER", pending: false }], { accountId: checking, source: "simplefin", rules: [] });
    expect((await getTransaction(db, bistro!.id))!.splits.map((s) => s.amountCents)).toEqual([-6200n, -3000n]);
  });
});

/**
 * Plan scope where the cell's rule is not "the row is on budget" (audit b1-plan-math, second
 * round). January 2027, today the 20th; Checking is on budget, the Roth IRA is not (investment
 * accounts start off budget); the feed (investment income category) is Interest & Dividends.
 * - Goal "Retirement" (category Roth contributions) is linked to the IRA. Its cell counts the
 *   transfer legs in the IRA whatever the IRA's budget flag: +500.00 on Jan 5. It also counts
 *   the categorized rows the plan reads: −100.00 from Checking on Jan 12 → +100.00 (savings
 *   is bucket-natural −1). Not counted: the Checking leg of the transfer (not the linked
 *   account), a −15.00 IRA fee categorized to the goal (off budget, not the feed) and the
 *   15.00 goal line of a split IRA row (off budget, not the feed) → actual 600.00, 2 rows.
 * - IRA +30.00 on Jan 10 split 20.00 feed / 10.00 Shopping, and IRA +40.00 on Jan 14 split
 *   25.00 feed / 15.00 Roth contributions: the feed lines count (45.00 in 2 lines), the other
 *   lines do not, so Shopping's cell is 0 in 0 rows.
 */
describe.skipIf(!TEST_DATABASE_URL)("plan scope of a goal on an off-budget account and of split lines (audit b1-plan-math, second round)", () => {
  let t: TestDb;
  let db: Db;
  let cat: (name: string) => string;
  let goalId: string;
  let goalCategory: string;
  const ids: Record<string, string> = {};

  async function add(key: string, accountId: string, date: string, cents: bigint, description: string, categoryId: string | null, isTransfer = false): Promise<void> {
    const [row] = await db.insert(transaction).values({ accountId, source: "manual", date, amountCents: cents, rawDescription: description, categoryId, isTransfer }).returning({ id: transaction.id });
    ids[key] = row!.id;
  }
  async function januaryCell(categoryId: string) {
    const plan = await getPlan(db, { from: "2027-01", to: "2027-01", today: "2027-01-20" });
    return plan.rows.find((r): r is PlanCategoryRowResult => r.kind === "category" && r.categoryId === categoryId)!.cells[0]!;
  }
  const keysOf = (rows: TransactionListRow[]) => rows.map((r) => Object.keys(ids).find((k) => ids[k] === r.id));

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    await seedDefaultCategories(db);
    const accounts = await db
      .insert(account)
      .values([
        { name: "Checking", type: "checking", taxTreatment: "none", onBudget: true },
        { name: "Roth IRA", type: "roth", taxTreatment: "roth", onBudget: false },
      ])
      .returning({ id: account.id, name: account.name });
    const checking = accounts.find((a) => a.name === "Checking")!.id;
    const ira = accounts.find((a) => a.name === "Roth IRA")!.id;
    const cats = await db.select({ id: category.id, name: category.name }).from(category);
    cat = (name) => cats.find((c) => c.name === name)!.id;
    const ctx = { userId: null, batchId: randomUUID(), today: "2027-01-20" };
    await updateHouseholdSetting(db, { investmentIncomeCategoryId: cat("Interest & Dividends") }, ctx);
    const goal = await createGoal(db, { name: "Retirement", newCategory: { name: "Roth contributions" }, targetCents: 700000n, linkedAccountId: ira, monthlyContributionCents: 50000n, startMonth: "2027-01" }, ctx);
    goalId = goal.id;
    goalCategory = goal.categoryId;

    await add("checkingLeg", checking, "2027-01-05", -50000n, "TO ROTH IRA", null, true);
    await add("iraLeg", ira, "2027-01-05", 50000n, "FROM CHECKING", null, true);
    await add("iraFee", ira, "2027-01-08", -1500n, "IRA ADVISORY FEE", goalCategory);
    await add("dividendSplit", ira, "2027-01-10", 3000n, "DIV + MISC", null);
    await add("cashContribution", checking, "2027-01-12", -10000n, "CASH TO ROTH", goalCategory);
    await add("goalSplit", ira, "2027-01-14", 4000n, "DIV + CONTRIB", null);
    await db.insert(split).values([
      { transactionId: ids["dividendSplit"]!, categoryId: cat("Interest & Dividends"), amountCents: 2000n },
      { transactionId: ids["dividendSplit"]!, categoryId: cat("Shopping"), amountCents: 1000n },
      { transactionId: ids["goalSplit"]!, categoryId: cat("Interest & Dividends"), amountCents: 2500n },
      { transactionId: ids["goalSplit"]!, categoryId: goalCategory, amountCents: 1500n },
    ]);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("lists a goal's transfer legs in its off-budget linked account, as its cell counts them", async () => {
    expect(await januaryCell(goalCategory)).toMatchObject({ actualCents: 60000n, txnCount: 2 });
    const drill = await listPlanTransactions(db, { goalId, month: "2027-01" });
    expect(keysOf(drill.items)).toEqual(["cashContribution", "iraLeg"]);
    // The register link behind the goal cell asks for the same rows (goalId + planScope).
    const register = await listTransactions(db, { goalId, from: "2027-01-01", to: "2027-01-31", planScope: true, limit: 50 });
    expect(keysOf(register.items)).toEqual(["cashContribution", "iraLeg"]);
    // Without plan scope the goal's filter still finds the rows of the off-budget account.
    const all = await listTransactions(db, { goalId, from: "2027-01-01", to: "2027-01-31", limit: 50 });
    expect(keysOf(all.items)).toEqual(["goalSplit", "cashContribution", "iraFee", "iraLeg"]);
  });

  it("lists a split row under a line's category only when the plan counts that line", async () => {
    expect(await januaryCell(cat("Shopping"))).toMatchObject({ actualCents: 0n, txnCount: 0 });
    expect((await listPlanTransactions(db, { categoryId: cat("Shopping"), month: "2027-01" })).items).toEqual([]);
    expect(await januaryCell(cat("Interest & Dividends"))).toMatchObject({ actualCents: 4500n, txnCount: 2 });
    const feed = await listPlanTransactions(db, { categoryId: cat("Interest & Dividends"), month: "2027-01" });
    expect(keysOf(feed.items)).toEqual(["goalSplit", "dividendSplit"]);
    // The register's category filter with plan scope follows the same rule; without it, the row is there.
    expect((await listTransactions(db, { categoryId: cat("Shopping"), planScope: true, limit: 50 })).items).toEqual([]);
    expect(keysOf((await listTransactions(db, { categoryId: cat("Shopping"), limit: 50 })).items)).toEqual(["dividendSplit"]);
    // Plan scope with no category keeps every row the plan counts somewhere: both split rows count by their feed lines.
    const scoped = await listTransactions(db, { from: "2027-01-01", to: "2027-01-31", transfers: "exclude", planScope: true, limit: 50 });
    expect(keysOf(scoped.items)).toEqual(["goalSplit", "cashContribution", "dividendSplit"]);
  });
});
