import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectRecurring, type IsoDate } from "@meridian/shared";
import type { Db } from "../index.js";
import { account, alert, category, payee, recurring, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { projectForHousehold } from "./cashflow.js";
import { seedDefaultCategories } from "./categories.js";
import { resolvePayee } from "./payees.js";
import {
  RecurringError,
  createManualRecurring,
  getRecurring,
  linkTransaction,
  listSubscriptions,
  loadDetectionInput,
  matchRecurringItems,
  refreshRecurringItem,
  runRecurringDetection,
  setRecurringStatus,
  updateRecurring,
  upsertDetections,
  type RecurringRowWithLinks,
} from "./recurring.js";

/**
 * Audit batch b5 (recurring detection, subscriptions, alerts and cash flow): the database side
 * of findings b5-recurring-cashflow-02, -04 to -09 and -11 to -13. Every suite gets its own
 * throwaway database; the fixture has a checking account, two cards and a savings account.
 */

const at = (iso: string): Date => new Date(iso);
const noon = (date: IsoDate): Date => at(`${date}T12:00:00Z`);

interface Fixture {
  t: TestDb;
  db: Db;
  checking: string;
  savings: string;
  oldVisa: string;
  newAmex: string;
  cat: (name: string) => string;
}

async function setup(): Promise<Fixture> {
  const t = await createTestDb();
  await seedDefaultCategories(t.db);
  const rows = await t.db
    .insert(account)
    .values([
      { name: "Checking", type: "checking", taxTreatment: "none", balanceCents: 500000n, balanceDate: "2026-10-01" },
      { name: "Savings", type: "savings", taxTreatment: "none", balanceCents: 100000n, balanceDate: "2026-10-01" },
      { name: "Old Visa", type: "credit", taxTreatment: "none", balanceCents: 0n, balanceDate: "2026-10-01" },
      { name: "New Amex", type: "credit", taxTreatment: "none", balanceCents: 0n, balanceDate: "2026-10-01" },
    ])
    .returning({ id: account.id });
  const cats = await t.db.select({ id: category.id, name: category.name }).from(category);
  return {
    t,
    db: t.db,
    checking: rows[0]!.id,
    savings: rows[1]!.id,
    oldVisa: rows[2]!.id,
    newAmex: rows[3]!.id,
    cat: (name) => cats.find((c) => c.name === name)!.id,
  };
}

async function addTx(db: Db, input: { accountId: string; payee: string; date: IsoDate; cents: bigint; categoryId?: string | null }): Promise<string> {
  const p = await resolvePayee(db, input.payee);
  const [row] = await db
    .insert(transaction)
    .values({ accountId: input.accountId, source: "manual", date: input.date, amountCents: input.cents, payeeId: p.id, rawDescription: input.payee, categoryId: input.categoryId ?? null })
    .returning({ id: transaction.id });
  return row!.id;
}

async function addSeries(db: Db, accountId: string, payeeName: string, cents: bigint, dates: readonly IsoDate[], categoryId?: string): Promise<string[]> {
  const ids: string[] = [];
  for (const date of dates) ids.push(await addTx(db, { accountId, payee: payeeName, date, cents, categoryId: categoryId ?? null }));
  return ids;
}

async function itemsOf(db: Db, payeeName: string) {
  const rows = await db
    .select({ row: recurring })
    .from(recurring)
    .innerJoin(payee, eq(payee.id, recurring.payeeId))
    .where(eq(payee.name, payeeName))
    .orderBy(asc(recurring.createdAt), asc(recurring.id));
  return rows.map((r) => r.row);
}

async function row(db: Db, id: string) {
  const [r] = await db.select().from(recurring).where(eq(recurring.id, id));
  return r!;
}

async function linksOf(db: Db, id: string): Promise<string[]> {
  const rows = await db.select({ id: transaction.id }).from(transaction).where(eq(transaction.recurringId, id));
  return rows.map((r) => r.id).sort();
}

async function alertsOf(db: Db, recurringId: string) {
  return db.select().from(alert).where(eq(alert.recurringId, recurringId)).orderBy(asc(alert.createdAt), asc(alert.dedupeKey));
}

async function alertCount(db: Db): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(alert);
  return r!.n;
}

