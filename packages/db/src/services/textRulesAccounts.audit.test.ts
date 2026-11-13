import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isoDateToUtcMs, mapCsvRows, type IsoDate, type MappedRow, type SimplefinAccountSet } from "@meridian/shared";
import { account, balanceSnapshot, category, connection, payee, rule, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { defaultOnBudget, guessAccountType, upsertSimplefinAccount } from "./accounts.js";
import { PlanError } from "./audit.js";
import { createCategory, deleteCategory } from "./categories.js";
import { importCsvRows } from "./csvImport.js";
import { netWorth } from "./dashboard.js";
import { addPayeeAlias } from "./payees.js";
import { loadRules, runRules } from "./rules.js";
import { applyAccountSet } from "./sync.js";

/**
 * Audit batch a6-text-rules-accounts: accounts, payees, rules and text safety (the database
 * side; the routes are in apps/api/src/textRulesAccounts.audit.test.ts).
 */

const CTX = () => ({ userId: null, batchId: randomUUID() });
const unix = (date: IsoDate, hour = 12) => Math.floor(isoDateToUtcMs(date) / 1000) + hour * 3600;
const CSV_MAPPING = {
  hasHeader: true,
  date: { column: "Date", format: "YYYY-MM-DD" as const },
  description: { column: "Description" },
  amount: { mode: "single" as const, column: "Amount" },
};
async function csvRows(lines: Array<[IsoDate, string, string]>): Promise<MappedRow[]> {
  const { rows, errors } = await mapCsvRows([["Date", "Description", "Amount"], ...lines], CSV_MAPPING);
  expect(errors).toEqual([]);
  return rows;
}

describe("account types guessed from a feed account's name (a6-text-rules-accounts-06)", () => {
  it("lets the account noun win over joint, individual, rewards, platinum, student and auto", () => {
    const cases: Array<[string, string]> = [
      ["Joint Checking", "checking"],
      ["Individual Checking", "checking"],
      ["Joint Savings", "savings"],
      ["Kasasa Rewards Checking", "checking"],
      ["Platinum Checking", "checking"],
      ["Student Checking", "checking"],
      ["Auto Savings", "savings"],
      ["Freedom Money Market", "savings"],
      ["12-Month CD", "savings"],
      ["Citi Double Cash", "credit"],
      ["Chase Freedom Unlimited", "credit"],
      ["Sapphire Preferred Visa", "credit"],
      ["Platinum Card", "credit"],
      ["Auto Loan", "loan"],
      ["Student Loan", "loan"],
      ["Home Mortgage", "loan"],
      ["Joint Brokerage", "brokerage"],
      ["Individual - TOD", "brokerage"],
      ["Roth IRA", "roth"],
      ["Rollover IRA", "ira"],
      ["Health Savings Account", "hsa"],
      ["401(k) Savings Plan", "401k"],
      ["Everyday Account", "checking"],
    ];
    for (const [name, type] of cases) expect(guessAccountType(name), name).toBe(type);
  });
});

describe("houses, vehicles and loans start off budget (a6-text-rules-accounts-08)", () => {
  it("keeps cash and cards on budget and puts investments, assets and loans off it", () => {
    expect(defaultOnBudget("checking")).toBe(true);
    expect(defaultOnBudget("savings")).toBe(true);
    expect(defaultOnBudget("credit")).toBe(true);
    expect(defaultOnBudget("asset")).toBe(false);
    expect(defaultOnBudget("loan")).toBe(false);
    expect(defaultOnBudget("brokerage")).toBe(false);
    expect(defaultOnBudget("401k")).toBe(false);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("accounts, rules and payees in the database (audit a6-text-rules-accounts)", () => {
  let t: TestDb;
  let checkingId: string;

  beforeAll(async () => {
    t = await createTestDb();
    const [checking] = await t.db.insert(account).values({ name: "Checking", type: "checking", taxTreatment: "none" }).returning({ id: account.id });
    checkingId = checking!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("a6-text-rules-accounts-02: a category a rule sets cannot be deleted (409 in_use naming the rule)", async () => {
    const temp = await createCategory(t.db, { name: "Hardware Temp", bucket: "spending" }, CTX());
    const [r] = await t.db
      .insert(rule)
      .values({ name: "Ace → Hardware", position: 1, conditions: { payee: { op: "contains", value: "ace hardware" } }, actions: { setCategoryId: temp.id } })
      .returning({ id: rule.id });
    const err = await deleteCategory(t.db, temp.id, CTX()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err).toMatchObject({ status: 409, code: "in_use" });
    expect((err as Error).message).toContain("1 rule(s) (Ace → Hardware)");
    expect((await t.db.select().from(category).where(eq(category.id, temp.id))).length).toBe(1);
    await t.db.delete(rule).where(eq(rule.id, r!.id));
    await deleteCategory(t.db, temp.id, CTX());
    expect((await t.db.select().from(category).where(eq(category.id, temp.id))).length).toBe(0);
  });

  it("a6-text-rules-accounts-02: a rule naming a category that no longer exists sets nothing, and imports and syncs go on", async () => {
    const groceries = await createCategory(t.db, { name: "Groceries", bucket: "spending" }, CTX());
    const gone = "11111111-1111-4111-8111-111111111111";
    await t.db.insert(rule).values([
      { name: "stale", position: 10, conditions: { payee: { op: "contains", value: "ace hardware" } }, actions: { setCategoryId: gone, addTags: ["diy"] } },
      { name: "groceries", position: 11, conditions: { payee: { op: "contains", value: "king soopers" } }, actions: { setCategoryId: groceries.id } },
    ]);
    const loaded = await loadRules(t.db);
    expect(loaded.find((r) => r.name === "stale")!.actions).toEqual({ addTags: ["diy"] });
    // The stored rule still shows what it was written with.
    expect((await loadRules(t.db, { stored: true })).find((r) => r.name === "stale")!.actions).toEqual({ setCategoryId: gone, addTags: ["diy"] });

    // CSV import: both rows are stored; the stale rule's category is ignored, its tag is not.
    const result = await importCsvRows(t.db, {
      accountId: checkingId,
      rows: await csvRows([
        ["2026-11-02", "ACE HARDWARE #123 DENVER CO", "-25.10"],
        ["2026-11-02", "KING SOOPERS #0123 DENVER CO", "-45.32"],
      ]),
    });
    expect(result.created).toBe(2);
    const rows = await t.db.select({ desc: transaction.rawDescription, categoryId: transaction.categoryId }).from(transaction).where(eq(transaction.accountId, checkingId));
    expect(rows.find((r) => r.desc.startsWith("ACE"))!.categoryId).toBeNull();
    expect(rows.find((r) => r.desc.startsWith("KING"))!.categoryId).toBe(groceries.id);

    // A sync with a matching row: the account's rows arrive.
    const [conn] = await t.db.insert(connection).values({ name: "Bank", type: "simplefin" }).returning({ id: connection.id });
    const accountSet: SimplefinAccountSet = {
      errors: [],
      errlist: [],
      accounts: [
        {
          org: { name: "Bank" },
          id: "ACT-1",
          name: "Feed Checking",
          currency: "USD",
          balance: "100.00",
          "balance-date": unix("2026-11-03", 6),
          transactions: [
            { id: "T1", posted: unix("2026-11-02"), amount: "-12.00", description: "ACE HARDWARE #99 AURORA CO", pending: false },
            { id: "T2", posted: unix("2026-11-02"), amount: "-30.00", description: "KING SOOPERS #0456 AURORA CO", pending: false },
          ],
        },
      ],
    };
    const synced = await applyAccountSet(t.db, { connectionId: conn!.id, accountSet, windowStart: "2026-10-20", now: new Date("2026-11-03T18:00:00Z") });
    expect(synced.stats.created).toBe(2);
    // On demand too.
    await expect(runRules(t.db, { scope: "all" })).resolves.toMatchObject({ examined: expect.any(Number) });
    await t.db.delete(rule);
  });

  it("a6-text-rules-accounts-10: a rule written on a name keeps working after that name is merged into another payee", async () => {
    const coffee = await createCategory(t.db, { name: "Coffee", bucket: "spending" }, CTX());
    const [target] = await t.db.insert(payee).values({ name: "Starbucks Store" }).returning({ id: payee.id });
    await addPayeeAlias(t.db, target!.id, "Sbux Mobile Order");
    await t.db.insert(rule).values({ name: "Sbux → Coffee", position: 1, conditions: { payee: { op: "equals", value: "Sbux Mobile Order" } }, actions: { setCategoryId: coffee.id } });
    await importCsvRows(t.db, { accountId: checkingId, rows: await csvRows([["2026-11-05", "SBUX MOBILE ORDER", "-6.45"]]) });
    const [row] = await t.db.select({ payeeId: transaction.payeeId, categoryId: transaction.categoryId }).from(transaction).where(eq(transaction.rawDescription, "SBUX MOBILE ORDER"));
    expect(row).toEqual({ payeeId: target!.id, categoryId: coffee.id });
    // On demand as well: a row of the payee written before the rule.
    const [old] = await t.db.insert(transaction).values({ accountId: checkingId, date: "2026-10-01", amountCents: -500n, payeeId: target!.id, rawDescription: "STARBUCKS STORE #9", source: "manual" }).returning({ id: transaction.id });
    await runRules(t.db, { scope: "uncategorized" });
    expect((await t.db.select({ c: transaction.categoryId }).from(transaction).where(eq(transaction.id, old!.id)))[0]!.c).toBe(coffee.id);
    await t.db.delete(rule);
  });

  it("a6-text-rules-accounts-07: closing an account does not change what the household was worth a year ago", async () => {
    const t2 = await createTestDb();
    try {
      const [checking] = await t2.db.insert(account).values({ name: "Checking", type: "checking", taxTreatment: "none" }).returning({ id: account.id });
      const [oldSavings] = await t2.db.insert(account).values({ name: "Old Savings", type: "savings", taxTreatment: "none" }).returning({ id: account.id });
      const [newSavings] = await t2.db.insert(account).values({ name: "New Savings", type: "savings", taxTreatment: "none" }).returning({ id: account.id });
      await t2.db.insert(balanceSnapshot).values([
        { accountId: checking!.id, date: "2025-11-01", balanceCents: 100000n, source: "manual" },
        { accountId: checking!.id, date: "2026-11-01", balanceCents: 100000n, source: "manual" },
        { accountId: oldSavings!.id, date: "2025-11-01", balanceCents: 1000000n, source: "manual" },
        { accountId: oldSavings!.id, date: "2026-06-01", balanceCents: 0n, source: "manual" },
        { accountId: newSavings!.id, date: "2026-06-01", balanceCents: 1000000n, source: "manual" },
      ]);
      const before = await netWorth(t2.db, "2026-11-13");
      expect(before).toMatchObject({ todayCents: 1100000n, yearAgoCents: 1100000n, changeCents: 0n });
      await t2.db.update(account).set({ closed: true }).where(eq(account.id, oldSavings!.id));
      const after = await netWorth(t2.db, "2026-11-13");
      // Hand check: today 1,000.00 + 10,000.00 (Old Savings closed, at 0) = 11,000.00; a year ago 1,000.00 + 10,000.00 = 11,000.00.
      expect(after).toMatchObject({ todayCents: 1100000n, yearAgoCents: 1100000n, changeCents: 0n, newAccounts: [{ id: newSavings!.id, name: "New Savings" }] });
      expect(after.breakdown.cashCents).toBe(1100000n);
    } finally {
      await t2.cleanup();
    }
  });

  it("a6-text-rules-accounts-06/08: a feed's Joint Checking is a checking account on budget; a feed mortgage starts off budget", async () => {
    const [conn] = await t.db.insert(connection).values({ name: "Bank 2", type: "simplefin" }).returning({ id: connection.id });
    const base = { org: { name: "Bank 2" }, currency: "USD", balance: "100.00", "balance-date": unix("2026-11-03", 6), transactions: [] };
    const joint = await upsertSimplefinAccount(t.db, conn!.id, { ...base, id: "J-1", name: "Joint Checking" });
    const mortgage = await upsertSimplefinAccount(t.db, conn!.id, { ...base, id: "M-1", name: "Home Mortgage", balance: "-250000.00" });
    const rows = await t.db.select({ id: account.id, type: account.type, onBudget: account.onBudget, taxTreatment: account.taxTreatment }).from(account).where(eq(account.connectionId, conn!.id));
    expect(rows.find((r) => r.id === joint.id)).toMatchObject({ type: "checking", onBudget: true, taxTreatment: "none" });
    expect(rows.find((r) => r.id === mortgage.id)).toMatchObject({ type: "loan", onBudget: false });
  });
});
