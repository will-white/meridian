import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizePayee, type RuleLike } from "@meridian/shared";
import { account, category, connection, payee, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { ingestTransactions, type IncomingTransaction } from "./ingest.js";
import { pairTransfersInDb } from "./transfers.js";
import { seedDefaultCategories } from "./categories.js";
import { loadRules, runRules } from "./rules.js";
import { rule } from "../schema/index.js";

describe.skipIf(!TEST_DATABASE_URL)("ingestTransactions", () => {
  let t: TestDb;
  let checking: string;
  let card: string;
  let groceries: string;

  beforeAll(async () => {
    t = await createTestDb();
    await seedDefaultCategories(t.db);
    const [conn] = await t.db.insert(connection).values({ type: "simplefin", name: "Test" }).returning();
    const rows = await t.db
      .insert(account)
      .values([
        { connectionId: conn!.id, externalId: "CHK", name: "Checking", type: "checking", taxTreatment: "none" },
        { connectionId: conn!.id, externalId: "CARD", name: "Card", type: "credit", taxTreatment: "none" },
      ])
      .returning({ id: account.id });
    checking = rows[0]!.id;
    card = rows[1]!.id;
    const [g] = await t.db.select({ id: category.id }).from(category).where(eq(category.name, "Groceries"));
    groceries = g!.id;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const base = (overrides: Partial<IncomingTransaction> & { externalId: string }): IncomingTransaction => ({
    date: "2026-09-10",
    amountCents: -4532n,
    description: "KING SOOPERS #0123 DENVER CO",
    pending: false,
    ...overrides,
  });

  it("inserts new rows with a normalized payee and dedupes by (account, external id)", async () => {
    const items = [base({ externalId: "T1" }), base({ externalId: "T2", amountCents: -1250n, description: "SQ *BLUE BOTTLE COFFEE" })];
    const first = await ingestTransactions(t.db, items, { accountId: checking, source: "simplefin", rules: [] });
    expect(first).toMatchObject({ created: 2, updated: 0, replacedPending: 0, removedPending: 0, skipped: 0 });

    const second = await ingestTransactions(t.db, items, { accountId: checking, source: "simplefin", rules: [] });
    expect(second).toMatchObject({ created: 0, updated: 0, replacedPending: 0, skipped: 0 });

    const rows = await t.db
      .select({ ext: transaction.externalId, payee: payee.name })
      .from(transaction)
      .leftJoin(payee, eq(payee.id, transaction.payeeId))
      .where(eq(transaction.accountId, checking));
    expect(rows.map((r) => [r.ext, r.payee]).sort()).toEqual([
      ["T1", "King Soopers"],
      ["T2", "Blue Bottle Coffee"],
    ]);
  });

  it("refreshes bank-owned fields on a known id but keeps user edits", async () => {
    await t.db.update(transaction).set({ categoryId: groceries, categoryLocked: true, notes: "mine" }).where(eq(transaction.externalId, "T1"));
    const stats = await ingestTransactions(t.db, [base({ externalId: "T1", amountCents: -4600n, description: "KING SOOPERS #0123 DENVER CO (ADJ)" })], {
      accountId: checking,
      source: "simplefin",
      rules: [],
    });
    expect(stats).toMatchObject({ created: 0, updated: 1 });
    const [row] = await t.db.select().from(transaction).where(eq(transaction.externalId, "T1"));
    expect(row!.amountCents).toBe(-4600n);
    expect(row!.rawDescription).toBe("KING SOOPERS #0123 DENVER CO (ADJ)");
    expect(row!.categoryId).toBe(groceries);
    expect(row!.notes).toBe("mine");
  });

  it("replaces a pending row in place when it posts under a new id, keeping the row id and category", async () => {
    const pendingStats = await ingestTransactions(t.db, [base({ externalId: "PEND-1", date: "2026-09-12", amountCents: -2200n, description: "SHELL OIL 57442", pending: true })], {
      accountId: card,
      source: "simplefin",
      windowStart: "2026-09-01",
      rules: [],
    });
    expect(pendingStats.created).toBe(1);
    const [pendingRow] = await t.db.select().from(transaction).where(eq(transaction.externalId, "PEND-1"));
    await t.db.update(transaction).set({ categoryId: groceries, categoryLocked: true }).where(eq(transaction.id, pendingRow!.id));

    const postedStats = await ingestTransactions(
      t.db,
      [base({ externalId: "POST-1", date: "2026-09-14", amountCents: -2200n, description: "SHELL OIL 57442 AURORA CO", pending: false, postedAt: new Date("2026-09-14T12:00:00Z") })],
      { accountId: card, source: "simplefin", windowStart: "2026-09-01", rules: [] },
    );
    expect(postedStats).toMatchObject({ created: 0, replacedPending: 1, removedPending: 0 });

    const rows = await t.db.select().from(transaction).where(eq(transaction.accountId, card));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(pendingRow!.id);
    expect(rows[0]!.externalId).toBe("POST-1");
    expect(rows[0]!.pending).toBe(false);
    expect(rows[0]!.date).toBe("2026-09-14");
    expect(rows[0]!.categoryId).toBe(groceries);
  });

  it("removes a pending row the feed stopped returning inside the window", async () => {
    await ingestTransactions(t.db, [base({ externalId: "PEND-VOID", date: "2026-09-20", amountCents: -4500n, description: "HOTEL HOLD", pending: true })], {
      accountId: card,
      source: "simplefin",
      windowStart: "2026-09-01",
      rules: [],
    });
    const stats = await ingestTransactions(t.db, [base({ externalId: "POST-1", date: "2026-09-14", amountCents: -2200n, description: "SHELL OIL 57442 AURORA CO" })], {
      accountId: card,
      source: "simplefin",
      windowStart: "2026-09-01",
      rules: [],
    });
    expect(stats.removedPending).toBe(1);
    const gone = await t.db.select().from(transaction).where(eq(transaction.externalId, "PEND-VOID"));
    expect(gone).toHaveLength(0);
  });

  it("does not remove pending rows on a CSV import (no window)", async () => {
    await ingestTransactions(t.db, [base({ externalId: "PEND-KEEP", date: "2026-09-21", amountCents: -999n, description: "GAS", pending: true })], {
      accountId: card,
      source: "simplefin",
      windowStart: "2026-09-01",
      rules: [],
    });
    const stats = await ingestTransactions(t.db, [base({ externalId: "csv:abc", date: "2026-09-01", amountCents: -100n, description: "SOMETHING" })], {
      accountId: card,
      source: "csv",
      rules: [],
    });
    expect(stats.removedPending).toBe(0);
    const kept = await t.db.select().from(transaction).where(eq(transaction.externalId, "PEND-KEEP"));
    expect(kept).toHaveLength(1);
  });

  it("applies rules and the payee default category to new rows", async () => {
    const rules: RuleLike[] = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        position: 1,
        enabled: true,
        conditions: { description: { op: "contains", value: "PAYROLL" } },
        actions: { setPayee: "Acme Corp", addTags: ["income"] },
      },
    ];
    await t.db.update(payee).set({ defaultCategoryId: groceries }).where(eq(payee.name, "King Soopers"));
    const stats = await ingestTransactions(
      t.db,
      [
        base({ externalId: "PAY-1", amountCents: 250000n, description: "ACME CORP PAYROLL DIRECT DEP" }),
        base({ externalId: "KS-2", amountCents: -1000n, description: "KING SOOPERS #0123 DENVER CO" }),
      ],
      { accountId: checking, source: "simplefin", rules },
    );
    expect(stats.created).toBe(2);
    const rows = await t.db
      .select({ ext: transaction.externalId, payee: payee.name, categoryId: transaction.categoryId })
      .from(transaction)
      .leftJoin(payee, eq(payee.id, transaction.payeeId))
      .where(and(eq(transaction.accountId, checking), sql`${transaction.externalId} in ('PAY-1','KS-2')`));
    const byExt = Object.fromEntries(rows.map((r) => [r.ext, r]));
    expect(byExt["PAY-1"]!.payee).toBe("Acme Corp");
    expect(byExt["KS-2"]!.categoryId).toBe(groceries);
  });

  it("counts an id repeated inside one payload as skipped, not as a duplicate row", async () => {
    const stats = await ingestTransactions(t.db, [base({ externalId: "DUP" }), base({ externalId: "DUP", amountCents: -1n })], {
      accountId: checking,
      source: "simplefin",
      rules: [],
    });
    expect(stats).toMatchObject({ created: 1, skipped: 1 });
    const rows = await t.db.select().from(transaction).where(eq(transaction.externalId, "DUP"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountCents).toBe(-1n);
  });

  it("never ends up with two rows for one (account, external id)", async () => {
    const dupes = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(transaction)
      .where(isNotNull(transaction.externalId))
      .groupBy(transaction.accountId, transaction.externalId)
      .having(sql`count(*) > 1`);
    expect(dupes).toHaveLength(0);
  });

  it("runRules re-categorizes uncategorized rows without touching locked ones", async () => {
    await t.db.insert(rule).values({
      name: "Coffee",
      position: 1,
      conditions: { payee: { op: "equals", value: "Blue Bottle Coffee" } },
      actions: { setCategoryId: groceries, addTags: ["coffee"] },
    });
    const loaded = await loadRules(t.db);
    expect(loaded).toHaveLength(1);
    const result = await runRules(t.db, { scope: "uncategorized" });
    expect(result.changed).toBeGreaterThanOrEqual(1);
    const [coffee] = await t.db.select().from(transaction).where(eq(transaction.externalId, "T2"));
    expect(coffee!.categoryId).toBe(groceries);
    expect(coffee!.categoryLocked).toBe(false);
  });

  it("pairTransfersInDb pairs equal and opposite amounts across accounts within 3 days", async () => {
    await ingestTransactions(t.db, [base({ externalId: "XFER-OUT", date: "2026-09-05", amountCents: -75000n, description: "ONLINE PAYMENT TO SAPPHIRE VISA" })], {
      accountId: checking,
      source: "simplefin",
      rules: [],
    });
    await ingestTransactions(t.db, [base({ externalId: "XFER-IN", date: "2026-09-06", amountCents: 75000n, description: "PAYMENT THANK YOU" })], {
      accountId: card,
      source: "simplefin",
      rules: [],
    });
    const paired = await t.db.transaction((tx) => pairTransfersInDb(tx, { since: "2026-09-01" }));
    expect(paired).toBe(1);
    const legs = await t.db.select().from(transaction).where(sql`${transaction.externalId} in ('XFER-OUT','XFER-IN')`);
    expect(legs).toHaveLength(2);
    expect(legs[0]!.transferPairId).toBe(legs[1]!.transferPairId);
    expect(legs.every((l) => l.isTransfer && l.categoryId === null)).toBe(true);
    // Running again finds nothing new.
    expect(await t.db.transaction((tx) => pairTransfersInDb(tx, { since: "2026-09-01" }))).toBe(0);
  });

  it("normalizes consistently between the pending and posted descriptions", () => {
    expect(normalizePayee("SHELL OIL 57442")).toBe(normalizePayee("SHELL OIL 57442 AURORA CO"));
  });
});
