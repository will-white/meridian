import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IsoDate } from "@meridian/shared";
import type { Db } from "../index.js";
import { account, alert, category, connection, payee, recurring, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { seedDefaultCategories } from "./categories.js";
import { resolvePayee } from "./payees.js";
import { createManualRecurring, matchRecurringItems, refreshRecurringItem, runRecurringDetection, setRecurringStatus } from "./recurring.js";

/** Review probes for the recurring service: state transitions and identity across runs. */

const TODAY: IsoDate = "2026-10-13";
const NOW = new Date("2026-10-13T08:00:00Z");

let t: TestDb;
let db: Db;
let accountA: string;
let subscriptions: string;

async function addTx(input: { payee: string; date: IsoDate; cents: bigint }): Promise<string> {
  const p = await resolvePayee(db, input.payee);
  const [row] = await db
    .insert(transaction)
    .values({ accountId: accountA, source: "manual", date: input.date, amountCents: input.cents, payeeId: p.id, rawDescription: input.payee, pending: false, isTransfer: false })
    .returning({ id: transaction.id });
  return row!.id;
}

async function itemsOf(payeeName: string) {
  return db
    .select({ row: recurring })
    .from(recurring)
    .innerJoin(payee, eq(payee.id, recurring.payeeId))
    .where(eq(payee.name, payeeName))
    .orderBy(asc(recurring.createdAt))
    .then((rows) => rows.map((r) => r.row));
}

async function alertCount(): Promise<number> {
  const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(alert);
  return a!.n;
}

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  await seedDefaultCategories(db);
  const [conn] = await db.insert(connection).values({ type: "simplefin", name: "Test" }).returning();
  const [a] = await db.insert(account).values({ connectionId: conn!.id, externalId: "A", name: "Checking", type: "checking", taxTreatment: "none" }).returning({ id: account.id });
  accountA = a!.id;
  const cats = await db.select({ id: category.id, name: category.name }).from(category);
  subscriptions = cats.find((c) => c.name === "Subscriptions")!.id;
});
afterAll(async () => {
  await t?.cleanup();
});

describe.skipIf(!TEST_DATABASE_URL)("review: resume after auto-pause", () => {
  it("restarts the missed clock today: not re-paused, next due is the first occurrence on/after today", async () => {
    for (const d of ["2026-02-05", "2026-03-05", "2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05"]) await addTx({ payee: "Gym", date: d, cents: -4999n });
    await runRecurringDetection(db, { today: "2026-07-10", now: new Date("2026-07-10T08:00:00Z") });
    const [s] = await itemsOf("Gym");
    expect(s!.status).toBe("suggested");
    await db.update(recurring).set({ categoryId: subscriptions }).where(eq(recurring.id, s!.id));
    await setRecurringStatus(db, s!.id, "active", { today: "2026-07-10", now: new Date("2026-07-10T08:00:00Z") });
    await refreshRecurringItem(db, s!.id, TODAY, NOW);
    let row = (await itemsOf("Gym"))[0]!;
    expect([row.status, row.statusReason, row.consecutiveMissed, row.nextDueDate]).toEqual(["paused", "missed_3", 3, "2026-11-05"]);
    const before = await alertCount();

    await setRecurringStatus(db, s!.id, "active", { today: TODAY, now: NOW });
    row = (await itemsOf("Gym"))[0]!;
    expect([row.status, row.statusReason, row.consecutiveMissed, row.missedFromDate, row.nextDueDate]).toEqual(["active", null, 0, TODAY, "2026-11-05"]);
    expect(await alertCount()).toBe(before);
    await refreshRecurringItem(db, s!.id, "2026-10-20", new Date("2026-10-20T08:00:00Z"));
    row = (await itemsOf("Gym"))[0]!;
    expect([row.status, row.consecutiveMissed]).toEqual(["active", 0]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("review: dismissed stays dismissed while the series continues", () => {
  it("the matcher links the new charge to the dismissed row and the re-run neither re-suggests nor alerts", async () => {
    for (const d of ["2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"]) await addTx({ payee: "Netflix", date: d, cents: -1549n });
    await runRecurringDetection(db, { today: TODAY, now: NOW });
    const [s] = await itemsOf("Netflix");
    await setRecurringStatus(db, s!.id, "dismissed", { today: TODAY, now: NOW });
    const octId = await addTx({ payee: "Netflix", date: "2026-10-05", cents: -1549n });
    const alertsBefore = await alertCount();
    await runRecurringDetection(db, { today: "2026-10-20", now: new Date("2026-10-20T08:00:00Z") });
    const rows = await itemsOf("Netflix");
    expect(rows.map((r) => r.status)).toEqual(["dismissed"]);
    expect(rows[0]!.chargeCount).toBe(7);
    const [oct] = await db.select({ recurringId: transaction.recurringId }).from(transaction).where(eq(transaction.id, octId));
    expect(oct!.recurringId).toBe(s!.id);
    expect(await alertCount()).toBe(alertsBefore);
    // Re-run on the same ledger: still one row.
    await runRecurringDetection(db, { today: "2026-10-21", now: new Date("2026-10-21T08:00:00Z") });
    expect((await itemsOf("Netflix")).map((r) => r.status)).toEqual(["dismissed"]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("review: confirm inside the grace window and derived twice-monthly days", () => {
  it("confirming on the due date + 3 (grace 5) raises nothing and keeps next due on that occurrence", async () => {
    for (const d of ["2026-07-10", "2026-08-10", "2026-09-10"]) await addTx({ payee: "Hulu", date: d, cents: -1799n });
    await runRecurringDetection(db, { today: "2026-10-13", now: NOW });
    const [s] = await itemsOf("Hulu");
    expect(s!.nextDueDate).toBe("2026-10-10");
    await db.update(recurring).set({ categoryId: subscriptions }).where(eq(recurring.id, s!.id));
    const before = await alertCount();
    await setRecurringStatus(db, s!.id, "active", { today: "2026-10-13", now: NOW });
    const row = (await itemsOf("Hulu"))[0]!;
    expect([row.status, row.consecutiveMissed, row.nextDueDate, row.missedFromDate]).toEqual(["active", 0, "2026-10-10", "2026-09-10"]);
    expect(await alertCount()).toBe(before);
  });

  it("a manual twice-monthly item with only anchorDay derives the second day and matches the current period", async () => {
    const txId = await addTx({ payee: "Landlord", date: "2026-10-01", cents: -90000n });
    const id = await createManualRecurring(
      db,
      { name: "Rent half", payeeName: "Landlord", categoryId: subscriptions, accountId: accountA, cadence: "twice_monthly", anchorDay: 1, expectedCents: -90000n },
      TODAY,
      { now: NOW },
    );
    const [row] = await db.select().from(recurring).where(eq(recurring.id, id));
    expect([row!.anchorDay, row!.anchorDay2]).toEqual([1, null]);
    const [tx] = await db.select({ recurringId: transaction.recurringId }).from(transaction).where(eq(transaction.id, txId));
    expect(tx!.recurringId).toBe(id);
    expect(row!.nextDueDate).toBe("2026-10-16");
    expect(await matchRecurringItems(db, TODAY, NOW, { ids: [id] })).toBe(0);
  });
});
