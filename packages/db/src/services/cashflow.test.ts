import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CashFlowProjectionResponse } from "@meridian/shared";
import { account, recurring } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "../test/planSeed.js";
import { PlanError } from "./audit.js";
import {
  cardStatementBalance,
  loadCashFlowInput,
  nextPaymentDate,
  projectForHousehold,
  recurringKind,
  spendingRemainingByMonth,
  spendingWeights,
  statementCloseBefore,
  toCashFlowProjectionView,
} from "./cashflow.js";
import { updateHouseholdSetting } from "./settings.js";

/**
 * Loader on the grid-and-api seed (today 2026-10-13). Balances are set here (the seed
 * carries only snapshots): Checking 320000, Savings 300000, Visa −45000 paid from
 * Checking on the 25th with statement day 5. Hand numbers:
 * - openings: Checking 320000, Savings 300000, Visa −45000 + pending −2500 = −47500;
 * - Visa rows after the 10-05 close: −8000 (10-07), +30000 (10-08), −4500 (10-12),
 *   −2500 (10-13 pending) = +15000 → statement balance −47500 − 15000 = −62500;
 * - spending remaining Oct: Groceries max(0, 50000 + 10000 − 54500) = 5500, Dining
 *   max(0, 20000 − 20000) = 0, Fuel 15000 − 5500 = 9500, Old Hobby 0, Shopping 0 → 15000;
 *   Nov: Groceries 50000 (row) + Dining 13000 + Fuel 3000 + Old Hobby 1000 + Shopping 0
 *   (3-month averages, ledger starts 2026-08 so sums / 2) = 67000; Dec, Jan: 23500 +
 *   13000 + 3000 + 1000 = 40500;
 * - spending outflows in [2026-07-16, 2026-10-13]: Checking 152000, Visa 10500, Savings 0.
 */