/** An active item with links, as a confirmed detection leaves it, refreshed so its derived columns are consistent. */
async function activeItem(
  db: Db,
  input: { payeeName: string; accountId: string; categoryId: string; anchorDay: number; expectedCents: bigint; linkIds: string[]; lastChargeDate: IsoDate; today: IsoDate; transferAccountId?: string },
): Promise<string> {
  const p = await resolvePayee(db, input.payeeName);
  const [r] = await db
    .insert(recurring)
    .values({
      payeeId: p.id,
      categoryId: input.categoryId,
      accountId: input.accountId,
      transferAccountId: input.transferAccountId ?? null,
      name: input.payeeName,
      cadence: "monthly",
      anchorDay: input.anchorDay,
      expectedCents: input.expectedCents,
      toleranceCents: 100n,
      amountMode: "fixed",
      status: "active",
      source: "detected",
      missedFromDate: input.lastChargeDate,
      lastChargeDate: input.lastChargeDate,
      lastChargeCents: input.expectedCents,
      statusChangedAt: noon(input.today),
      createdAt: noon(input.today),
      updatedAt: noon(input.today),
    })
    .returning({ id: recurring.id });
  if (input.linkIds.length > 0) await db.update(transaction).set({ recurringId: r!.id }).where(inArray(transaction.id, input.linkIds));
  await refreshRecurringItem(db, r!.id, input.today, noon(input.today));
  return r!.id;
}

const MAY_TO_SEP: IsoDate[] = ["2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"];
const APR_TO_SEP: IsoDate[] = ["2026-04-05", ...MAY_TO_SEP];

