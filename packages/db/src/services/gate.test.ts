import { eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, mapCsvRows } from "@meridian/shared";
import { account, category, connection, payee, rule, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { ACCOUNTS, buildTruth, expectedFinalCount, FIXTURE_END, FIXTURE_START, renderAccountSet } from "../test/fixture.js";
import { seedDefaultCategories } from "./categories.js";
import { importCsvRows } from "./csvImport.js";
import { loadRules, runRules } from "./rules.js";
import { applyAccountSet } from "./sync.js";

/**
 * Phase 1 gate, on a deterministic three-month household:
 * two overlapping syncs plus a repeat produce no duplicates, pending items are
 * replaced when they post, transfers pair, rules apply, and a CSV re-import is idempotent.
 */
describe.skipIf(!TEST_DATABASE_URL)("Phase 1 gate: three months through overlapping syncs", () => {
  let t: TestDb;
  let connectionId: string;
  const truth = buildTruth();
  const day60 = addDays(FIXTURE_START, 60);
  const day53 = addDays(FIXTURE_START, 53);

  beforeAll(async () => {
    t = await createTestDb();
    await seedDefaultCategories(t.db);
    const [conn] = await t.db.insert(connection).values({ type: "simplefin", name: "First Example Bank" }).returning();
    connectionId = conn!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  async function countRows() {
    const [row] = await t.db.select({ n: sql<number>`count(*)::int` }).from(transaction);
    return row!.n;
  }
  async function duplicateKeys() {
    return t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(transaction)
      .where(isNotNull(transaction.externalId))
      .groupBy(transaction.accountId, transaction.externalId)
      .having(sql`count(*) > 1`);
  }

  let pendingAfterFirstSync: Array<{ id: string; externalId: string | null }> = [];
  let lockedPendingId: string;

  it("sync 1: first 60 days land, with pending card charges still pending", async () => {
    const set = renderAccountSet({ start: FIXTURE_START, asOf: day60, truth });
    const result = await applyAccountSet(t.db, { connectionId, accountSet: set, windowStart: FIXTURE_START });
    expect(result.accounts).toBe(3);
    expect(result.accountsCreated).toBe(3);
    expect(result.stats.created).toBe(set.accounts.reduce((n, a) => n + a.transactions.length, 0));
    expect(result.errors).toEqual([]);

    const accounts = await t.db.select().from(account);
    const byExt = Object.fromEntries(accounts.map((a) => [a.externalId, a]));
    expect(byExt[ACCOUNTS.card.id]!.type).toBe("credit");
    expect(byExt[ACCOUNTS.savings.id]!.type).toBe("savings");
    expect(byExt[ACCOUNTS.checking.id]!.balanceCents).toBe(421055n);
    expect(byExt[ACCOUNTS.checking.id]!.institution).toBe("First Example Bank");

    pendingAfterFirstSync = await t.db.select({ id: transaction.id, externalId: transaction.externalId }).from(transaction).where(eq(transaction.pending, true));
    expect(pendingAfterFirstSync.length).toBeGreaterThan(0);

    // The user categorizes one pending charge by hand before it posts.
    const [groceries] = await t.db.select({ id: category.id }).from(category).where(eq(category.name, "Groceries"));
    lockedPendingId = pendingAfterFirstSync[0]!.id;
    await t.db.update(transaction).set({ categoryId: groceries!.id, categoryLocked: true }).where(eq(transaction.id, lockedPendingId));
  });

  it("sync 2: overlapping window posts the pending charges in place and adds the rest", async () => {
    const before = await countRows();
    const set = renderAccountSet({ start: day53, asOf: FIXTURE_END, truth });
    const result = await applyAccountSet(t.db, { connectionId, accountSet: set, windowStart: day53 });

    expect(result.stats.replacedPending).toBe(pendingAfterFirstSync.length - 1); // all but the voided hold
    expect(result.stats.removedPending).toBe(1); // the voided hotel hold
    expect(result.errors).toEqual([]);
    expect(await duplicateKeys()).toEqual([]);

    const after = await countRows();
    expect(after).toBe(before + result.stats.created - result.stats.removedPending);

    // Replaced rows kept their ids and now carry the posted id.
    for (const p of pendingAfterFirstSync) {
      const [row] = await t.db.select().from(transaction).where(eq(transaction.id, p.id));
      if (p.externalId === "CARD-PEND-VOID") {
        expect(row).toBeUndefined();
        continue;
      }
      expect(row).toBeDefined();
      expect(row!.pending).toBe(false);
      expect(row!.externalId).toBe(p.externalId!.replace("CARD-PEND-", "CARD-POST-"));
    }
    const [locked] = await t.db.select().from(transaction).where(eq(transaction.id, lockedPendingId));
    expect(locked!.categoryLocked).toBe(true);
    expect(locked!.categoryId).not.toBeNull();
    // Only charges from the last two days (not yet posted on the as-of day) may still be pending.
    const pendingLeft = await t.db.select().from(transaction).where(eq(transaction.pending, true));
    const stillPendingTruth = truth.filter((e) => !e.neverPosts && addDays(e.date, e.postLag) > FIXTURE_END).map((e) => e.pendingId);
    expect(pendingLeft.map((p) => p.externalId).sort()).toEqual([...stillPendingTruth].sort());
  });

  it("sync 3: repeating the same window changes nothing", async () => {
    const before = await countRows();
    const set = renderAccountSet({ start: day53, asOf: FIXTURE_END, truth });
    const result = await applyAccountSet(t.db, { connectionId, accountSet: set, windowStart: day53 });
    expect(result.stats).toMatchObject({ created: 0, updated: 0, replacedPending: 0, removedPending: 0, skipped: 0 });
    expect(result.transfersPaired).toBe(0);
    expect(await countRows()).toBe(before);
    expect(await duplicateKeys()).toEqual([]);
  });

  it("every truth event is present exactly once", async () => {
    expect(await countRows()).toBe(expectedFinalCount(truth));
    const ids = new Set((await t.db.select({ ext: transaction.externalId }).from(transaction)).map((r) => r.ext));
    for (const ev of truth) {
      if (ev.neverPosts) expect(ids.has(ev.pendingId!)).toBe(false);
      else if (addDays(ev.date, ev.postLag) > FIXTURE_END) expect(ids.has(ev.pendingId!)).toBe(true);
      else expect(ids.has(ev.postedId)).toBe(true);
    }
  });

  it("transfers: every card payment and savings sweep is paired; paychecks and rent are not", async () => {
    const rows = await t.db.select().from(transaction);
    const byExt = new Map(rows.map((r) => [r.externalId!, r]));
    const months = ["2026-07", "2026-08", "2026-09"];
    for (const m of months) {
      const out = byExt.get(`CHK-CCPAY-${m}`)!;
      const inn = byExt.get(`CARD-PAYRCV-${m}`)!;
      expect(out.transferPairId).toBeTruthy();
      expect(out.transferPairId).toBe(inn.transferPairId);
      expect(out.isTransfer && inn.isTransfer).toBe(true);
      const sOut = byExt.get(`CHK-XFER-${m}`)!;
      const sIn = byExt.get(`SAV-XFER-${m}`)!;
      expect(sOut.transferPairId).toBeTruthy();
      expect(sOut.transferPairId).toBe(sIn.transferPairId);
    }
    const paired = rows.filter((r) => r.transferPairId !== null);
    expect(paired).toHaveLength(12); // 3 card payments + 3 sweeps, two legs each
    for (const r of rows) {
      if (r.externalId!.startsWith("CHK-PAY-") || r.externalId!.startsWith("CHK-RENT-") || r.externalId!.startsWith("CARD-POST-")) {
        expect(r.transferPairId).toBeNull();
        expect(r.isTransfer).toBe(false);
      }
    }
  });

  it("payees are normalized across the pending and posted descriptions", async () => {
    const rows = await t.db
      .select({ name: payee.name, n: sql<number>`count(*)::int` })
      .from(transaction)
      .innerJoin(payee, eq(payee.id, transaction.payeeId))
      .groupBy(payee.name);
    const names = Object.fromEntries(rows.map((r) => [r.name, r.n]));
    expect(names["King Soopers"]).toBeGreaterThan(0);
    expect(names["Blue Bottle Coffee"]).toBeGreaterThan(0);
    expect(names["Shell Oil"]).toBeGreaterThan(0);
    expect(names["Acme Corp Payroll"]).toBe(7);
    expect(names["Xcel Energy"]).toBe(3);
    expect(Object.keys(names).some((n) => /denver|aurora/i.test(n))).toBe(false);
  });

  it("'always do this': a rule created from one transaction categorizes the rest, now and on the next sync", async () => {
    const [paycheck] = await t.db.select({ id: category.id }).from(category).where(eq(category.name, "Paycheck"));
    await t.db.insert(rule).values({
      name: "Acme payroll",
      position: 1,
      conditions: { payee: { op: "equals", value: "Acme Corp Payroll" } },
      actions: { setCategoryId: paycheck!.id },
    });
    const rules = await loadRules(t.db);
    const applied = await runRules(t.db, { scope: "uncategorized", rules });
    expect(applied.changed).toBe(7);
    const rows = await t.db
      .select({ categoryId: transaction.categoryId })
      .from(transaction)
      .where(sql`${transaction.externalId} like 'CHK-PAY-%'`);
    expect(rows.every((r) => r.categoryId === paycheck!.id)).toBe(true);

    // A later sync with one more paycheck picks the rule up automatically.
    const extra = renderAccountSet({ start: day53, asOf: FIXTURE_END, truth });
    extra.accounts[0]!.transactions.push({ id: "CHK-PAY-NEXT", posted: 1_790_000_000, amount: "2500.00", description: "ACME CORP PAYROLL DIRECT DEP", pending: false });
    await applyAccountSet(t.db, { connectionId, accountSet: extra, windowStart: day53 });
    const [next] = await t.db.select().from(transaction).where(eq(transaction.externalId, "CHK-PAY-NEXT"));
    expect(next!.categoryId).toBe(paycheck!.id);
  });

  it("CSV import of the same statement twice is idempotent and pairs transfers", async () => {
    const [conn] = await t.db.insert(connection).values({ type: "csv", name: "Credit Union CSV" }).returning();
    const [cu] = await t.db
      .insert(account)
      .values({ connectionId: conn!.id, externalId: null, name: "Credit Union Checking", type: "checking", taxTreatment: "none" })
      .returning({ id: account.id });
    const csv = [
      ["Date", "Description", "Debit", "Credit"],
      ["09/03/2026", "GROCERY OUTLET #12", "54.10", ""],
      ["09/03/2026", "GROCERY OUTLET #12", "54.10", ""],
      ["09/15/2026", "TRANSFER TO HIGH YIELD SAVINGS", "500.00", ""], // pairs with the savings leg of 2026-09-15? No: that leg is already paired. Use a new amount below.
      ["09/20/2026", "TRANSFER TO SAPPHIRE VISA", "123.45", ""],
      ["09/22/2026", "ACME CORP PAYROLL", "", "2500.00"],
    ];
    const { rows } = await mapCsvRows(csv, {
      hasHeader: true,
      date: { column: "Date", format: "MM/DD/YYYY" },
      description: { column: "Description" },
      amount: { mode: "split", debitColumn: "Debit", creditColumn: "Credit" },
    });
    // A matching inflow on the card two days later.
    await t.db.insert(transaction).values({
      accountId: (await t.db.select({ id: account.id }).from(account).where(eq(account.externalId, ACCOUNTS.card.id)))[0]!.id,
      externalId: "CARD-PAYRCV-EXTRA",
      source: "simplefin",
      date: "2026-09-22",
      amountCents: 12345n,
      rawDescription: "PAYMENT THANK YOU - WEB",
    });

    const first = await importCsvRows(t.db, { accountId: cu!.id, rows });
    expect(first).toMatchObject({ created: 5, updated: 0, skipped: 0, transfersPaired: 1 });
    const second = await importCsvRows(t.db, { accountId: cu!.id, rows });
    expect(second).toMatchObject({ created: 0, updated: 0, skipped: 0, transfersPaired: 0 });
    expect(await duplicateKeys()).toEqual([]);
    const cuRows = await t.db.select().from(transaction).where(eq(transaction.accountId, cu!.id));
    expect(cuRows).toHaveLength(5);
    expect(cuRows.filter((r) => r.isTransfer)).toHaveLength(1);
  });
});