describe("pure helpers", () => {
  it("derives the kind from the destination account and the sign", () => {
    expect(recurringKind({ transferAccountId: "x", expectedCents: -100n })).toBe("transfer");
    expect(recurringKind({ transferAccountId: null, expectedCents: 100n })).toBe("income");
    expect(recurringKind({ transferAccountId: null, expectedCents: 0n })).toBe("income");
    expect(recurringKind({ transferAccountId: null, expectedCents: -100n })).toBe("bill");
  });

  it("finds the next payment date with month-length clamping", () => {
    expect(nextPaymentDate("2026-10-13", 25)).toBe("2026-10-25");
    expect(nextPaymentDate("2026-10-13", 13)).toBe("2026-10-13");
    expect(nextPaymentDate("2026-10-13", 5)).toBe("2026-11-05");
    expect(nextPaymentDate("2027-02-10", 31)).toBe("2027-02-28");
    expect(nextPaymentDate("2026-12-30", 29)).toBe("2027-01-29");
  });

  it("resolves the statement close strictly before the payment date (same rule as the engine)", () => {
    expect(statementCloseBefore("2026-10-25", 5)).toBe("2026-10-05");
    expect(statementCloseBefore("2026-10-05", 5)).toBe("2026-09-05");
    expect(statementCloseBefore("2027-02-28", 31)).toBe("2027-01-31");
    expect(statementCloseBefore("2026-11-25", 31)).toBe("2026-10-31");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("cash-flow loader on the grid-and-api seed", () => {
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

  it("computes the card's statement balance from today's opening and the rows after the close", async () => {
    expect(await cardStatementBalance(t.db, S.accounts.visa, -47500n, "2026-10-05", today)).toBe(-62500n);
    expect(await cardStatementBalance(t.db, S.accounts.visa, -47500n, "2026-10-12", today)).toBe(-45000n);
    expect(await cardStatementBalance(t.db, S.accounts.visa, -47500n, today, today)).toBe(-47500n);
    // Savings after 09-01: +50000 (09-02), +50000 (10-02), −20000 (10-10) = +80000.
    expect(await cardStatementBalance(t.db, S.accounts.savings, 300000n, "2026-09-01", today)).toBe(220000n);
  });

  it("weights accounts by trailing spending-bucket outflows, in the given account order, dropping zero accounts", async () => {
    const ids = [S.accounts.checking, S.accounts.savings, S.accounts.visa];
    expect(await spendingWeights(t.db, ids, "2026-07-16", today)).toEqual([
      { accountId: S.accounts.checking, weightCents: 152000n },
      { accountId: S.accounts.visa, weightCents: 10500n },
    ]);
    // October only: Checking 35000 + 21000 + 12000 + 3000 (the +1500 refund is not an outflow); Visa 8000 + 2500 pending.
    expect(await spendingWeights(t.db, [S.accounts.visa, S.accounts.checking], "2026-10-01", today)).toEqual([
      { accountId: S.accounts.visa, weightCents: 10500n },
      { accountId: S.accounts.checking, weightCents: 71000n },
    ]);
    expect(await spendingWeights(t.db, [], "2026-07-16", today)).toEqual([]);
  });

  it("spending remaining: current month from the grid's remaining, future months from rows or 3-month averages", async () => {
    expect(await spendingRemainingByMonth(t.db, today, "2026-11-12")).toEqual({
      months: [
        { month: "2026-10", remainingCents: 15000n },
        { month: "2026-11", remainingCents: 67000n },
      ],
      monthsOnAverages: 1,
    });
    expect(await spendingRemainingByMonth(t.db, today, "2027-01-11")).toEqual({
      months: [
        { month: "2026-10", remainingCents: 15000n },
        { month: "2026-11", remainingCents: 67000n },
        { month: "2026-12", remainingCents: 40500n },
        { month: "2027-01", remainingCents: 40500n },
      ],
      monthsOnAverages: 3,
    });
    expect(await spendingRemainingByMonth(t.db, "2026-10-31", "2026-10-31")).toEqual({ months: [{ month: "2026-10", remainingCents: 15000n }], monthsOnAverages: 0 });
  });

  it("loads the six reads for a 30-day horizon", async () => {
    const input = await loadCashFlowInput(t.db, { today, horizonDays: 30 });
    expect(input.today).toBe(today);
    expect(input.horizonDays).toBe(30);
    expect(input.accounts).toEqual([
      { id: S.accounts.checking, name: "Checking", type: "checking", openingCents: 320000n, balanceDate: today, lowBalanceThresholdCents: null },
      { id: S.accounts.savings, name: "Savings", type: "savings", openingCents: 300000n, balanceDate: today, lowBalanceThresholdCents: null },
      { id: S.accounts.visa, name: "Visa", type: "credit", openingCents: -47500n, balanceDate: today, lowBalanceThresholdCents: null },
    ]);

    const byName = new Map(input.recurring.map((r) => [r.name, r]));
    expect([...byName.keys()].sort()).toEqual(["Car Insurance", "Internet", "Netflix", "Rent"]);
    expect(byName.get("Rent")).toEqual({
      id: S.recurring.rent,
      name: "Rent",
      kind: "bill",
      accountId: S.accounts.checking,
      transferAccountId: null,
      schedule: { cadence: "monthly", anchorDay: 1, anchorDay2: null, anchorMonth: null, anchorDate: null },
      nextDueDate: "2026-11-01",
      amountCents: -180000n,
    });
    expect(byName.get("Car Insurance")).toMatchObject({
      kind: "bill",
      schedule: { cadence: "quarterly", anchorDay: 20, anchorMonth: 12 },
      nextDueDate: "2026-12-20",
      amountCents: -45000n,
    });
    expect(byName.get("Internet")).toMatchObject({ nextDueDate: "2026-10-20", amountCents: -7999n });

    expect(input.cardPayments).toEqual([{ cardAccountId: S.accounts.visa, fromAccountId: S.accounts.checking, payDay: 25, statementDay: 5, knownStatementBalanceCents: -62500n }]);
    expect(input.spendingPlan).toEqual([
      { month: "2026-10", remainingCents: 15000n },
      { month: "2026-11", remainingCents: 67000n },
    ]);
    expect(input.spendingWeights).toEqual([
      { accountId: S.accounts.checking, weightCents: 152000n },
      { accountId: S.accounts.visa, weightCents: 10500n },
    ]);
    expect(input.primaryAccountId).toBeNull();
    expect(input.defaultThresholdCents).toBe(0n);
    expect(input.warnings).toEqual(["1 month uses 3-month averages for unplanned spending categories"]);
  });

  it("maps transfers and income, excludes spending-bucket items and transfers into a paid card, warns on items without an account", async () => {
    const extra = await t.db
      .insert(recurring)
      .values([
        { payeeId: S.payees.gym, name: "Auto-save", accountId: S.accounts.checking, transferAccountId: S.accounts.savings, cadence: "monthly", anchorDay: 2, expectedCents: -50000n, nextDueDate: "2026-11-02", source: "manual", status: "active" },
        { payeeId: S.payees.gym, name: "Visa autopay", accountId: S.accounts.checking, transferAccountId: S.accounts.visa, cadence: "monthly", anchorDay: 8, expectedCents: -30000n, nextDueDate: "2026-11-08", source: "manual", status: "active" },
        { payeeId: S.payees.gym, name: "Weekly groceries", categoryId: S.categories.groceries, accountId: S.accounts.checking, cadence: "weekly", anchorDate: "2026-10-16", expectedCents: -10000n, nextDueDate: "2026-10-16", source: "manual", status: "active" },
        { payeeId: S.payees.gym, name: "Orphan bill", categoryId: S.categories.music, accountId: null, cadence: "monthly", anchorDay: 3, expectedCents: -999n, nextDueDate: "2026-11-03", source: "manual", status: "active" },
        { payeeId: S.payees.gym, name: "Salary", categoryId: S.categories.paycheck, accountId: S.accounts.checking, cadence: "twice_monthly", anchorDay: 1, anchorDay2: 15, expectedCents: 250000n, nextDueDate: "2026-10-15", source: "manual", status: "active" },
        { payeeId: S.payees.gym, name: "Paused thing", categoryId: S.categories.music, accountId: S.accounts.checking, cadence: "monthly", anchorDay: 9, expectedCents: -500n, nextDueDate: "2026-11-09", source: "manual", status: "paused" },
      ])
      .returning({ id: recurring.id, name: recurring.name });
    const idOf = (name: string) => extra.find((r) => r.name === name)!.id;

    const input = await loadCashFlowInput(t.db, { today, horizonDays: 30 });
    const names = input.recurring.map((r) => r.name).sort();
    expect(names).toEqual(["Auto-save", "Car Insurance", "Internet", "Netflix", "Rent", "Salary"]);
    expect(input.recurring.find((r) => r.name === "Auto-save")).toEqual({
      id: idOf("Auto-save"),
      name: "Auto-save",
      kind: "transfer",
      accountId: S.accounts.checking,
      transferAccountId: S.accounts.savings,
      schedule: { cadence: "monthly", anchorDay: 2, anchorDay2: null, anchorMonth: null, anchorDate: null },
      nextDueDate: "2026-11-02",
      amountCents: -50000n,
    });
    expect(input.recurring.find((r) => r.name === "Salary")).toMatchObject({
      kind: "income",
      transferAccountId: null,
      schedule: { cadence: "twice_monthly", anchorDay: 1, anchorDay2: 15 },
      amountCents: 250000n,
    });
    // Items arrive in id order (the engine's determinism rule).
    expect(input.recurring.map((r) => r.id)).toEqual([...input.recurring.map((r) => r.id)].sort());
    expect(input.warnings).toEqual(["recurring item Orphan bill has no account and was skipped", "1 month uses 3-month averages for unplanned spending categories"]);

    // Once the card loses its payment day, the autopay transfer is a dated event again and the card has no payment entry.
    await t.db.update(account).set({ paymentDay: null, paymentFromAccountId: null, statementDay: null }).where(eq(account.id, S.accounts.visa));
    const without = await loadCashFlowInput(t.db, { today, horizonDays: 30 });
    expect(without.recurring.map((r) => r.name).sort()).toEqual(["Auto-save", "Car Insurance", "Internet", "Netflix", "Rent", "Salary", "Visa autopay"]);
    expect(without.cardPayments).toEqual([]);
    await t.db
      .update(account)
      .set({ paymentDay: 25, paymentFromAccountId: S.accounts.checking, statementDay: 5 })
      .where(eq(account.id, S.accounts.visa));
    await t.db.delete(recurring).where(eq(recurring.id, idOf("Auto-save")));
    await t.db.delete(recurring).where(eq(recurring.id, idOf("Visa autopay")));
    await t.db.delete(recurring).where(eq(recurring.id, idOf("Weekly groceries")));
    await t.db.delete(recurring).where(eq(recurring.id, idOf("Orphan bill")));
    await t.db.delete(recurring).where(eq(recurring.id, idOf("Salary")));
    await t.db.delete(recurring).where(eq(recurring.id, idOf("Paused thing")));
  });

  it("card payment entries: statement balance only when the close is before today and the payment is inside the horizon", async () => {
    // Payment on the 25th, statement day 20: the close 10-20 is after today, so the engine reads its own point.
    await t.db.update(account).set({ statementDay: 20 }).where(eq(account.id, S.accounts.visa));
    expect((await loadCashFlowInput(t.db, { today, horizonDays: 30 })).cardPayments).toEqual([
      { cardAccountId: S.accounts.visa, fromAccountId: S.accounts.checking, payDay: 25, statementDay: 20, knownStatementBalanceCents: null },
    ]);
    // Statement day null: nothing to derive.
    await t.db.update(account).set({ statementDay: null }).where(eq(account.id, S.accounts.visa));
    expect((await loadCashFlowInput(t.db, { today, horizonDays: 30 })).cardPayments[0]).toMatchObject({ statementDay: null, knownStatementBalanceCents: null });
    // A horizon that ends before the first payment skips the ledger read.
    await t.db.update(account).set({ statementDay: 5 }).where(eq(account.id, S.accounts.visa));
    expect((await loadCashFlowInput(t.db, { today, horizonDays: 5 })).cardPayments[0]).toMatchObject({ statementDay: 5, knownStatementBalanceCents: null });
    expect((await loadCashFlowInput(t.db, { today, horizonDays: 12 })).cardPayments[0]).toMatchObject({ statementDay: 5, knownStatementBalanceCents: -62500n });
  });

  it("restricts to accountIds, rejects unknown or off-budget ids, and warns on a missing balance", async () => {
    const only = await loadCashFlowInput(t.db, { today, horizonDays: 30, accountIds: [S.accounts.checking] });
    expect(only.accounts.map((a) => a.name)).toEqual(["Checking"]);
    expect(only.cardPayments).toEqual([]);
    expect(only.spendingWeights).toEqual([{ accountId: S.accounts.checking, weightCents: 152000n }]);
    // Transfer items still name their destination; the engine decides which legs post.
    expect(only.recurring.map((r) => r.name).sort()).toEqual(["Car Insurance", "Internet", "Netflix", "Rent"]);

    await expect(loadCashFlowInput(t.db, { today, horizonDays: 30, accountIds: [S.accounts.checking, randomUUID()] })).rejects.toBeInstanceOf(PlanError);
    await expect(loadCashFlowInput(t.db, { today, horizonDays: 0 })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(loadCashFlowInput(t.db, { today: "2026-13-01", horizonDays: 30 })).rejects.toMatchObject({ status: 400, code: "validation" });

    const [offBudget] = await t.db
      .insert(account)
      .values({ name: "Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false, balanceCents: 1000000n })
      .returning({ id: account.id });
    await expect(loadCashFlowInput(t.db, { today, horizonDays: 30, accountIds: [offBudget!.id] })).rejects.toMatchObject({ status: 400, code: "bad_request" });
    const all = await loadCashFlowInput(t.db, { today, horizonDays: 30 });
    expect(all.accounts.map((a) => a.name)).toEqual(["Checking", "Savings", "Visa"]);

    await t.db.update(account).set({ balanceCents: null }).where(eq(account.id, S.accounts.savings));
    const noBalance = await loadCashFlowInput(t.db, { today, horizonDays: 30 });
    expect(noBalance.accounts.find((a) => a.name === "Savings")?.openingCents).toBe(0n);
    expect(noBalance.warnings).toContain("account Savings has no known balance");
    await t.db.update(account).set({ balanceCents: 300000n }).where(eq(account.id, S.accounts.savings));
    await t.db.delete(account).where(eq(account.id, offBudget!.id));
  });

  it("projectForHousehold runs the engine on the loaded input and merges the warnings", async () => {
    await updateHouseholdSetting(t.db, { projectionDefaultDays: 30, primaryAccountId: S.accounts.checking }, { userId: null, batchId: randomUUID(), today });
    const result = await projectForHousehold(t.db, { today });
    expect(result.today).toBe(today);
    expect(result.endDate).toBe("2026-11-12");
    expect(result.dates).toHaveLength(31);
    expect(result.accounts.map((a) => a.name)).toEqual(["Checking", "Savings", "Visa"]);
    expect(result.combined.openingCents).toBe(572500n);
    expect(result.warnings).toEqual(["1 month uses 3-month averages for unplanned spending categories"]);

    // Oct 15000 and Nov 67000 split 152000 : 10500 by largest remainder.
    expect(result.spreads.map((s) => [s.month, s.accountId, s.totalCents])).toEqual([
      ["2026-10", S.accounts.checking, 14031n],
      ["2026-10", S.accounts.visa, 969n],
      ["2026-11", S.accounts.checking, 62671n],
      ["2026-11", S.accounts.visa, 4329n],
    ]);

    // Events sort by (date, accountId, ...); the two 10-25 legs are re-sorted by kind here since account ids are random.
    const applied = result.events
      .filter((e) => e.applied)
      .map((e) => [e.date, e.kind, e.label, e.amountCents] as const)
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
    expect(applied).toEqual([
      ["2026-10-20", "bill", "Internet", -7999n],
      ["2026-10-25", "card_payment_in", "Visa payment", 62500n],
      ["2026-10-25", "card_payment_out", "Visa payment", -62500n],
      ["2026-11-01", "bill", "Rent", -180000n],
      ["2026-11-05", "bill", "Netflix", -1549n],
    ]);
    // Combined on 11-12: card payments cancel; October's 15000 is fully spread by 10-31; November's
    // Checking share 62671/30 = 2089 rem 1 and Visa share 4329/30 = 144 rem 9 post 12 days:
    // 2090 + 11×2089 + 9×145 + 3×144 = 26806. 572500 − 15000 − 7999 − 180000 − 1549 − 26806 = 341146.
    expect(result.combined.points[30]).toBe(341146n);
    expect(result.combined.minDate).toBe("2026-11-12");

    // Request overrides: threshold, horizon, a what-if, a subset.
    const tweaked = await projectForHousehold(t.db, {
      today,
      horizonDays: 10,
      thresholdCents: 600000n,
      accountIds: [S.accounts.checking],
      whatIfs: [{ kind: "skipOccurrence", recurringId: S.recurring.internet, occurrenceDate: "2026-10-20" }],
    });
    expect(tweaked.dates).toHaveLength(11);
    expect(tweaked.accounts.map((a) => a.name)).toEqual(["Checking"]);
    expect(tweaked.combined.thresholdCents).toBe(600000n);
    expect(tweaked.combined.alreadyBelow).toBe(true);
    expect(tweaked.whatIfs).toEqual([{ index: 0, applied: true }]);
    expect(tweaked.events.find((e) => e.label === "Internet")?.applied).toBe(false);

    // Runs are pure: the same request twice is deep-equal, and nothing was written.
    expect(await projectForHousehold(t.db, { today })).toEqual(result);

    const view = toCashFlowProjectionView(result);
    expect(CashFlowProjectionResponse.parse(view)).toEqual(view);
    expect(view.combined.openingCents).toBe("572500");
    expect(view.events[0]).toMatchObject({ accountName: "Checking", amountCents: "-7999", kind: "bill" });
    const skipped = toCashFlowProjectionView(tweaked);
    expect(skipped.whatIfs).toEqual([{ index: 0, applied: true }]);
    expect(CashFlowProjectionResponse.parse(skipped)).toEqual(skipped);
  });
});