describe.skipIf(!TEST_DATABASE_URL)("b5-02: after a price increase the item plans and projects the new price", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("one charge at 17.99 makes it fixed at 17.99 everywhere; the next increase alerts again", async () => {
    const ids = await addSeries(f.db, f.checking, "Hulu", -1549n, MAY_TO_SEP);
    const id = await activeItem(f.db, { payeeName: "Hulu", accountId: f.checking, categoryId: f.cat("Subscriptions"), anchorDay: 5, expectedCents: -1549n, linkIds: ids, lastChargeDate: "2026-09-05", today: "2026-09-06" });

    const oct = await addTx(f.db, { accountId: f.checking, payee: "Hulu", date: "2026-10-05", cents: -1799n });
    expect(await matchRecurringItems(f.db, "2026-10-06", noon("2026-10-06"), { ids: [id] })).toBe(1);
    expect((await alertsOf(f.db, id)).map((a) => [a.kind, a.transactionId, a.oldCents, a.newCents])).toEqual([["price_increase", oct, -1549n, -1799n]]);
    // {1549 × 5, 1799}: the three before the newest were fixed, so 1799 is the new price: fixed −1799 ± 100.
    expect(await row(f.db, id)).toMatchObject({ amountMode: "fixed", expectedCents: -1799n, toleranceCents: 100n, lastChargeCents: -1799n, nextDueDate: "2026-11-05" });

    // The Subscriptions page and the cash flow use the new price.
    const subs = await listSubscriptions(f.db);
    expect(subs.items.map((s) => [s.name, s.expectedCents, s.monthlyEquivalentCents, s.yearlyCents])).toEqual([["Hulu", -1799n, -1799n, -21588n]]);
    const cf = await projectForHousehold(f.db, { today: "2026-10-06", horizonDays: 40 });
    expect(cf.events.filter((e) => e.recurringId === id).map((e) => [e.date, e.amountCents])).toEqual([["2026-11-05", -1799n]]);

    // A second charge at the new price: no alert; a further increase alerts against 17.99.
    await addTx(f.db, { accountId: f.checking, payee: "Hulu", date: "2026-11-05", cents: -1799n });
    await matchRecurringItems(f.db, "2026-11-06", noon("2026-11-06"), { ids: [id] });
    expect(await alertsOf(f.db, id)).toHaveLength(1);
    expect(await row(f.db, id)).toMatchObject({ amountMode: "fixed", expectedCents: -1799n });
    const dec = await addTx(f.db, { accountId: f.checking, payee: "Hulu", date: "2026-12-05", cents: -1999n });
    await matchRecurringItems(f.db, "2026-12-06", noon("2026-12-06"), { ids: [id] });
    expect((await alertsOf(f.db, id)).map((a) => [a.kind, a.transactionId, a.oldCents, a.newCents])).toEqual([
      ["price_increase", oct, -1549n, -1799n],
      ["price_increase", dec, -1799n, -1999n],
    ]);
    // Two changes two months apart: 17.99 held for only two charges, so the series is variable until
    // 19.99 repeats: last 6 {1549, 1549, 1549, 1799, 1799, 1999} → upper median 1799, band max(250, 200) = 250.
    expect(await row(f.db, id)).toMatchObject({ amountMode: "variable", expectedCents: -1799n, toleranceCents: 250n });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("b5-04: the detector keeps a suggestion's edits and never rewrites a row confirmed meanwhile", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("a locked amount and schedule and a chosen category survive the next run", async () => {
    await addSeries(f.db, f.oldVisa, "Netflix", -1549n, APR_TO_SEP, f.cat("Entertainment"));
    await runRecurringDetection(f.db, { today: "2026-10-13", now: at("2026-10-13T08:00:00Z") });
    const [s] = await itemsOf(f.db, "Netflix");
    expect(s).toMatchObject({ status: "suggested", expectedCents: -1549n, amountMode: "fixed", categoryId: f.cat("Entertainment"), anchorDay: 5, nextDueDate: "2026-10-05" });
    const links = await linksOf(f.db, s!.id);

    // The owner edits the suggestion without confirming it.
    await updateRecurring(f.db, s!.id, { expectedCents: -1799n, toleranceCents: 200n, categoryId: f.cat("Subscriptions"), anchorDay: 6 }, "2026-10-13", at("2026-10-13T09:00:00Z"));
    expect(await row(f.db, s!.id)).toMatchObject({ amountLocked: true, scheduleLocked: true, expectedCents: -1799n, anchorDay: 6, nextDueDate: "2026-10-06" });

    const run2 = at("2026-10-14T08:00:00Z");
    const stats = await runRecurringDetection(f.db, { today: "2026-10-14", now: run2 });
    expect(stats).toMatchObject({ suggestionsCreated: 0, suggestionsUpdated: 1, suggestionsDeleted: 0 });
    // Unchanged: the amounts (locked), the schedule and its next due (locked) and the owner's category.
    expect(await row(f.db, s!.id)).toMatchObject({
      status: "suggested",
      expectedCents: -1799n,
      toleranceCents: 200n,
      amountMode: "fixed",
      amountLocked: true,
      cadence: "monthly",
      anchorDay: 6,
      scheduleLocked: true,
      nextDueDate: "2026-10-06",
      categoryId: f.cat("Subscriptions"),
      detectedAt: run2,
      chargeCount: 6,
    });
    expect(await linksOf(f.db, s!.id)).toEqual(links);
  });

  it("a suggestion without a category takes the charges' category once they have one", async () => {
    const ids = await addSeries(f.db, f.oldVisa, "Spotify", -1199n, APR_TO_SEP);
    await runRecurringDetection(f.db, { today: "2026-10-15", now: at("2026-10-15T08:00:00Z") });
    const [s] = await itemsOf(f.db, "Spotify");
    expect(s!.categoryId).toBeNull();
    await f.db.update(transaction).set({ categoryId: f.cat("Entertainment") }).where(inArray(transaction.id, ids));
    await runRecurringDetection(f.db, { today: "2026-10-15", now: at("2026-10-15T09:00:00Z") });
    expect((await row(f.db, s!.id)).categoryId).toBe(f.cat("Entertainment"));
  });

  it("a run that read the suggestion before the owner confirmed it only stamps detected_at", async () => {
    await addSeries(f.db, f.oldVisa, "Max", -999n, APR_TO_SEP, f.cat("Entertainment"));
    await runRecurringDetection(f.db, { today: "2026-10-16", now: at("2026-10-16T08:00:00Z") });
    const [s] = await itemsOf(f.db, "Max");
    expect(s).toMatchObject({ status: "suggested", categoryId: f.cat("Entertainment") });

    // The scan reads the ledger and the rows ...
    const input = await loadDetectionInput(f.db, "2026-10-16");
    const existing: RecurringRowWithLinks[] = [{ ...(await row(f.db, s!.id)), linkedIds: await linksOf(f.db, s!.id) }];
    // ... the owner confirms in Subscriptions meanwhile ...
    await updateRecurring(f.db, s!.id, { categoryId: f.cat("Subscriptions"), status: "active" }, "2026-10-16", at("2026-10-16T09:00:00Z"));
    const confirmed = await row(f.db, s!.id);
    // ... and the scan writes what it detected.
    const key = `${s!.payeeId}|-1`;
    const runStart = at("2026-10-16T09:00:01Z");
    const stats = await upsertDetections(f.db, s!.payeeId, -1n, detectRecurring(input.groups.get(key)!, "2026-10-16"), existing, runStart, "2026-10-16", input.historyStartByAccount);
    expect(stats).toEqual({ created: 0, updated: 0, alertsCreated: 0 });
    const after = await row(f.db, s!.id);
    expect(after).toMatchObject({ status: "active", categoryId: f.cat("Subscriptions"), missedFromDate: confirmed.missedFromDate, detectedAt: runStart });
    expect(after.updatedAt).toEqual(confirmed.updatedAt);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("b5-05: a service subscribed to again after a cancel is a new suggestion", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("charges after the cancel form a new suggestion with a new-subscription alert; the cancelled item keeps its history", async () => {
    const old = await addSeries(f.db, f.checking, "Netflix", -1549n, ["2026-03-05", "2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05"]);
    await runRecurringDetection(f.db, { today: "2026-08-06", now: at("2026-08-06T08:00:00Z") });
    const [item] = await itemsOf(f.db, "Netflix");
    await updateRecurring(f.db, item!.id, { categoryId: f.cat("Subscriptions"), status: "active" }, "2026-08-06", at("2026-08-06T09:00:00Z"));
    await setRecurringStatus(f.db, item!.id, "cancelled", { today: "2026-08-10", now: at("2026-08-10T12:00:00Z") });

    const fresh = await addSeries(f.db, f.checking, "Netflix", -1549n, ["2026-11-05", "2026-12-05", "2027-01-05"]);
    const stats = await runRecurringDetection(f.db, { today: "2027-01-10", now: at("2027-01-10T08:00:00Z") });
    expect(stats).toMatchObject({ suggestionsCreated: 1, alertsCreated: 1 });

    const rows = await itemsOf(f.db, "Netflix");
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "suggested"]);
    const [cancelled, again] = rows;
    expect(await linksOf(f.db, cancelled!.id)).toEqual([...old].sort());
    expect(cancelled).toMatchObject({ chargeCount: 6, lastChargeDate: "2026-08-05", nextDueDate: null });
    expect(await linksOf(f.db, again!.id)).toEqual([...fresh].sort());
    expect(again).toMatchObject({ source: "detected", expectedCents: -1549n, amountMode: "fixed", anchorDay: 5, chargeCount: 3, firstChargeDate: "2026-11-05", lastChargeDate: "2027-01-05", nextDueDate: "2027-02-05", categoryId: f.cat("Subscriptions") });
    // History start of Checking is 2026-03-05: the first new charge is 245 days in and 66 days old → new.
    expect((await alertsOf(f.db, again!.id)).map((a) => [a.kind, a.dedupeKey])).toEqual([["new_recurring", `new:${again!.id}`]]);

    // The next run updates the same suggestion in place and raises nothing.
    const alerts = await alertCount(f.db);
    const rerun = await runRecurringDetection(f.db, { today: "2027-01-11", now: at("2027-01-11T08:00:00Z") });
    expect(rerun).toMatchObject({ suggestionsCreated: 0, suggestionsUpdated: 1, suggestionsDeleted: 0, alertsCreated: 0 });
    expect((await itemsOf(f.db, "Netflix")).map((r) => [r.id, r.status])).toEqual([
      [cancelled!.id, "cancelled"],
      [again!.id, "suggested"],
    ]);
    expect(await alertCount(f.db)).toBe(alerts);

    // Confirmed, it is projected; the cancelled item still is not.
    await updateRecurring(f.db, again!.id, { status: "active" }, "2027-01-11", at("2027-01-11T09:00:00Z"));
    const cf = await projectForHousehold(f.db, { today: "2027-01-11", horizonDays: 60 });
    expect(cf.events.filter((e) => e.label === "Netflix").map((e) => [e.recurringId, e.date])).toEqual([
      [again!.id, "2027-02-05"],
      [again!.id, "2027-03-05"],
    ]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("b5-06, b5-10: the Subscriptions page", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("b5-06: a recurring transfer to the household's own savings is not a subscription", async () => {
    const nf = await addSeries(f.db, f.checking, "Netflix", -1549n, MAY_TO_SEP);
    await activeItem(f.db, { payeeName: "Netflix", accountId: f.checking, categoryId: f.cat("Subscriptions"), anchorDay: 5, expectedCents: -1549n, linkIds: nf, lastChargeDate: "2026-09-05", today: "2026-09-06" });
    await activeItem(f.db, {
      payeeName: "Save monthly",
      accountId: f.checking,
      transferAccountId: f.savings,
      categoryId: f.cat("Savings"),
      anchorDay: 1,
      expectedCents: -50000n,
      linkIds: [],
      lastChargeDate: "2026-09-01",
      today: "2026-09-06",
    });
    const subs = await listSubscriptions(f.db);
    expect(subs.items.map((s) => [s.name, s.yearlyCents])).toEqual([["Netflix", -18588n]]);
    expect(subs.totalYearlyCents).toBe(-18588n);
    expect(subs.totalMonthlyCents).toBe(-1549n);
  });

  it("b5-10: an auto-paused subscription says so after later nightly runs too", async () => {
    const ids = await addSeries(f.db, f.checking, "Gym", -4000n, ["2026-04-05", "2026-05-05", "2026-06-05"]);
    const id = await activeItem(f.db, { payeeName: "Gym", accountId: f.checking, categoryId: f.cat("Subscriptions"), anchorDay: 5, expectedCents: -4000n, linkIds: ids, lastChargeDate: "2026-06-05", today: "2026-06-06" });
    // Jul 5, Aug 5 and Sep 5 are missed by 10-13 (grace 5; Oct 5 is 8 days old, missed too): auto-paused.
    await refreshRecurringItem(f.db, id, "2026-10-13", noon("2026-10-13"));
    let paused = (await listSubscriptions(f.db)).pausedItems.find((s) => s.id === id)!;
    expect(paused).toMatchObject({ status: "paused", statusReason: "missed_3" });
    // The next nightly run refreshes the paused item: consecutive_missed goes back to 0, the reason stays.
    await matchRecurringItems(f.db, "2026-10-14", noon("2026-10-14"));
    paused = (await listSubscriptions(f.db)).pausedItems.find((s) => s.id === id)!;
    expect(paused).toMatchObject({ status: "paused", statusReason: "missed_3", consecutiveMissed: 0 });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("b5-07: a seasonal utility bill is suggested and keeps matching through the winter", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("suggests the gas bill, and after the confirm links the winter bills that swing past three times the summer amount", async () => {
    const amounts = [6000n, 10000n, 14500n, 15000n, 14000n, 11000n, 7000n, 4500n, 3200n, 3000n, 3100n, 3500n, 6200n];
    const months = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
    for (const [i, m] of months.entries()) await addTx(f.db, { accountId: f.checking, payee: "Xcel Gas", date: `${m}-12`, cents: -amounts[i]!, categoryId: f.cat("Utilities") });
    const stats = await runRecurringDetection(f.db, { today: "2026-10-13", now: at("2026-10-13T08:00:00Z") });
    expect(stats.suggestionsCreated).toBe(1);
    const [gas] = await itemsOf(f.db, "Xcel Gas");
    expect(gas).toMatchObject({ status: "suggested", cadence: "monthly", anchorDay: 12, amountMode: "variable", expectedCents: -3500n, toleranceCents: 2700n, chargeCount: 13, nextDueDate: "2026-11-12", categoryId: f.cat("Utilities") });

    await updateRecurring(f.db, gas!.id, { status: "active" }, "2026-10-13", at("2026-10-13T09:00:00Z"));
    // Nov 100.00 (expected 35.00: within 3 × 62.00, the top of the last six); Dec 145.00 and Jan 150.00
    // are more than 3 × the expected 35.00 but within 3 × the largest of the last six charges (100.00, then 145.00).
    for (const [date, cents, day] of [
      ["2026-11-12", -10000n, "2026-11-13"],
      ["2026-12-12", -14500n, "2026-12-13"],
      ["2027-01-12", -15000n, "2027-01-13"],
    ] as const) {
      const tx = await addTx(f.db, { accountId: f.checking, payee: "Xcel Gas", date, cents, categoryId: f.cat("Utilities") });
      expect(await matchRecurringItems(f.db, day, noon(day), { ids: [gas!.id] })).toBe(1);
      expect((await linksOf(f.db, gas!.id)).includes(tx)).toBe(true);
    }
    expect(await row(f.db, gas!.id)).toMatchObject({ status: "active", chargeCount: 16, lastChargeDate: "2027-01-12", consecutiveMissed: 0, nextDueDate: "2027-02-12" });
    expect(await alertsOf(f.db, gas!.id)).toEqual([]);
  });

  it("a variable item's gate still keeps out a charge far outside everything it has seen", async () => {
    const ids = await addSeries(f.db, f.checking, "City Water", -5000n, ["2026-05-20", "2026-06-20", "2026-07-20"]);
    await addTx(f.db, { accountId: f.checking, payee: "City Water", date: "2026-08-20", cents: -6000n });
    const id = await activeItem(f.db, { payeeName: "City Water", accountId: f.checking, categoryId: f.cat("Utilities"), anchorDay: 20, expectedCents: -5000n, linkIds: ids, lastChargeDate: "2026-07-20", today: "2026-07-21" });
    await f.db.update(recurring).set({ amountMode: "variable", toleranceCents: 1000n, amountLocked: true }).where(eq(recurring.id, id));
    expect(await matchRecurringItems(f.db, "2026-08-21", noon("2026-08-21"), { ids: [id] })).toBe(1);
    // A 500.00 one-off on the due day: above 3 × 60.00 (the largest linked charge) → not linked.
    await addTx(f.db, { accountId: f.checking, payee: "City Water", date: "2026-09-20", cents: -50000n });
    expect(await matchRecurringItems(f.db, "2026-09-21", noon("2026-09-21"), { ids: [id] })).toBe(0);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("b5-08, b5-09: the account of an item", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("b5-08: an account chosen by the owner stands until a later charge is linked, which it then follows", async () => {
    const ids = await addSeries(f.db, f.oldVisa, "Netflix", -1549n, APR_TO_SEP);
    const id = await activeItem(f.db, { payeeName: "Netflix", accountId: f.oldVisa, categoryId: f.cat("Subscriptions"), anchorDay: 5, expectedCents: -1549n, linkIds: ids, lastChargeDate: "2026-09-05", today: "2026-09-06" });

    await updateRecurring(f.db, id, { accountId: f.newAmex }, "2026-09-20", noon("2026-09-20"));
    expect((await getRecurring(f.db, id))!.accountName).toBe("New Amex");
    // A nightly run with nothing new keeps it, and the projection debits the new card.
    await matchRecurringItems(f.db, "2026-09-21", noon("2026-09-21"));
    expect((await row(f.db, id)).accountId).toBe(f.newAmex);
    const cf = await projectForHousehold(f.db, { today: "2026-09-21", horizonDays: 20 });
    expect(cf.events.filter((e) => e.recurringId === id).map((e) => [e.date, e.accountId])).toEqual([["2026-10-05", f.newAmex]]);

    // The October charge arrives on the new card: linked, still the new card.
    await addTx(f.db, { accountId: f.newAmex, payee: "Netflix", date: "2026-10-05", cents: -1549n });
    expect(await matchRecurringItems(f.db, "2026-10-06", noon("2026-10-06"), { ids: [id] })).toBe(1);
    expect((await row(f.db, id)).accountId).toBe(f.newAmex);
    // November is charged to the old card after all: the item follows the charge that happened.
    await addTx(f.db, { accountId: f.oldVisa, payee: "Netflix", date: "2026-11-05", cents: -1549n });
    expect(await matchRecurringItems(f.db, "2026-11-06", noon("2026-11-06"), { ids: [id] })).toBe(1);
    expect((await row(f.db, id)).accountId).toBe(f.oldVisa);
  });

  it("b5-08: a suggestion keeps the owner's account across runs until a new charge arrives", async () => {
    await addSeries(f.db, f.oldVisa, "Spotify", -1199n, APR_TO_SEP);
    await runRecurringDetection(f.db, { today: "2026-09-20", now: at("2026-09-20T08:00:00Z") });
    const [s] = await itemsOf(f.db, "Spotify");
    expect(s!.accountId).toBe(f.oldVisa);
    await updateRecurring(f.db, s!.id, { accountId: f.newAmex }, "2026-09-20", at("2026-09-20T09:00:00Z"));
    await runRecurringDetection(f.db, { today: "2026-09-21", now: at("2026-09-21T08:00:00Z") });
    expect((await row(f.db, s!.id)).accountId).toBe(f.newAmex);
    await addTx(f.db, { accountId: f.oldVisa, payee: "Spotify", date: "2026-10-05", cents: -1199n });
    await runRecurringDetection(f.db, { today: "2026-10-06", now: at("2026-10-06T08:00:00Z") });
    expect(await row(f.db, s!.id)).toMatchObject({ accountId: f.oldVisa, lastChargeDate: "2026-10-05" });
  });

  it("b5-09: an active item cannot lose its account; a paused one can, and then needs one to resume", async () => {
    const ids = await addSeries(f.db, f.checking, "Water", -4000n, ["2026-07-15", "2026-08-15", "2026-09-15"]);
    const id = await activeItem(f.db, { payeeName: "Water", accountId: f.checking, categoryId: f.cat("Utilities"), anchorDay: 15, expectedCents: -4000n, linkIds: ids, lastChargeDate: "2026-09-15", today: "2026-09-16" });

    const refused = updateRecurring(f.db, id, { accountId: null }, "2026-09-20", noon("2026-09-20"));
    await expect(refused).rejects.toBeInstanceOf(RecurringError);
    await expect(refused).rejects.toMatchObject({ status: 400, code: "account_required" });
    expect((await row(f.db, id)).accountId).toBe(f.checking);

    await updateRecurring(f.db, id, { status: "paused", accountId: null }, "2026-09-20", noon("2026-09-20"));
    expect(await row(f.db, id)).toMatchObject({ status: "paused", accountId: null });
    await expect(setRecurringStatus(f.db, id, "active", { today: "2026-09-21", now: noon("2026-09-21") })).rejects.toMatchObject({ status: 400, code: "account_required" });
    await expect(updateRecurring(f.db, id, { status: "active" }, "2026-09-21", noon("2026-09-21"))).rejects.toMatchObject({ code: "account_required" });
    await updateRecurring(f.db, id, { status: "active", accountId: f.checking }, "2026-09-21", noon("2026-09-21"));
    expect(await row(f.db, id)).toMatchObject({ status: "active", accountId: f.checking });

    // A hand-made item is active from the start, so it needs one too.
    await expect(
      createManualRecurring(f.db, { name: "Trash", payeeName: "Trash Co", categoryId: f.cat("Utilities"), accountId: null, cadence: "monthly", anchorDay: 3, expectedCents: -2500n }, "2026-09-21", { now: noon("2026-09-21") }),
    ).rejects.toMatchObject({ status: 400, code: "account_required" });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("b5-11, b5-12, b5-13: history guard, moving a charge, income", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setup();
  });
  afterAll(async () => {
    await f?.t.cleanup();
  });

  it("b5-11: a subscription that moved to a card with long history is not new when it started at the first sync of the old card", async () => {
    await addTx(f.db, { accountId: f.newAmex, payee: "Grocer", date: "2026-01-02", cents: -2000n });
    await addTx(f.db, { accountId: f.oldVisa, payee: "Grocer", date: "2026-07-13", cents: -2000n });
    await addSeries(f.db, f.oldVisa, "Disney", -1399n, ["2026-07-15", "2026-08-15"]);
    await addSeries(f.db, f.newAmex, "Disney", -1399n, ["2026-09-15", "2026-10-15"]);
    const stats = await runRecurringDetection(f.db, { today: "2026-10-20", now: at("2026-10-20T08:00:00Z") });
    const [d] = await itemsOf(f.db, "Disney");
    expect(d).toMatchObject({ status: "suggested", accountId: f.newAmex, firstChargeDate: "2026-07-15" });
    // History start of the first charge's card (Old Visa) is 07-13, 2 days before the first charge: not new.
    expect(await alertsOf(f.db, d!.id)).toEqual([]);
    expect(stats.alertsCreated).toBe(0);
  });

  it("b5-12: a charge linked to one item can be moved to another item of the same payee", async () => {
    const a = await addSeries(f.db, f.oldVisa, "Apple", -299n, ["2026-07-02", "2026-08-02", "2026-09-02"]);
    const b = await addSeries(f.db, f.newAmex, "Apple", -299n, ["2026-07-03", "2026-08-03"]);
    const itemA = await activeItem(f.db, { payeeName: "Apple", accountId: f.oldVisa, categoryId: f.cat("Subscriptions"), anchorDay: 2, expectedCents: -299n, linkIds: a, lastChargeDate: "2026-09-02", today: "2026-09-04" });
    const itemB = await activeItem(f.db, { payeeName: "Apple", accountId: f.newAmex, categoryId: f.cat("Subscriptions"), anchorDay: 3, expectedCents: -299n, linkIds: b, lastChargeDate: "2026-08-03", today: "2026-09-04" });
    const charge = a[2]!; // 09-02, linked to A

    // Without asking to move, a linked charge is still a conflict.
    await expect(linkTransaction(f.db, itemB, charge, "2026-09-04", noon("2026-09-04"))).rejects.toMatchObject({ status: 409, code: "conflict" });
    await linkTransaction(f.db, itemB, charge, "2026-09-04", noon("2026-09-04"), { move: true });
    expect(await linksOf(f.db, itemB)).toEqual([...b, charge].sort());
    expect(await linksOf(f.db, itemA)).toEqual([a[0]!, a[1]!].sort());
    expect(await row(f.db, itemA)).toMatchObject({ chargeCount: 2, lastChargeDate: "2026-08-02", nextDueDate: "2026-09-02" });
    expect(await row(f.db, itemB)).toMatchObject({ chargeCount: 3, lastChargeDate: "2026-09-02" });

    // A move still checks the target: another payee's charge is refused and stays where it was.
    const other = await addSeries(f.db, f.oldVisa, "Hulu", -1549n, ["2026-07-05", "2026-08-05", "2026-09-05"]);
    const hulu = await activeItem(f.db, { payeeName: "Hulu", accountId: f.oldVisa, categoryId: f.cat("Subscriptions"), anchorDay: 5, expectedCents: -1549n, linkIds: other, lastChargeDate: "2026-09-05", today: "2026-09-06" });
    await expect(linkTransaction(f.db, itemB, other[2]!, "2026-09-06", noon("2026-09-06"), { move: true })).rejects.toMatchObject({ status: 400, code: "validation" });
    expect(await linksOf(f.db, hulu)).toEqual([...other].sort());
  });

  it("b5-13: a raise on a paycheck is not a price increase", async () => {
    const ids = await addSeries(f.db, f.checking, "Acme Payroll", 500000n, ["2026-07-01", "2026-08-01", "2026-09-01"]);
    const id = await activeItem(f.db, { payeeName: "Acme Payroll", accountId: f.checking, categoryId: f.cat("Paycheck"), anchorDay: 1, expectedCents: 500000n, linkIds: ids, lastChargeDate: "2026-09-01", today: "2026-09-02" });
    await addTx(f.db, { accountId: f.checking, payee: "Acme Payroll", date: "2026-10-01", cents: 530000n });
    expect(await matchRecurringItems(f.db, "2026-10-02", noon("2026-10-02"), { ids: [id] })).toBe(1);
    expect(await alertsOf(f.db, id)).toEqual([]);
    expect(await row(f.db, id)).toMatchObject({ amountMode: "fixed", expectedCents: 530000n, lastChargeCents: 530000n });
  });
});
