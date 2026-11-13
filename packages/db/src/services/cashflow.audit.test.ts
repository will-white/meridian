import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IsoDate } from "@meridian/shared";
import type { Db } from "../index.js";
import { account, category, recurring, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { loadCashFlowInput, projectForHousehold, toCashFlowProjectionView } from "./cashflow.js";
import { seedDefaultCategories } from "./categories.js";
import { getPlan, setPlanCells } from "./plan.js";
import { resolvePayee } from "./payees.js";
import { createManualRecurring, refreshRecurringItem } from "./recurring.js";

/**
 * Audit batch b5 (recurring detection and cash flow), finding b5-recurring-cashflow-01: a card
 * statement that was already paid, in full or in part, before the payment day is paid again
 * in the projection. Hand numbers, today 2026-10-13: Checking 300,000; the Visa (statement day
 * 5, payment day 25, paid from Checking) closed on 10-05 at −40,000 (one charge of −40,000 on
 * 09-20); a −5,000 charge on 10-11 is after the close and belongs to the next statement.
 */
describe.skipIf(!TEST_DATABASE_URL)("cash flow: card payments already made since the statement close (b5-01)", () => {
  let t: TestDb;
  let db: Db;
  let checking: string;
  let visa: string;
  const today: IsoDate = "2026-10-13";

  async function row(accountId: string, date: IsoDate, cents: bigint, opts: { pending?: boolean; pair?: string } = {}): Promise<void> {
    await db.insert(transaction).values({
      accountId,
      date,
      amountCents: cents,
      rawDescription: cents < 0n ? "CHARGE" : "PAYMENT",
      source: "manual",
      pending: opts.pending ?? false,
      isTransfer: opts.pair !== undefined,
      transferPairId: opts.pair ?? null,
    });
  }

  /** A payment from Checking to the Visa on `date`: a transfer pair, already in both balances. */
  async function payment(date: IsoDate, cents: bigint): Promise<void> {
    const pair = randomUUID();
    await row(checking, date, -cents, { pair });
    await row(visa, date, cents, { pair });
  }

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const [c, v] = await db
      .insert(account)
      .values([
        { name: "Checking", type: "checking", taxTreatment: "none" },
        { name: "Visa", type: "credit", taxTreatment: "none" },
      ])
      .returning({ id: account.id });
    checking = c!.id;
    visa = v!.id;
    await db.update(account).set({ paymentDay: 25, paymentFromAccountId: checking, statementDay: 5 }).where(eq(account.id, visa));
  });
  beforeEach(async () => {
    await db.delete(transaction);
    await db.update(account).set({ paymentDay: 25 }).where(eq(account.id, visa));
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  async function setBalances(checkingCents: bigint, visaCents: bigint): Promise<void> {
    await db.update(account).set({ balanceCents: checkingCents, balanceDate: today }).where(eq(account.id, checking));
    await db.update(account).set({ balanceCents: visaCents, balanceDate: today }).where(eq(account.id, visa));
  }

  async function cardPayments(horizonDays: number): Promise<Array<[string, string, bigint]>> {
    const r = await projectForHousehold(db, { today, horizonDays });
    return r.events
      .filter((e) => e.kind === "card_payment_out" || e.kind === "card_payment_in")
      .map((e): [string, string, bigint] => [e.date, e.kind, e.amountCents])
      .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
  }

  it("a statement paid in full on 10-10 is not paid again on 10-25; the 10-11 charge is paid on 11-25", async () => {
    await row(visa, "2026-09-20", -40000n);
    await payment("2026-10-10", 40000n);
    await row(visa, "2026-10-11", -5000n);
    // Checking 300,000 already reflects the 40,000 it sent; the Visa is at −40,000 + 40,000 − 5,000.
    await setBalances(300000n, -5000n);

    const input = await loadCashFlowInput(db, { today, horizonDays: 60 });
    // Unpaid part of the 10-05 statement: −40,000 at the close + 40,000 paid since = 0.
    expect(input.cardPayments[0]).toMatchObject({ payDay: 25, statementDay: 5, knownStatementBalanceCents: 0n });

    // Nothing on 10-25. On 11-25 the 11-05 statement is the projected −5,000 (no plan, no recurring).
    expect(await cardPayments(60)).toEqual([
      ["2026-11-25", "card_payment_in", 5000n],
      ["2026-11-25", "card_payment_out", -5000n],
    ]);
    const r = await projectForHousehold(db, { today, horizonDays: 60 });
    const chk = r.accounts.find((a) => a.accountId === checking)!;
    expect(chk.points[12]).toBe(300000n); // 10-25: unchanged
    expect(chk.points.at(-1)).toBe(295000n); // after the 11-25 payment of 5,000
  });

  it("a partial payment since the close leaves only the rest of the statement owed", async () => {
    await row(visa, "2026-09-20", -40000n);
    await payment("2026-10-10", 25000n);
    await row(visa, "2026-10-11", -5000n);
    await setBalances(300000n, -20000n); // −40,000 + 25,000 − 5,000

    const input = await loadCashFlowInput(db, { today, horizonDays: 30 });
    expect(input.cardPayments[0]!.knownStatementBalanceCents).toBe(-15000n); // −40,000 + 25,000
    expect(await cardPayments(30)).toEqual([
      ["2026-10-25", "card_payment_in", 15000n],
      ["2026-10-25", "card_payment_out", -15000n],
    ]);
  });

  it("a refund or a pending payment since the close counts as a credit too, and more than the statement owes nothing", async () => {
    await row(visa, "2026-09-20", -40000n);
    await row(visa, "2026-10-07", 2500n); // merchant refund after the close
    await payment("2026-10-12", 50000n); // overpaid
    await db.update(transaction).set({ pending: true }).where(eq(transaction.date, "2026-10-12"));
    // Pending rows are added to the posted balance by the loader: posted Visa −37,500, pending +50,000.
    await setBalances(350000n, -37500n);
    const input = await loadCashFlowInput(db, { today, horizonDays: 20 });
    expect(input.cardPayments[0]!.knownStatementBalanceCents).toBe(12500n); // −40,000 + 2,500 + 50,000
    expect(await cardPayments(20)).toEqual([]);
  });

  it("payment day today: an autopay already posted today is not paid a second time on day 0", async () => {
    await db.update(account).set({ paymentDay: 13 }).where(eq(account.id, visa));
    await row(visa, "2026-09-20", -40000n);
    await row(visa, "2026-10-11", -5000n);
    await payment(today, 40000n);
    await setBalances(300000n, -5000n);
    const input = await loadCashFlowInput(db, { today, horizonDays: 10 });
    expect(input.cardPayments[0]).toMatchObject({ payDay: 13, knownStatementBalanceCents: 0n });
    expect(await cardPayments(10)).toEqual([]);
  });

  it("without any payment since the close the whole statement is still paid on the payment day", async () => {
    await row(visa, "2026-09-20", -40000n);
    await row(visa, "2026-10-11", -5000n);
    await setBalances(340000n, -45000n);
    const input = await loadCashFlowInput(db, { today, horizonDays: 30 });
    expect(input.cardPayments[0]!.knownStatementBalanceCents).toBe(-40000n);
    expect(await cardPayments(30)).toEqual([
      ["2026-10-25", "card_payment_in", 40000n],
      ["2026-10-25", "card_payment_out", -40000n],
    ]);
  });
});

/**
 * Finding b5-recurring-cashflow-03: income, bills and savings typed into the grid with no
 * recurring item behind them have no date, so the projection does not forecast them; it must
 * say which ones (cash-flow design, risks; phase 2 plan, audit decision A14). Today 2026-11-13,
 * 90 days (through 2027-02-11), Checking 1,000.00. Typed plans: Utilities Nov 50.00 (nothing
 * paid yet) and Dec 150.00, Insurance Jan 600.00, Paycheck Dec 4,000.00, Rent / Mortgage Dec
 * 2,000.00 (the rent item schedules 1,800.00 of it), Phone & Internet Nov 80.00 (already paid on
 * Nov 3). The rent item, due on the 1st, plans 1,800.00 in Dec, Jan and Feb by itself.
 */
describe.skipIf(!TEST_DATABASE_URL)("cash flow: planned amounts without a schedule (b5-03)", () => {
  let t: TestDb;
  let db: Db;
  const today: IsoDate = "2026-11-13";
  const cat = new Map<string, string>();

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    await seedDefaultCategories(db);
    for (const c of await db.select({ id: category.id, name: category.name }).from(category)) cat.set(c.name, c.id);
    const [chk] = await db.insert(account).values({ name: "Checking", type: "checking", taxTreatment: "none", balanceCents: 100000n, balanceDate: today }).returning({ id: account.id });
    const phone = await resolvePayee(db, "Phone Co");
    await db.insert(transaction).values({ accountId: chk!.id, date: "2026-11-03", amountCents: -8000n, rawDescription: "PHONE CO", payeeId: phone.id, categoryId: cat.get("Phone & Internet")!, source: "manual" });
    await createManualRecurring(
      db,
      { name: "Rent", payeeName: "Landlord", categoryId: cat.get("Rent / Mortgage")!, accountId: chk!.id, cadence: "monthly", anchorDay: 1, expectedCents: -180000n },
      today,
      { now: new Date(`${today}T12:00:00Z`) },
    );
    const ctx = { userId: null, batchId: randomUUID(), today };
    await setPlanCells(
      db,
      [
        { month: "2026-11", categoryId: cat.get("Utilities")!, plannedCents: 5000n },
        { month: "2026-12", categoryId: cat.get("Utilities")!, plannedCents: 15000n },
        { month: "2027-01", categoryId: cat.get("Insurance")!, plannedCents: 60000n },
        { month: "2026-12", categoryId: cat.get("Paycheck")!, plannedCents: 400000n },
        { month: "2026-12", categoryId: cat.get("Rent / Mortgage")!, plannedCents: 200000n },
        { month: "2026-11", categoryId: cat.get("Phone & Internet")!, plannedCents: 8000n },
      ],
      ctx,
    );
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("names every planned amount that no recurring schedule forecasts, with the part that is missing", async () => {
    const input = await loadCashFlowInput(db, { today, horizonDays: 90 });
    expect(input.unscheduled).toEqual([
      { month: "2026-11", categoryId: cat.get("Utilities"), categoryName: "Utilities", bucket: "bills", amountCents: 5000n },
      { month: "2026-12", categoryId: cat.get("Paycheck"), categoryName: "Paycheck", bucket: "income", amountCents: 400000n },
      { month: "2026-12", categoryId: cat.get("Rent / Mortgage"), categoryName: "Rent / Mortgage", bucket: "bills", amountCents: 20000n },
      { month: "2026-12", categoryId: cat.get("Utilities"), categoryName: "Utilities", bucket: "bills", amountCents: 15000n },
      { month: "2027-01", categoryId: cat.get("Insurance"), categoryName: "Insurance", bucket: "bills", amountCents: 60000n },
    ]);
    expect(input.warnings).toContain("5 planned amounts have no recurring schedule and are not in the projection: Utilities, Paycheck, Rent / Mortgage, Insurance");

    // The projection still forecasts only the dated rent (Dec 1, Jan 1, Feb 1) and says why the rest is missing.
    const r = await projectForHousehold(db, { today, horizonDays: 90 });
    expect(r.events.map((e) => [e.date, e.label, e.amountCents])).toEqual([
      ["2026-12-01", "Rent", -180000n],
      ["2027-01-01", "Rent", -180000n],
      ["2027-02-01", "Rent", -180000n],
    ]);
    expect(r.unscheduled).toEqual(input.unscheduled);
    expect(r.warnings).toContain("5 planned amounts have no recurring schedule and are not in the projection: Utilities, Paycheck, Rent / Mortgage, Insurance");
    const view = toCashFlowProjectionView(r);
    expect(view.unscheduled[1]).toEqual({ month: "2026-12", categoryId: cat.get("Paycheck"), categoryName: "Paycheck", bucket: "income", amountCents: "400000" });
  });

  it("a horizon that ends before the month's recurring date still counts that occurrence as scheduled", async () => {
    // 2026-11-13 + 20 = 2026-12-03: December is in range, its rent on Dec 1 is dated; Dec's typed 150.00 utilities is not.
    const input = await loadCashFlowInput(db, { today, horizonDays: 20 });
    expect(input.unscheduled.map((u) => [u.month, u.categoryName, u.amountCents])).toEqual([
      ["2026-11", "Utilities", 5000n],
      ["2026-12", "Paycheck", 400000n],
      ["2026-12", "Rent / Mortgage", 20000n],
      ["2026-12", "Utilities", 15000n],
    ]);
    // A horizon inside November: only November's unpaid utilities.
    expect((await loadCashFlowInput(db, { today, horizonDays: 10 })).unscheduled.map((u) => [u.month, u.categoryName])).toEqual([["2026-11", "Utilities"]]);
  });

  it("a month planned by a recurring item is its schedule: a missed occurrence the plan still holds is not listed", async () => {
    const [chk] = await db.select({ id: account.id }).from(account);
    const p = await resolvePayee(db, "Music Co");
    const [oct] = await db
      .insert(transaction)
      .values({ accountId: chk!.id, date: "2026-10-03", amountCents: -999n, rawDescription: "MUSIC CO", payeeId: p.id, categoryId: cat.get("Subscriptions")!, source: "manual" })
      .returning({ id: transaction.id });
    const [item] = await db
      .insert(recurring)
      .values({ payeeId: p.id, name: "Music", categoryId: cat.get("Subscriptions")!, accountId: chk!.id, cadence: "monthly", anchorDay: 3, expectedCents: -999n, status: "active", source: "detected", missedFromDate: "2026-10-03" })
      .returning({ id: recurring.id });
    await db.update(transaction).set({ recurringId: item!.id }).where(eq(transaction.id, oct!.id));
    await refreshRecurringItem(db, item!.id, today, new Date(`${today}T12:00:00Z`)); // Nov 3 is missed: next due Dec 3
    // The plan still holds November's 9.99 (a missed occurrence stays planned until the month ends) ...
    const plan = await getPlan(db, { from: "2026-11", to: "2026-11", today });
    const subs = plan.rows.find((r) => r.kind === "category" && r.categoryId === cat.get("Subscriptions"));
    expect(subs && subs.kind === "category" ? [subs.cells[0]!.plannedCents, subs.cells[0]!.source] : null).toEqual([999n, "recurring"]);
    // ... the projection does not post it, and it is not reported as planned without a schedule.
    const input = await loadCashFlowInput(db, { today, horizonDays: 30 });
    expect(input.unscheduled.map((u) => u.categoryName)).not.toContain("Subscriptions");
    expect(input.recurring.find((r) => r.id === item!.id)?.nextDueDate).toBe("2026-12-03");
    await db.update(transaction).set({ recurringId: null }).where(eq(transaction.id, oct!.id));
    await db.delete(recurring).where(eq(recurring.id, item!.id));
    await db.delete(transaction).where(eq(transaction.id, oct!.id));
  });
});
