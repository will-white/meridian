import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, recurring, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "../test/planSeed.js";
import { cardStatementBalance, loadCashFlowInput, projectForHousehold } from "./cashflow.js";
import { listBillsDue, netWorth } from "./dashboard.js";

/** Review probes of the loader and dashboard on the grid-and-api seed (today 2026-10-13). */

describe.skipIf(!TEST_DATABASE_URL)("cash-flow loader and dashboard review probes", () => {
  let t: TestDb;
  let S: PlanSeed;
  const today = PLAN_SEED_TODAY;

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedPlanFixture(t.db);
    await t.db.update(account).set({ balanceCents: 320000n, balanceDate: today }).where(eq(account.id, S.accounts.checking));
    await t.db.update(account).set({ balanceCents: 300000n, balanceDate: today }).where(eq(account.id, S.accounts.savings));
    await t.db
      .update(account)
      .set({ balanceCents: -45000n, balanceDate: today, paymentDay: 25, paymentFromAccountId: S.accounts.checking, statementDay: 5 })
      .where(eq(account.id, S.accounts.visa));
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("B1. payment day = today: the close before it is read from the ledger and the payment posts on day 0", async () => {
    await t.db.update(account).set({ paymentDay: 13 }).where(eq(account.id, S.accounts.visa));
    const input = await loadCashFlowInput(t.db, { today, horizonDays: 10 });
    expect(input.cardPayments[0]).toMatchObject({ payDay: 13, statementDay: 5, knownStatementBalanceCents: -62500n });
    const r = await projectForHousehold(t.db, { today, horizonDays: 10 });
    const pay = r.events.filter((e) => e.kind === "card_payment_out");
    expect(pay.map((e) => [e.date, e.amountCents])).toEqual([[today, -62500n]]);
    await t.db.update(account).set({ paymentDay: 25 }).where(eq(account.id, S.accounts.visa));
  });

  it("B2. a pending transaction dated after today is in the opening balance but not in the statement balance window", async () => {
    // Future-dated pending charge on the card: opening = −45000 − 2500 − 1000 = −48500.
    const [row] = await t.db
      .insert(transaction)
      .values({ accountId: S.accounts.visa, date: "2026-10-20", amountCents: -1000n, rawDescription: "FUTURE", pending: true, source: "manual" })
      .returning({ id: transaction.id });
    const input = await loadCashFlowInput(t.db, { today, horizonDays: 30 });
    const visa = input.accounts.find((a) => a.id === S.accounts.visa)!;
    expect(visa.openingCents).toBe(-48500n);
    // The statement balance at 10-05 should still be −62500 (the future row is not between the close and today).
    expect(await cardStatementBalance(t.db, S.accounts.visa, visa.openingCents, "2026-10-05", today)).toBe(-63500n);
    await t.db.delete(transaction).where(eq(transaction.id, row!.id));
  });

  it("B3. bills due: an overdue item with a weekly schedule lists its missed date once and the in-window occurrences", async () => {
    const [weekly] = await t.db
      .insert(recurring)
      .values({ payeeId: S.payees.gym, name: "Cleaner", categoryId: S.categories.shopping, accountId: S.accounts.checking, cadence: "weekly", anchorDate: "2026-09-30", expectedCents: -6000n, nextDueDate: "2026-10-07", source: "manual", status: "active" })
      .returning({ id: recurring.id });
    const bills = (await listBillsDue(t.db, { today })).filter((b) => b.name === "Cleaner").map((b) => [b.dueDate, b.overdue]);
    expect(bills).toEqual([
      ["2026-10-07", true],
      ["2026-10-14", false],
      ["2026-10-21", false],
    ]);
    await t.db.delete(recurring).where(eq(recurring.id, weekly!.id));
  });

  it("B4. net worth: an off-budget account counts; a snapshot exactly on the year-ago date counts", async () => {
    const [brk] = await t.db
      .insert(account)
      .values({ name: "Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false })
      .returning({ id: account.id });
    const { balanceSnapshot } = await import("../schema/index.js");
    await t.db.insert(balanceSnapshot).values([
      { accountId: brk!.id, date: "2025-10-13", balanceCents: 100000n, source: "manual" },
      { accountId: brk!.id, date: today, balanceCents: 150000n, source: "manual" },
    ]);
    const nw = await netWorth(t.db, today);
    expect(nw.todayCents).toBe(725000n);
    expect(nw.yearAgoCents).toBe(450000n);
    expect(nw.newAccounts.map((a) => a.name)).toEqual(["Visa"]);
    await t.db.delete(balanceSnapshot).where(eq(balanceSnapshot.accountId, brk!.id));
    await t.db.delete(account).where(eq(account.id, brk!.id));
  });
});
