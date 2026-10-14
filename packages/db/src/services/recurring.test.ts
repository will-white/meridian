import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Cadence, IsoDate, RecurringStatus } from "@meridian/shared";
import type { Db } from "../index.js";
import { account, alert, category, connection, payee, recurring, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { seedDefaultCategories } from "./categories.js";
import { resolvePayee } from "./payees.js";
import {
  RecurringError,
  createManualRecurring,
  deleteRecurring,
  linkTransaction,
  listRecurring,
  listSubscriptions,
  matchRecurringItems,
  raiseAlert,
  refreshRecurringItem,
  runRecurringDetection,
  setRecurringStatus,
  unlinkTransactionFromRecurring,
  updateRecurring,
} from "./recurring.js";

const TODAY: IsoDate = "2026-10-13";
const at = (iso: string): Date => new Date(iso);
const NOW = at("2026-10-13T08:00:00Z");

type StoredRecurring = typeof recurring.$inferSelect;
type StoredAlert = typeof alert.$inferSelect;

interface Fixture {
  t: TestDb;
  db: Db;
  accountA: string;
  accountB: string;
  subscriptions: string;
  utilities: string;
}

async function setup(): Promise<Fixture> {
  const t = await createTestDb();
  await seedDefaultCategories(t.db);
  const [conn] = await t.db.insert(connection).values({ type: "simplefin", name: "Test" }).returning();
  const rows = await t.db
    .insert(account)
    .values([
      { connectionId: conn!.id, externalId: "A", name: "Checking", type: "checking", taxTreatment: "none" },
      { connectionId: conn!.id, externalId: "B", name: "Card", type: "credit", taxTreatment: "none" },
    ])
    .returning({ id: account.id });
  const cats = await t.db.select({ id: category.id, name: category.name }).from(category);
  const cat = (name: string) => cats.find((c) => c.name === name)!.id;
  return { t, db: t.db, accountA: rows[0]!.id, accountB: rows[1]!.id, subscriptions: cat("Subscriptions"), utilities: cat("Utilities") };
}

async function addTx(db: Db, input: { accountId: string; payee: string; date: IsoDate; cents: bigint; pending?: boolean; isTransfer?: boolean }): Promise<string> {
  const p = await resolvePayee(db, input.payee);
  const [row] = await db
    .insert(transaction)
    .values({
      accountId: input.accountId,
      source: "manual",
      date: input.date,
      amountCents: input.cents,
      payeeId: p.id,
      rawDescription: input.payee,
      pending: input.pending ?? false,
      isTransfer: input.isTransfer ?? false,
    })
    .returning({ id: transaction.id });
  return row!.id;
}

async function addSeries(db: Db, accountId: string, payeeName: string, cents: bigint, dates: readonly IsoDate[]): Promise<string[]> {
  const ids: string[] = [];
  for (const date of dates) ids.push(await addTx(db, { accountId, payee: payeeName, date, cents }));
  return ids;
}

async function itemsOf(db: Db, payeeName: string): Promise<StoredRecurring[]> {
  return db
    .select({ row: recurring })
    .from(recurring)
    .innerJoin(payee, eq(payee.id, recurring.payeeId))
    .where(eq(payee.name, payeeName))
    .orderBy(asc(recurring.createdAt), asc(recurring.id))
    .then((rows) => rows.map((r) => r.row));
}

async function item(db: Db, id: string): Promise<StoredRecurring> {
  const [row] = await db.select().from(recurring).where(eq(recurring.id, id));
  return row!;
}

async function linksOf(db: Db, id: string): Promise<string[]> {
  const rows = await db.select({ id: transaction.id }).from(transaction).where(eq(transaction.recurringId, id));
  return rows.map((r) => r.id).sort();
}

async function alertsOf(db: Db, recurringId: string): Promise<StoredAlert[]> {
  return db.select().from(alert).where(eq(alert.recurringId, recurringId)).orderBy(asc(alert.dueDate), asc(alert.createdAt));
}

async function countRows(db: Db): Promise<{ items: number; alerts: number }> {
  const [i] = await db.select({ n: sql<number>`count(*)::int` }).from(recurring);
  const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(alert);
  return { items: i!.n, alerts: a!.n };
}

interface InsertItemInput {
  payeeName: string;
  accountId?: string | null;
  categoryId?: string | null;
  cadence: Cadence;
  anchorDay?: number | null;
  anchorDay2?: number | null;
  anchorMonth?: number | null;
  anchorDate?: IsoDate | null;
  expectedCents: bigint;
  toleranceCents?: bigint;
  amountMode?: "fixed" | "variable";
  amountLocked?: boolean;
  scheduleLocked?: boolean;
  status?: RecurringStatus;
  source?: "detected" | "manual";
  missedFromDate?: IsoDate | null;
  lastChargeDate?: IsoDate | null;
  lastChargeCents?: bigint | null;
  nextDueDate?: IsoDate | null;
  consecutiveMissed?: number;
  confidence?: number | null;
  name?: string;
  linkIds?: readonly string[];
  createdAt?: Date;
}

/** A hand-built row (plus links) for tests that start from a known state instead of a detector run. */
async function insertItem(db: Db, input: InsertItemInput): Promise<string> {
  const p = await resolvePayee(db, input.payeeName);
  const createdAt = input.createdAt ?? NOW;
  const [row] = await db
    .insert(recurring)
    .values({
      payeeId: p.id,
      categoryId: input.categoryId ?? null,
      accountId: input.accountId ?? null,
      name: input.name ?? p.name,
      cadence: input.cadence,
      anchorDay: input.anchorDay ?? null,
      anchorDay2: input.anchorDay2 ?? null,
      anchorMonth: input.anchorMonth ?? null,
      anchorDate: input.anchorDate ?? null,
      expectedCents: input.expectedCents,
      toleranceCents: input.toleranceCents ?? 100n,
      amountMode: input.amountMode ?? "fixed",
      amountLocked: input.amountLocked ?? false,
      scheduleLocked: input.scheduleLocked ?? false,
      status: input.status ?? "active",
      source: input.source ?? "detected",
      missedFromDate: input.missedFromDate ?? null,
      lastChargeDate: input.lastChargeDate ?? null,
      lastChargeCents: input.lastChargeCents ?? null,
      nextDueDate: input.nextDueDate ?? null,
      chargeCount: input.linkIds?.length ?? 0,
      consecutiveMissed: input.consecutiveMissed ?? 0,
      confidence: input.confidence ?? null,
      statusChangedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    })
    .returning({ id: recurring.id });
  const id = row!.id;
  if (input.linkIds && input.linkIds.length > 0) await db.update(transaction).set({ recurringId: id }).where(inArray(transaction.id, [...input.linkIds]));
  return id;
}

const NETFLIX_DATES: IsoDate[] = ["2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"];

describe.skipIf(!TEST_DATABASE_URL)("refresh and matcher (TC7, TC8, TC17, manual items)", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("TC7: a missed charge alerts the day after grace, re-runs do not duplicate it, a late charge resolves it", async () => {
    const ids = await addSeries(f.db, f.accountA, "Netflix", -1549n, NETFLIX_DATES);
    const id = await insertItem(f.db, {
      payeeName: "Netflix",
      accountId: f.accountA,
      categoryId: f.subscriptions,
      cadence: "monthly",
      anchorDay: 5,
      expectedCents: -1549n,
      toleranceCents: 100n,
      missedFromDate: "2026-09-05",
      lastChargeDate: "2026-09-05",
      lastChargeCents: -1549n,
      linkIds: ids,
    });

    let r = await refreshRecurringItem(f.db, id, "2026-10-10", at("2026-10-10T08:00:00Z"));
    expect(r).toEqual({ alertsCreated: 0, autoPaused: false });
    let row = await item(f.db, id);
    expect(row.consecutiveMissed).toBe(0);
    expect(row.nextDueDate).toBe("2026-10-05");
    expect(row.chargeCount).toBe(6);
    expect(row.firstChargeDate).toBe("2026-04-05");
    expect(row.expectedCents).toBe(-1549n);
    expect(row.toleranceCents).toBe(100n);
    expect(row.amountMode).toBe("fixed");
    expect(row.anchorDay).toBe(5);

    r = await refreshRecurringItem(f.db, id, "2026-10-11", at("2026-10-11T08:00:00Z"));
    expect(r.alertsCreated).toBe(1);
    row = await item(f.db, id);
    expect(row.consecutiveMissed).toBe(1);
    expect(row.nextDueDate).toBe("2026-11-05");
    expect(row.status).toBe("active");
    let alerts = await alertsOf(f.db, id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "missed_charge", dedupeKey: `missed:${id}:2026-10-05`, dueDate: "2026-10-05", resolvedAt: null });

    // Second run on the same day: the dedupe key swallows the insert and the state is identical.
    r = await refreshRecurringItem(f.db, id, "2026-10-11", at("2026-10-11T09:00:00Z"));
    expect(r.alertsCreated).toBe(0);
    const again = await item(f.db, id);
    expect(again).toMatchObject({ consecutiveMissed: 1, nextDueDate: "2026-11-05", chargeCount: 6, lastChargeDate: "2026-09-05" });
    expect(await alertsOf(f.db, id)).toHaveLength(1);

    const late = await addTx(f.db, { accountId: f.accountA, payee: "Netflix", date: "2026-10-12", cents: -1549n });
    const matched = await matchRecurringItems(f.db, TODAY, NOW, { ids: [id] });
    expect(matched).toBe(1);
    row = await item(f.db, id);
    expect(row.lastChargeDate).toBe("2026-10-12");
    expect(row.lastChargeCents).toBe(-1549n);
    expect(row.lastTransactionId).toBe(late);
    expect(row.chargeCount).toBe(7);
    expect(row.consecutiveMissed).toBe(0);
    expect(row.nextDueDate).toBe("2026-11-05");
    expect(row.anchorDay).toBe(5);
    expect(await linksOf(f.db, id)).toContain(late);
    alerts = await alertsOf(f.db, id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.resolvedAt).not.toBeNull();
  });

  it("TC8a/c: a fixed item alerts when |new| - |last| exceeds the tolerance, once", async () => {
    const ids = await addSeries(f.db, f.accountA, "Hulu", -1549n, NETFLIX_DATES.slice(1));
    const id = await insertItem(f.db, {
      payeeName: "Hulu",
      accountId: f.accountA,
      categoryId: f.subscriptions,
      cadence: "monthly",
      anchorDay: 5,
      expectedCents: -1549n,
      toleranceCents: 100n,
      missedFromDate: "2026-09-05",
      lastChargeDate: "2026-09-05",
      lastChargeCents: -1549n,
      linkIds: ids,
    });
    const tx = await addTx(f.db, { accountId: f.accountA, payee: "Hulu", date: "2026-10-05", cents: -1799n });
    expect(await matchRecurringItems(f.db, "2026-10-06", at("2026-10-06T08:00:00Z"), { ids: [id] })).toBe(1);

    const alerts = await alertsOf(f.db, id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "price_increase", dedupeKey: `price:${id}:${tx}`, transactionId: tx, oldCents: -1549n, newCents: -1799n });
    const row = await item(f.db, id);
    // last3 {1549, 1549, 1799} spread 250 > 100 → variable; upper median of the last 6 is 1549, band 250.
    expect(row.amountMode).toBe("variable");
    expect(row.expectedCents).toBe(-1549n);
    expect(row.toleranceCents).toBe(250n);
    expect(row.lastChargeCents).toBe(-1799n);
    expect(row.chargeCount).toBe(6);

    // (c) A retried job: same dedupe key → no second row.
    expect(await raiseAlert(f.db, { kind: "price_increase", dedupeKey: `price:${id}:${tx}`, recurringId: id, payeeId: row.payeeId, transactionId: tx, oldCents: -1549n, newCents: -1799n })).toBe(false);
    const r = await refreshRecurringItem(f.db, id, "2026-10-06", at("2026-10-06T09:00:00Z"), { newlyLinkedIds: [tx] });
    expect(r.alertsCreated).toBe(0);
    expect(await alertsOf(f.db, id)).toHaveLength(1);
  });

  it("TC8b: a change within the tolerance raises nothing and the fixed item follows the last charge", async () => {
    const ids = await addSeries(f.db, f.accountA, "Disney", -1549n, NETFLIX_DATES.slice(1));
    const id = await insertItem(f.db, {
      payeeName: "Disney",
      accountId: f.accountA,
      categoryId: f.subscriptions,
      cadence: "monthly",
      anchorDay: 5,
      expectedCents: -1549n,
      toleranceCents: 100n,
      missedFromDate: "2026-09-05",
      lastChargeDate: "2026-09-05",
      lastChargeCents: -1549n,
      linkIds: ids,
    });
    await addTx(f.db, { accountId: f.accountA, payee: "Disney", date: "2026-10-05", cents: -1599n });
    expect(await matchRecurringItems(f.db, "2026-10-06", at("2026-10-06T08:00:00Z"), { ids: [id] })).toBe(1);
    expect(await alertsOf(f.db, id)).toHaveLength(0);
    const row = await item(f.db, id);
    expect(row.amountMode).toBe("fixed");
    expect(row.expectedCents).toBe(-1599n);
    expect(row.toleranceCents).toBe(100n);
  });

  it("TC17: grace days per cadence at the boundary", async () => {
    // Every item is due 2026-10-05; the last charge is the previous occurrence.
    const cases: Array<{ cadence: Cadence; grace: number; lastCharge: IsoDate; anchors: Partial<InsertItemInput>; nextAfter: IsoDate }> = [
      { cadence: "weekly", grace: 2, lastCharge: "2026-09-28", anchors: { anchorDate: "2026-09-28" }, nextAfter: "2026-10-12" },
      { cadence: "biweekly", grace: 3, lastCharge: "2026-09-21", anchors: { anchorDate: "2026-09-21" }, nextAfter: "2026-10-19" },
      { cadence: "twice_monthly", grace: 4, lastCharge: "2026-09-20", anchors: { anchorDay: 5, anchorDay2: 20 }, nextAfter: "2026-10-20" },
      { cadence: "monthly", grace: 5, lastCharge: "2026-09-05", anchors: { anchorDay: 5 }, nextAfter: "2026-11-05" },
      { cadence: "bimonthly", grace: 5, lastCharge: "2026-08-05", anchors: { anchorDay: 5, anchorMonth: 10 }, nextAfter: "2026-12-05" },
      { cadence: "quarterly", grace: 7, lastCharge: "2026-07-05", anchors: { anchorDay: 5, anchorMonth: 10 }, nextAfter: "2027-01-05" },
      { cadence: "semiannual", grace: 10, lastCharge: "2026-04-05", anchors: { anchorDay: 5, anchorMonth: 10 }, nextAfter: "2027-04-05" },
      { cadence: "yearly", grace: 14, lastCharge: "2025-10-05", anchors: { anchorDay: 5, anchorMonth: 10 }, nextAfter: "2027-10-05" },
    ];
    const boundaryDay = (grace: number): IsoDate => `2026-10-${String(5 + grace).padStart(2, "0")}`;
    for (const c of cases) {
      const payeeName = `Grace ${c.cadence}`;
      const [txId] = await addSeries(f.db, f.accountA, payeeName, -1549n, [c.lastCharge]);
      const id = await insertItem(f.db, {
        payeeName,
        accountId: f.accountA,
        categoryId: f.subscriptions,
        cadence: c.cadence,
        ...c.anchors,
        expectedCents: -1549n,
        scheduleLocked: true,
        amountLocked: true,
        missedFromDate: c.lastCharge,
        lastChargeDate: c.lastCharge,
        lastChargeCents: -1549n,
        linkIds: [txId!],
      });
      const onGrace = boundaryDay(c.grace);
      const afterGrace = boundaryDay(c.grace + 1);
      let r = await refreshRecurringItem(f.db, id, onGrace, at(`${onGrace}T08:00:00Z`));
      expect(r.alertsCreated, `${c.cadence} on ${onGrace}`).toBe(0);
      let row = await item(f.db, id);
      expect(row.consecutiveMissed, c.cadence).toBe(0);
      expect(row.nextDueDate, c.cadence).toBe("2026-10-05");

      r = await refreshRecurringItem(f.db, id, afterGrace, at(`${afterGrace}T08:00:00Z`));
      expect(r.alertsCreated, `${c.cadence} on ${afterGrace}`).toBe(1);
      row = await item(f.db, id);
      expect(row.consecutiveMissed, c.cadence).toBe(1);
      expect(row.nextDueDate, c.cadence).toBe(c.nextAfter);
      const alerts = await alertsOf(f.db, id);
      expect(alerts.map((a) => a.dedupeKey)).toEqual([`missed:${id}:2026-10-05`]);
    }
  });

  it("TC17: a pending charge on the due date linked by the matcher prevents the missed alert", async () => {
    const [txId] = await addSeries(f.db, f.accountA, "Pending Monthly", -1549n, ["2026-09-05"]);
    const id = await insertItem(f.db, {
      payeeName: "Pending Monthly",
      accountId: f.accountA,
      categoryId: f.subscriptions,
      cadence: "monthly",
      anchorDay: 5,
      expectedCents: -1549n,
      missedFromDate: "2026-09-05",
      lastChargeDate: "2026-09-05",
      lastChargeCents: -1549n,
      linkIds: [txId!],
    });
    const pending = await addTx(f.db, { accountId: f.accountA, payee: "Pending Monthly", date: "2026-10-05", cents: -1549n, pending: true });
    expect(await matchRecurringItems(f.db, "2026-10-11", at("2026-10-11T08:00:00Z"), { ids: [id] })).toBe(1);
    const row = await item(f.db, id);
    expect(row.consecutiveMissed).toBe(0);
    expect(row.nextDueDate).toBe("2026-11-05");
    expect(row.lastTransactionId).toBe(pending);
    expect(await alertsOf(f.db, id)).toHaveLength(0);
  });

  it("creates a manual item (locked, active, missed clock today) and matches the current period's charge", async () => {
    const charge = await addTx(f.db, { accountId: f.accountA, payee: "Oakwood Apts", date: "2026-10-20", cents: -5000n });
    const today: IsoDate = "2026-10-21";
    const now = at("2026-10-21T08:00:00Z");
    const id = await f.db.transaction((tx) =>
      createManualRecurring(tx, { name: "Rent", payeeName: "Oakwood Apts", categoryId: f.utilities, accountId: f.accountA, cadence: "monthly", anchorDay: 20, expectedCents: -5000n }, today, { now }),
    );
    let row = await item(f.db, id);
    expect(row).toMatchObject({
      name: "Rent",
      source: "manual",
      status: "active",
      amountLocked: true,
      scheduleLocked: true,
      missedFromDate: today,
      toleranceCents: 100n,
      amountMode: "fixed",
      anchorDay: 20,
      anchorMonth: null,
      lastChargeDate: "2026-10-20",
      chargeCount: 1,
      consecutiveMissed: 0,
      nextDueDate: "2026-11-20",
    });
    expect(await linksOf(f.db, id)).toEqual([charge]);

    // The ledger hook: the charge changes payee → its link goes and the item is refreshed.
    expect(await unlinkTransactionFromRecurring(f.db, charge, { today, now })).toBe(id);
    expect(await unlinkTransactionFromRecurring(f.db, charge, { today, now })).toBeNull();
    row = await item(f.db, id);
    expect(row).toMatchObject({ chargeCount: 0, lastChargeDate: null, lastChargeCents: null, nextDueDate: "2026-11-20", consecutiveMissed: 0 });

    // Manual link back, then a second charge in the same period is refused.
    await linkTransaction(f.db, id, charge, today, now);
    expect((await item(f.db, id)).chargeCount).toBe(1);
    const sameperiod = await addTx(f.db, { accountId: f.accountA, payee: "Oakwood Apts", date: "2026-10-22", cents: -5000n });
    await expect(linkTransaction(f.db, id, sameperiod, today, now)).rejects.toMatchObject({ code: "conflict", status: 409 });
    const other = await addTx(f.db, { accountId: f.accountA, payee: "Someone Else", date: "2026-11-20", cents: -5000n });
    await expect(linkTransaction(f.db, id, other, today, now)).rejects.toMatchObject({ code: "validation", status: 400 });

    // Schedule edits lock the schedule and recompute next_due synchronously.
    await updateRecurring(f.db, id, { anchorDay: 25 }, today, now);
    row = await item(f.db, id);
    expect(row.anchorDay).toBe(25);
    expect(row.nextDueDate).toBe("2026-11-25");
    await expect(updateRecurring(f.db, id, { expectedCents: 0n }, today, now)).rejects.toBeInstanceOf(RecurringError);
    await expect(updateRecurring(f.db, id, { cadence: "weekly" }, today, now)).rejects.toMatchObject({ code: "validation" });
    await expect(updateRecurring(f.db, id, { expectedCents: 5000n }, today, now)).rejects.toMatchObject({ code: "validation" });

    expect(await deleteRecurring(f.db, id)).toBe(true);
    expect(await deleteRecurring(f.db, id)).toBe(false);
    const [tx] = await f.db.select({ recurringId: transaction.recurringId }).from(transaction).where(eq(transaction.id, charge));
    expect(tx!.recurringId).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("TC10: idempotent re-run, dismissed stays dismissed, locked edits survive", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("re-running changes nothing but detected_at, and a dismissed suggestion stays dismissed", async () => {
    const ids = await addSeries(f.db, f.accountA, "Netflix", -1549n, NETFLIX_DATES);
    const run1 = at("2026-10-13T08:00:00Z");
    const s1 = await runRecurringDetection(f.db, { today: TODAY, now: run1 });
    expect(s1).toMatchObject({ groups: 1, suggestionsCreated: 1, suggestionsUpdated: 0, suggestionsDeleted: 0, groupsSkipped: 0, itemsMatched: 0, alertsCreated: 0 });
    const [first] = await itemsOf(f.db, "Netflix");
    expect(first).toMatchObject({ status: "suggested", source: "detected", chargeCount: 6, cadence: "monthly", anchorDay: 5, expectedCents: -1549n, toleranceCents: 100n, confidence: 100, nextDueDate: "2026-10-05", accountId: f.accountA });
    expect(first!.detectedAt?.getTime()).toBe(run1.getTime());
    expect(await linksOf(f.db, first!.id)).toEqual([...ids].sort());

    const run2 = at("2026-10-13T09:00:00Z");
    const s2 = await runRecurringDetection(f.db, { today: TODAY, now: run2 });
    expect(s2).toMatchObject({ suggestionsCreated: 0, suggestionsUpdated: 1, suggestionsDeleted: 0, alertsCreated: 0 });
    const rows = await itemsOf(f.db, "Netflix");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first!.id);
    expect(rows[0]!.chargeCount).toBe(6);
    expect(rows[0]!.detectedAt?.getTime()).toBe(run2.getTime());
    expect(await linksOf(f.db, first!.id)).toEqual([...ids].sort());
    expect((await countRows(f.db)).alerts).toBe(0);

    await setRecurringStatus(f.db, first!.id, "dismissed", { today: TODAY, now: at("2026-10-13T09:30:00Z") });
    const s3 = await runRecurringDetection(f.db, { today: TODAY, now: at("2026-10-13T10:00:00Z") });
    expect(s3).toMatchObject({ suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsDeleted: 0 });
    const after = await itemsOf(f.db, "Netflix");
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first!.id);
    expect(after[0]!.status).toBe("dismissed");
    expect((await countRows(f.db)).items).toBe(1);
  });

  it("a locked amount survives a new charge and a detector run", async () => {
    const xcel: Array<[IsoDate, bigint]> = [
      ["2026-04-06", -8420n],
      ["2026-05-05", -7615n],
      ["2026-06-05", -9130n],
      ["2026-07-06", -12275n],
      ["2026-08-05", -13850n],
      ["2026-09-07", -11040n],
      ["2026-10-05", -8890n],
    ];
    for (const [date, cents] of xcel) await addTx(f.db, { accountId: f.accountA, payee: "Xcel Energy", date, cents });
    await runRecurringDetection(f.db, { today: TODAY, now: at("2026-10-13T11:00:00Z") });
    const [suggested] = await itemsOf(f.db, "Xcel Energy");
    expect(suggested).toMatchObject({ status: "suggested", amountMode: "variable", expectedCents: -11040n, toleranceCents: 3425n, anchorDay: 5, nextDueDate: "2026-11-05", chargeCount: 7 });

    await f.db.transaction((tx) => updateRecurring(tx, suggested!.id, { categoryId: f.utilities, status: "active" }, TODAY, at("2026-10-13T12:00:00Z")));
    let row = await item(f.db, suggested!.id);
    expect(row).toMatchObject({ status: "active", missedFromDate: "2026-10-05", expectedCents: -11040n, toleranceCents: 3425n, amountLocked: false });

    await f.db.transaction((tx) => updateRecurring(tx, suggested!.id, { expectedCents: -12000n }, TODAY, at("2026-10-13T12:30:00Z")));
    row = await item(f.db, suggested!.id);
    expect(row).toMatchObject({ expectedCents: -12000n, toleranceCents: 3425n, amountLocked: true, amountMode: "variable" });

    const nov = await addTx(f.db, { accountId: f.accountA, payee: "Xcel Energy", date: "2026-11-05", cents: -9000n });
    const runLate = at("2026-11-10T08:00:00Z");
    const stats = await runRecurringDetection(f.db, { today: "2026-11-10", now: runLate });
    expect(stats.itemsMatched).toBe(1);
    expect(stats.suggestionsCreated).toBe(0);
    row = await item(f.db, suggested!.id);
    expect(row).toMatchObject({
      status: "active",
      expectedCents: -12000n,
      toleranceCents: 3425n,
      amountLocked: true,
      lastChargeCents: -9000n,
      lastChargeDate: "2026-11-05",
      lastTransactionId: nov,
      chargeCount: 8,
      consecutiveMissed: 0,
      nextDueDate: "2026-12-05",
    });
    expect(row.detectedAt?.getTime()).toBe(runLate.getTime());
    expect((await itemsOf(f.db, "Xcel Energy")).length).toBe(1);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("TC12: same payee on two accounts", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("detects two items and the matcher keeps each to its own account", async () => {
    await addSeries(f.db, f.accountA, "Spotify", -1199n, ["2026-06-03", "2026-07-03", "2026-08-03", "2026-09-03"]);
    await addSeries(f.db, f.accountB, "Spotify", -1199n, ["2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"]);
    const today: IsoDate = "2026-09-20";
    const stats = await runRecurringDetection(f.db, { today, now: at("2026-09-20T08:00:00Z") });
    expect(stats.suggestionsCreated).toBe(2);
    const rows = await itemsOf(f.db, "Spotify");
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.accountId === f.accountA)!;
    const b = rows.find((r) => r.accountId === f.accountB)!;
    expect(a).toMatchObject({ anchorDay: 3, nextDueDate: "2026-10-03", chargeCount: 4, expectedCents: -1199n });
    expect(b).toMatchObject({ anchorDay: 5, nextDueDate: "2026-10-05", chargeCount: 4, expectedCents: -1199n });

    for (const r of rows) await f.db.transaction((tx) => updateRecurring(tx, r.id, { categoryId: f.subscriptions, status: "active" }, today, at("2026-09-20T09:00:00Z")));
    const charge = await addTx(f.db, { accountId: f.accountB, payee: "Spotify", date: "2026-10-05", cents: -1199n });
    expect(await matchRecurringItems(f.db, "2026-10-06", at("2026-10-06T08:00:00Z"))).toBe(1);
    const [tx] = await f.db.select({ recurringId: transaction.recurringId }).from(transaction).where(eq(transaction.id, charge));
    expect(tx!.recurringId).toBe(b.id);
    expect((await item(f.db, b.id)).chargeCount).toBe(5);
    expect((await item(f.db, a.id)).chargeCount).toBe(4);
    expect((await item(f.db, a.id)).consecutiveMissed).toBe(0);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("TC14: free trial converting (full run)", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("raises trial_converted once for the converting payees only", async () => {
    const hulu = await resolvePayee(f.db, "Hulu");
    await addTx(f.db, { accountId: f.accountA, payee: "Hulu", date: "2026-09-20", cents: -100n });
    const full = await addTx(f.db, { accountId: f.accountA, payee: "Hulu", date: "2026-10-11", cents: -1799n });
    // Variants that must not fire.
    await addTx(f.db, { accountId: f.accountA, payee: "Hulu Early", date: "2026-09-01", cents: -1799n });
    await addTx(f.db, { accountId: f.accountA, payee: "Hulu Early", date: "2026-09-20", cents: -100n });
    await addTx(f.db, { accountId: f.accountA, payee: "Hulu Old", date: "2026-08-01", cents: -100n });
    await addTx(f.db, { accountId: f.accountA, payee: "Hulu Old", date: "2026-10-11", cents: -1799n });
    await addTx(f.db, { accountId: f.accountA, payee: "Hulu Small", date: "2026-09-20", cents: -100n });
    await addTx(f.db, { accountId: f.accountA, payee: "Hulu Small", date: "2026-10-11", cents: -150n });
    // A $0 authorization counts as a small charge.
    const zero = await resolvePayee(f.db, "Hulu Zero");
    await addTx(f.db, { accountId: f.accountA, payee: "Hulu Zero", date: "2026-09-20", cents: 0n });
    const zeroFull = await addTx(f.db, { accountId: f.accountA, payee: "Hulu Zero", date: "2026-10-11", cents: -1799n });

    const stats = await runRecurringDetection(f.db, { today: TODAY, now: NOW });
    expect(stats.alertsCreated).toBe(2);
    expect(stats.suggestionsCreated).toBe(0);
    expect((await countRows(f.db)).items).toBe(0);
    const alerts = await f.db.select().from(alert).orderBy(asc(alert.dedupeKey));
    expect(alerts.map((a) => a.dedupeKey).sort()).toEqual([`trial:${hulu.id}:${full}`, `trial:${zero.id}:${zeroFull}`].sort());
    const huluAlert = alerts.find((a) => a.payeeId === hulu.id)!;
    expect(huluAlert).toMatchObject({ kind: "trial_converted", recurringId: null, transactionId: full, newCents: -1799n, oldCents: null });

    const again = await runRecurringDetection(f.db, { today: TODAY, now: at("2026-10-13T09:00:00Z") });
    expect(again.alertsCreated).toBe(0);
    expect((await countRows(f.db)).alerts).toBe(2);

    // 21 days after the full charge the conversion is too old to announce.
    await addTx(f.db, { accountId: f.accountA, payee: "Hulu Late", date: "2026-09-20", cents: -100n });
    await addTx(f.db, { accountId: f.accountA, payee: "Hulu Late", date: "2026-10-11", cents: -1799n });
    const late = await runRecurringDetection(f.db, { today: "2026-11-01", now: at("2026-11-01T08:00:00Z") });
    expect(late.alertsCreated).toBe(0);
    expect((await countRows(f.db)).alerts).toBe(2);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("TC18: suggestion refresh after a sync does not duplicate", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("updates the existing suggestion in place", async () => {
    await addSeries(f.db, f.accountA, "Netflix", -1549n, NETFLIX_DATES.slice(0, 5));
    const run1 = at("2026-09-01T08:00:00Z");
    const s1 = await runRecurringDetection(f.db, { today: "2026-09-01", now: run1 });
    expect(s1.suggestionsCreated).toBe(1);
    const [first] = await itemsOf(f.db, "Netflix");
    expect(first).toMatchObject({ chargeCount: 5, lastChargeDate: "2026-08-05", nextDueDate: "2026-09-05" });
    expect(await linksOf(f.db, first!.id)).toHaveLength(5);

    const sep = await addTx(f.db, { accountId: f.accountA, payee: "Netflix", date: "2026-09-05", cents: -1549n });
    const run2 = at("2026-10-13T08:00:00Z");
    const s2 = await runRecurringDetection(f.db, { today: TODAY, now: run2 });
    expect(s2).toMatchObject({ suggestionsCreated: 0, suggestionsUpdated: 1, suggestionsDeleted: 0, alertsCreated: 0 });
    const rows = await itemsOf(f.db, "Netflix");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first!.id, chargeCount: 6, lastChargeDate: "2026-09-05", lastTransactionId: sep, nextDueDate: "2026-10-05" });
    expect(rows[0]!.detectedAt?.getTime()).toBe(run2.getTime());
    expect(await linksOf(f.db, first!.id)).toHaveLength(6);
    expect((await countRows(f.db)).alerts).toBe(0);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("TC19: stale series", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  const GYM_DATES: IsoDate[] = ["2026-02-05", "2026-03-05", "2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05"];

  it("(a) deletes the old suggestion and (b) auto-pauses the active item after three missed charges", async () => {
    const gymIds = await addSeries(f.db, f.accountA, "Gym", -4999n, GYM_DATES);
    const s1 = await runRecurringDetection(f.db, { today: "2026-08-01", now: at("2026-08-01T08:00:00Z") });
    expect(s1.suggestionsCreated).toBe(1);
    const [suggestion] = await itemsOf(f.db, "Gym");
    expect(await linksOf(f.db, suggestion!.id)).toHaveLength(6);

    const gym2Ids = await addSeries(f.db, f.accountA, "Gym Two", -4999n, GYM_DATES);
    const active = await insertItem(f.db, {
      payeeName: "Gym Two",
      accountId: f.accountA,
      categoryId: f.subscriptions,
      cadence: "monthly",
      anchorDay: 5,
      expectedCents: -4999n,
      missedFromDate: "2026-07-05",
      lastChargeDate: "2026-07-05",
      lastChargeCents: -4999n,
      linkIds: gym2Ids,
      createdAt: at("2026-08-01T09:00:00Z"),
    });

    const s2 = await runRecurringDetection(f.db, { today: TODAY, now: NOW });
    expect(s2).toMatchObject({ suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsDeleted: 1, alertsCreated: 3 });

    expect(await itemsOf(f.db, "Gym")).toHaveLength(0);
    const orphaned = await f.db.select({ recurringId: transaction.recurringId }).from(transaction).where(inArray(transaction.id, gymIds));
    expect(orphaned.every((r) => r.recurringId === null)).toBe(true);

    const row = await item(f.db, active);
    expect(row).toMatchObject({ status: "paused", statusReason: "missed_3", consecutiveMissed: 3, nextDueDate: "2026-11-05", chargeCount: 6 });
    expect(row.statusChangedAt.getTime()).toBe(NOW.getTime());
    const alerts = await alertsOf(f.db, active);
    expect(alerts.map((a) => a.dedupeKey)).toEqual([`missed:${active}:2026-08-05`, `missed:${active}:2026-09-05`, `missed:${active}:2026-10-05`]);

    const subs = await listSubscriptions(f.db);
    expect(subs.items).toHaveLength(0);
    expect(subs.pausedItems.map((p) => p.id)).toEqual([active]);
    expect(subs.totalYearlyCents).toBe(0n);
    expect(subs.totalMonthlyCents).toBe(0n);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("TC26: new-subscription alert and the first-sync history guard", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("alerts only when the series starts at least 45 days into the account's history", async () => {
    const recent: IsoDate[] = ["2026-08-05", "2026-09-05", "2026-10-05"];
    await addTx(f.db, { accountId: f.accountA, payee: "Coffee", date: "2026-07-01", cents: -300n });
    await addSeries(f.db, f.accountA, "Netflix", -1549n, recent);
    await addTx(f.db, { accountId: f.accountB, payee: "Bagel", date: "2026-06-01", cents: -300n });
    await addSeries(f.db, f.accountB, "Spotify", -1199n, recent);

    const stats = await runRecurringDetection(f.db, { today: TODAY, now: NOW });
    expect(stats).toMatchObject({ suggestionsCreated: 2, alertsCreated: 1 });
    const [netflix] = await itemsOf(f.db, "Netflix");
    const [spotify] = await itemsOf(f.db, "Spotify");
    expect(netflix).toMatchObject({ status: "suggested", anchorDay: 5, nextDueDate: "2026-11-05", expectedCents: -1549n });
    expect(await alertsOf(f.db, netflix!.id)).toHaveLength(0);
    const alerts = await alertsOf(f.db, spotify!.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "new_recurring", dedupeKey: `new:${spotify!.id}`, payeeId: spotify!.payeeId, resolvedAt: null, dismissedAt: null });

    const dismissedAt = at("2026-10-13T09:00:00Z");
    await setRecurringStatus(f.db, spotify!.id, "dismissed", { today: TODAY, now: dismissedAt });
    expect((await alertsOf(f.db, spotify!.id))[0]!.resolvedAt?.getTime()).toBe(dismissedAt.getTime());

    const again = await runRecurringDetection(f.db, { today: TODAY, now: at("2026-10-13T10:00:00Z") });
    expect(again).toMatchObject({ suggestionsCreated: 0, suggestionsUpdated: 1, suggestionsDeleted: 0, alertsCreated: 0 });
    expect((await item(f.db, spotify!.id)).status).toBe("dismissed");
    expect((await countRows(f.db)).alerts).toBe(1);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("subscriptions and list views", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("TC16 totals come from the yearly sum; paused and inflow items stay out", async () => {
    await insertItem(f.db, { payeeName: "Netflix", categoryId: f.subscriptions, cadence: "monthly", anchorDay: 5, expectedCents: -1549n, nextDueDate: "2026-11-05" });
    await insertItem(f.db, { payeeName: "Water", categoryId: f.utilities, cadence: "quarterly", anchorDay: 10, anchorMonth: 11, expectedCents: -4500n, nextDueDate: "2026-11-10" });
    await insertItem(f.db, { payeeName: "Domain", categoryId: f.subscriptions, cadence: "yearly", anchorDay: 14, anchorMonth: 3, expectedCents: -11988n, nextDueDate: "2027-03-14" });
    await insertItem(f.db, { payeeName: "Gym", categoryId: f.subscriptions, cadence: "monthly", anchorDay: 1, expectedCents: -999n, status: "paused", nextDueDate: "2026-11-01" });
    await insertItem(f.db, { payeeName: "Acme Corp", cadence: "twice_monthly", anchorDay: 1, anchorDay2: 15, expectedCents: 245000n, nextDueDate: "2026-10-15" });
    await insertItem(f.db, { payeeName: "Old Thing", categoryId: f.subscriptions, cadence: "monthly", anchorDay: 9, expectedCents: -500n, status: "dismissed" });
    await insertItem(f.db, { payeeName: "Maybe", categoryId: f.subscriptions, cadence: "monthly", anchorDay: 2, expectedCents: -2000n, status: "suggested", confidence: 85, nextDueDate: "2026-11-02" });
    await insertItem(f.db, { payeeName: "Overdue Thing", categoryId: f.subscriptions, cadence: "monthly", anchorDay: 3, expectedCents: -700n, consecutiveMissed: 1, nextDueDate: "2026-11-03" });

    const subs = await listSubscriptions(f.db);
    expect(subs.items.map((s) => s.name)).toEqual(["Netflix", "Water", "Domain", "Overdue Thing"]);
    expect(subs.items.map((s) => s.yearlyCents)).toEqual([-18588n, -18000n, -11988n, -8400n]);
    expect(subs.items.map((s) => s.monthlyEquivalentCents)).toEqual([-1549n, -1500n, -999n, -700n]);
    expect(subs.pausedItems.map((s) => s.name)).toEqual(["Gym"]);
    expect(subs.totalYearlyCents).toBe(-48576n - 8400n);
    expect(subs.totalMonthlyCents).toBe(-4748n);
    expect(subs.items[0]).toMatchObject({ payeeName: "Netflix", categoryName: "Subscriptions", cadence: "monthly", expectedCents: -1549n, status: "active", amountMode: "fixed" });

    // The three-item total from the design, computed from the yearly sum.
    const three = subs.items.filter((s) => s.name !== "Overdue Thing").reduce((sum, s) => sum + s.yearlyCents, 0n);
    expect(three).toBe(-48576n);
    expect(three / 12n).toBe(-4048n);
  });

  it("listRecurring filters, sorts and flags overdue items", async () => {
    const all = await listRecurring(f.db, { status: "all" });
    expect(all.items).toHaveLength(8);
    const byDefault = await listRecurring(f.db);
    expect(byDefault.items).toHaveLength(7);
    expect(byDefault.items[0]!.name).toBe("Maybe");
    expect(byDefault.items.slice(1).map((r) => r.name)).toEqual(["Acme Corp", "Gym", "Overdue Thing", "Netflix", "Water", "Domain"]);
    expect(byDefault.items.find((r) => r.name === "Overdue Thing")!.overdue).toBe(true);
    expect(byDefault.items.find((r) => r.name === "Netflix")!.overdue).toBe(false);
    const outflows = await listRecurring(f.db, { direction: "outflow", status: "active" });
    expect(outflows.items.map((r) => r.name).sort()).toEqual(["Domain", "Netflix", "Overdue Thing", "Water"]);
    expect(outflows.totals).toEqual({ yearlyCents: -56976n, monthlyEquivalentCents: -4748n });
    const byCost = await listRecurring(f.db, { status: "all", sort: "cost" });
    expect(byCost.items[0]!.name).toBe("Acme Corp");
    const byName = await listRecurring(f.db, { status: "all", sort: "name" });
    expect(byName.items.map((r) => r.name)).toEqual([...byName.items.map((r) => r.name)].sort((a, b) => a.localeCompare(b)));
    const record = byName.items.find((r) => r.name === "Acme Corp")!;
    expect(record).toMatchObject({ payeeName: "Acme Corp", categoryName: null, monthlyEquivalentCents: 490000n, yearlyCents: 5880000n, accountName: null });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("status transitions (C4)", () => {
  let f: Fixture;
  let n = 0;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  async function mk(status: RecurringStatus, opts: { category?: boolean; lastCharge?: IsoDate } = {}): Promise<string> {
    const payeeName = `Payee ${++n}`;
    const links = opts.lastCharge ? await addSeries(f.db, f.accountA, payeeName, -1000n, [opts.lastCharge]) : [];
    return insertItem(f.db, {
      payeeName,
      accountId: f.accountA,
      categoryId: opts.category === false ? null : f.subscriptions,
      cadence: "monthly",
      anchorDay: 5,
      expectedCents: -1000n,
      status,
      scheduleLocked: true,
      amountLocked: true,
      missedFromDate: status === "suggested" ? null : "2026-10-01",
      lastChargeDate: opts.lastCharge ?? null,
      lastChargeCents: opts.lastCharge ? -1000n : null,
      linkIds: links,
    });
  }

  const opts = { today: TODAY, now: NOW };

  it("confirms a suggestion: category required, missed clock from the last charge, alert resolved, payee default category set", async () => {
    const id = await mk("suggested", { lastCharge: "2026-10-05" });
    const row = await item(f.db, id);
    await raiseAlert(f.db, { kind: "new_recurring", dedupeKey: `new:${id}`, recurringId: id, payeeId: row.payeeId });
    await setRecurringStatus(f.db, id, "active", opts);
    const after = await item(f.db, id);
    expect(after).toMatchObject({ status: "active", statusReason: null, missedFromDate: "2026-10-05", consecutiveMissed: 0, nextDueDate: "2026-11-05" });
    expect(after.statusChangedAt.getTime()).toBe(NOW.getTime());
    expect((await alertsOf(f.db, id))[0]!.resolvedAt?.getTime()).toBe(NOW.getTime());
    const [p] = await f.db.select({ defaultCategoryId: payee.defaultCategoryId }).from(payee).where(eq(payee.id, row.payeeId));
    expect(p!.defaultCategoryId).toBe(f.subscriptions);

    const noCategory = await mk("suggested", { category: false });
    await expect(setRecurringStatus(f.db, noCategory, "active", opts)).rejects.toMatchObject({ code: "category_required", status: 400 });
    expect((await item(f.db, noCategory)).status).toBe("suggested");

    const noCharge = await mk("suggested");
    await setRecurringStatus(f.db, noCharge, "active", opts);
    expect((await item(f.db, noCharge)).missedFromDate).toBe(TODAY);
  });

  it("dismisses a suggestion, keeping its links and resolving its alert", async () => {
    const id = await mk("suggested", { lastCharge: "2026-10-05" });
    const row = await item(f.db, id);
    await raiseAlert(f.db, { kind: "new_recurring", dedupeKey: `new:${id}`, recurringId: id, payeeId: row.payeeId });
    await setRecurringStatus(f.db, id, "dismissed", opts);
    expect((await item(f.db, id)).status).toBe("dismissed");
    expect(await linksOf(f.db, id)).toHaveLength(1);
    expect((await alertsOf(f.db, id))[0]!.resolvedAt).not.toBeNull();
  });

  it("pauses, resumes (missed clock from today), cancels (next due cleared) and re-activates", async () => {
    const id = await mk("active", { lastCharge: "2026-07-05" });
    await setRecurringStatus(f.db, id, "paused", opts);
    let row = await item(f.db, id);
    expect(row).toMatchObject({ status: "paused", statusReason: null, consecutiveMissed: 0, nextDueDate: "2026-11-05" });

    await setRecurringStatus(f.db, id, "active", opts);
    row = await item(f.db, id);
    expect(row).toMatchObject({ status: "active", missedFromDate: TODAY, consecutiveMissed: 0, nextDueDate: "2026-11-05" });
    expect(await alertsOf(f.db, id)).toHaveLength(0);

    await setRecurringStatus(f.db, id, "cancelled", opts);
    row = await item(f.db, id);
    expect(row).toMatchObject({ status: "cancelled", nextDueDate: null, consecutiveMissed: 0 });

    await setRecurringStatus(f.db, id, "active", { today: "2026-10-20", now: at("2026-10-20T08:00:00Z") });
    row = await item(f.db, id);
    expect(row).toMatchObject({ status: "active", missedFromDate: "2026-10-20", nextDueDate: "2026-11-05" });

    const paused = await mk("paused");
    await setRecurringStatus(f.db, paused, "cancelled", opts);
    expect((await item(f.db, paused)).status).toBe("cancelled");

    const dismissed = await mk("dismissed");
    await setRecurringStatus(f.db, dismissed, "active", opts);
    expect((await item(f.db, dismissed))).toMatchObject({ status: "active", missedFromDate: TODAY });

    // Same status is a no-op.
    const before = await item(f.db, dismissed);
    await setRecurringStatus(f.db, dismissed, "active", { today: TODAY, now: at("2026-10-14T08:00:00Z") });
    expect((await item(f.db, dismissed)).statusChangedAt.getTime()).toBe(before.statusChangedAt.getTime());
  });

  it("rejects every other transition with invalid_transition", async () => {
    const invalid: Array<[RecurringStatus, RecurringStatus]> = [
      ["suggested", "paused"],
      ["suggested", "cancelled"],
      ["active", "dismissed"],
      ["active", "suggested"],
      ["paused", "dismissed"],
      ["paused", "suggested"],
      ["cancelled", "paused"],
      ["cancelled", "dismissed"],
      ["cancelled", "suggested"],
      ["dismissed", "paused"],
      ["dismissed", "cancelled"],
      ["dismissed", "suggested"],
    ];
    for (const [from, to] of invalid) {
      const id = await mk(from);
      await expect(setRecurringStatus(f.db, id, to, opts), `${from} → ${to}`).rejects.toMatchObject({ code: "invalid_transition", status: 400 });
      expect((await item(f.db, id)).status, `${from} → ${to}`).toBe(from);
    }
    await expect(setRecurringStatus(f.db, "00000000-0000-4000-8000-000000000000", "active", opts)).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});
