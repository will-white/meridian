import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DashboardView } from "@meridian/shared";
import { account, balanceSnapshot, connection, recurring } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { PLAN_SEED_TODAY, seedPlanFixture, type PlanSeed } from "../test/planSeed.js";
import { dismissAlert } from "./alerts.js";
import { PlanError } from "./audit.js";
import { getDashboard, listBillsDue, netWorth, toDashboardView } from "./dashboard.js";
import { updateTransaction } from "./transactions.js";

/**
 * Dashboard on the grid-and-api seed, today 2026-10-13 (design "GET /api/dashboard
 * computed on request"): leftToSpend 175352, pace 9229/day over 19 days, bills due only
 * Internet 2026-10-20 (window ends 10-27), net worth 575000 today vs 350000 a year ago
 * with Visa new, review {1, 2, 1}, 31 cash-flow points starting today.
 */

describe.skipIf(!TEST_DATABASE_URL)("dashboard on the grid-and-api seed", () => {
  let t: TestDb;
  let S: PlanSeed;
  const today = PLAN_SEED_TODAY;
/** Phase 3: the net-worth breakdown by account kind of a household without investment accounts. */
const ZERO_BREAKDOWN = { investmentsCents: 0n, investmentsAsOf: null, cashCents: 0n, debtCents: 0n, otherCents: 0n };

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedPlanFixture(t.db);
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("assembles the design's numbers from a fresh seed, identically twice", async () => {
    const d = await getDashboard(t.db, { today });
    expect(d.today).toBe(today);
    expect(d.plan).toEqual({
      month: "2026-10",
      leftToSpendCents: 175352n,
      toAssignCents: 175452n,
      zeroBased: false,
      warning: false,
      pace: { daysLeft: 19, perDayCents: 9229n, overCents: 0n },
      planned: { income: 500000n, bills: 189548n, savings: 50000n, spending: 85000n },
      actual: { income: 250000n, bills: 181649n, savings: 30000n, spending: 80000n },
      committed: { income: 500000n, bills: 189648n, savings: 50000n, spending: 85000n },
      uncategorized: { count: 1, cents: -4500n },
    });

    expect(d.billsDue).toEqual([
      { recurringId: S.recurring.internet, name: "Internet", categoryName: "Internet", accountName: "Checking", dueDate: "2026-10-20", amountCents: -7999n, overdue: false },
    ]);

    expect(d.netWorth).toEqual({
      asOf: today,
      todayCents: 575000n,
      yearAgoDate: "2025-10-13",
      yearAgoCents: 350000n,
      changeCents: 225000n,
      newAccounts: [{ id: S.accounts.visa, name: "Visa" }],
      breakdown: { ...ZERO_BREAKDOWN, cashCents: 620000n, debtCents: -45000n },
    });
    expect(d.investments).toBeNull();

    expect(d.review).toEqual({ uncategorized: 1, suggestedRecurring: 2, alerts: 1 });
    expect(d.sync).toEqual({ lastSyncAt: null, attention: [] });
    expect(d.retirement).toBeNull();

    expect(d.cashFlow.asOf).toBe(today);
    expect(d.cashFlow.horizonDays).toBe(30);
    expect(d.cashFlow.thresholdCents).toBe(0n);
    expect(d.cashFlow.points).toHaveLength(31);
    expect(d.cashFlow.points[0]?.date).toBe(today);
    expect(d.cashFlow.points[30]?.date).toBe("2026-11-12");
    // The seed carries no account balances: openings are the pending sum only (Visa −2500), so the
    // line only falls and the low point is the last day; the loader and engine both say why. Day 0
    // also carries October's spread: Checking 14031/19 → 739 (rem 9), Visa 969/19 → 51; −2500 − 790.
    expect(d.cashFlow.points[0]?.cents).toBe(-3290n);
    expect(d.cashFlow.lowPoint).toEqual({ date: "2026-11-12", cents: d.cashFlow.points[30]?.cents });
    expect(d.cashFlow.firstBelow).toBe(today);
    expect(d.cashFlow.warnings).toEqual([
      "account Checking has no known balance",
      "account Savings has no known balance",
      "account Visa has no known balance",
      "1 month uses 3-month averages for unplanned spending categories",
      "card Visa has no payment day",
    ]);

    expect(await getDashboard(t.db, { today })).toEqual(d);
    await expect(getDashboard(t.db, { today: "2026-10-32" })).rejects.toBeInstanceOf(PlanError);
  });

  it("maps to the DashboardView contract with cents as strings", async () => {
    const view = toDashboardView(await getDashboard(t.db, { today }));
    expect(DashboardView.parse(view)).toEqual(view);
    expect(view.plan).toMatchObject({ leftToSpendCents: "175352", toAssignCents: "175452", pace: { daysLeft: 19, perDayCents: "9229", overCents: "0" } });
    expect(view.plan.committed).toEqual({ income: "500000", bills: "189648", savings: "50000", spending: "85000" });
    expect(view.plan.uncategorized).toEqual({ count: 1, cents: "-4500" });
    expect(view.billsDue).toEqual([{ recurringId: S.recurring.internet, name: "Internet", categoryName: "Internet", accountName: "Checking", dueDate: "2026-10-20", amountCents: "-7999", overdue: false }]);
    expect(view.netWorth).toEqual({
      asOf: today,
      todayCents: "575000",
      yearAgoDate: "2025-10-13",
      yearAgoCents: "350000",
      changeCents: "225000",
      newAccounts: [{ id: S.accounts.visa, name: "Visa" }],
      // Phase 3: checking 320,000 + savings 300,000 cash; Visa −45,000 debt; no investment accounts.
      breakdown: { investmentsCents: "0", investmentsAsOf: null, cashCents: "620000", debtCents: "-45000", otherCents: "0" },
    });
    expect(view.investments).toBeNull();
    expect(view.cashFlow.points[0]).toEqual({ date: today, cents: "-3290" });
    expect(view.cashFlow.thresholdCents).toBe("0");
    expect(view.sync).toEqual({ lastSyncAt: null, attention: [] });
    expect(view.retirement).toBeNull();
  });

  it("bills due: window boundary, overdue items, schedule expansion, income and non-active items excluded", async () => {
    // Netflix due on the window's last day (10-27) is in; 10-28 is out.
    await t.db.update(recurring).set({ anchorDay: 27, nextDueDate: "2026-10-27" }).where(eq(recurring.id, S.recurring.netflix));
    expect((await listBillsDue(t.db, { today })).map((b) => [b.name, b.dueDate, b.overdue])).toEqual([
      ["Internet", "2026-10-20", false],
      ["Netflix", "2026-10-27", false],
    ]);
    await t.db.update(recurring).set({ anchorDay: 28, nextDueDate: "2026-10-28" }).where(eq(recurring.id, S.recurring.netflix));
    expect((await listBillsDue(t.db, { today })).map((b) => b.name)).toEqual(["Internet"]);

    // Internet three days late: listed once with its original due date, flagged overdue; next month's is outside.
    await t.db.update(recurring).set({ anchorDay: 10, nextDueDate: "2026-10-10" }).where(eq(recurring.id, S.recurring.internet));
    expect((await listBillsDue(t.db, { today })).map((b) => [b.name, b.dueDate, b.overdue])).toEqual([["Internet", "2026-10-10", true]]);

    // A weekly outflow expands to every occurrence in the window; an income item and a paused item never show.
    const extra = await t.db
      .insert(recurring)
      .values([
        { payeeId: S.payees.gym, name: "Cleaner", categoryId: S.categories.shopping, accountId: S.accounts.checking, cadence: "weekly", anchorDate: "2026-10-14", expectedCents: -6000n, nextDueDate: "2026-10-14", source: "manual", status: "active" },
        { payeeId: S.payees.gym, name: "Salary", categoryId: S.categories.paycheck, accountId: S.accounts.checking, cadence: "monthly", anchorDay: 15, expectedCents: 250000n, nextDueDate: "2026-10-15", source: "manual", status: "active" },
        { payeeId: S.payees.gym, name: "Paused", categoryId: S.categories.music, accountId: S.accounts.checking, cadence: "monthly", anchorDay: 16, expectedCents: -500n, nextDueDate: "2026-10-16", source: "manual", status: "paused" },
        { payeeId: S.payees.gym, name: "No account", categoryId: null, accountId: null, cadence: "monthly", anchorDay: 17, expectedCents: -700n, nextDueDate: "2026-10-17", source: "manual", status: "active" },
      ])
      .returning({ id: recurring.id, name: recurring.name });
    const bills = await listBillsDue(t.db, { today });
    expect(bills.map((b) => [b.name, b.dueDate, b.overdue, b.categoryName, b.accountName])).toEqual([
      ["Internet", "2026-10-10", true, "Internet", "Checking"],
      ["Cleaner", "2026-10-14", false, "Shopping", "Checking"],
      ["No account", "2026-10-17", false, null, null],
      ["Cleaner", "2026-10-21", false, "Shopping", "Checking"],
    ]);
    // A wider window reaches Rent (11-01) and the next Internet (11-10).
    expect((await listBillsDue(t.db, { today, days: 30 })).map((b) => [b.name, b.dueDate])).toEqual([
      ["Internet", "2026-10-10"],
      ["Cleaner", "2026-10-14"],
      ["No account", "2026-10-17"],
      ["Cleaner", "2026-10-21"],
      ["Cleaner", "2026-10-28"],
      ["Netflix", "2026-10-28"],
      ["Rent", "2026-11-01"],
      ["Cleaner", "2026-11-04"],
      ["Internet", "2026-11-10"],
      ["Cleaner", "2026-11-11"],
    ]);

    for (const r of extra) await t.db.delete(recurring).where(eq(recurring.id, r.id));
    await t.db.update(recurring).set({ anchorDay: 20, nextDueDate: "2026-10-20" }).where(eq(recurring.id, S.recurring.internet));
    await t.db.update(recurring).set({ anchorDay: 5, nextDueDate: "2026-11-05" }).where(eq(recurring.id, S.recurring.netflix));
  });

  it("net worth: clamped year-ago date, closed accounts excluded, null when nothing that old exists", async () => {
    // Before any snapshot a year earlier than 2025-10: today's sum is 0 and the change is unknown.
    expect(await netWorth(t.db, "2025-09-01")).toEqual({ asOf: "2025-09-01", todayCents: 0n, yearAgoDate: "2024-09-01", yearAgoCents: null, changeCents: null, newAccounts: [], breakdown: ZERO_BREAKDOWN });
    // 2028-02-29 → 2027-02-28.
    expect((await netWorth(t.db, "2028-02-29")).yearAgoDate).toBe("2027-02-28");
    // The day before the seed's current snapshots: both sums read the 2025 rows; Visa is in neither.
    expect(await netWorth(t.db, "2026-10-12")).toEqual({ asOf: "2026-10-12", todayCents: 350000n, yearAgoDate: "2025-10-12", yearAgoCents: 350000n, changeCents: 0n, newAccounts: [], breakdown: { ...ZERO_BREAKDOWN, cashCents: 350000n } });

    // A closed account's snapshots never count; a year-old Visa snapshot removes it from newAccounts.
    const [closed] = await t.db
      .insert(account)
      .values({ name: "Old Card", type: "credit", taxTreatment: "none", closed: true })
      .returning({ id: account.id });
    await t.db.insert(balanceSnapshot).values([
      { accountId: closed!.id, date: today, balanceCents: -99999n, source: "manual" },
      { accountId: closed!.id, date: "2025-10-13", balanceCents: -99999n, source: "manual" },
      { accountId: S.accounts.visa, date: "2025-10-13", balanceCents: -10000n, source: "manual" },
    ]);
    expect(await netWorth(t.db, today)).toEqual({ asOf: today, todayCents: 575000n, yearAgoDate: "2025-10-13", yearAgoCents: 340000n, changeCents: 235000n, newAccounts: [], breakdown: { ...ZERO_BREAKDOWN, cashCents: 620000n, debtCents: -45000n } });
    // A snapshot dated the day after the year-ago date does not count for a year ago.
    await t.db
      .update(balanceSnapshot)
      .set({ date: "2025-10-14" })
      .where(and(eq(balanceSnapshot.accountId, S.accounts.visa), eq(balanceSnapshot.date, "2025-10-13")));
    expect(await netWorth(t.db, today)).toMatchObject({ yearAgoCents: 350000n, changeCents: 225000n, newAccounts: [{ id: S.accounts.visa, name: "Visa" }] });
    await t.db.delete(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, S.accounts.visa), eq(balanceSnapshot.date, "2025-10-14")));
    await t.db.delete(account).where(eq(account.id, closed!.id));
  });

  it("review counts and sync status follow the ledger, the suggestions, the alerts and the connections", async () => {
    await dismissAlert(t.db, S.alerts.netflixPrice);
    await updateTransaction(t.db, S.transactions.amazon, { categoryId: S.categories.shopping });
    await t.db.update(recurring).set({ status: "dismissed" }).where(eq(recurring.id, S.recurring.gym));
    await t.db.insert(connection).values([
      { type: "simplefin", name: "Bank A", status: "ok", lastSyncAt: new Date("2026-10-13T06:00:00Z") },
      { type: "simplefin", name: "Bank B", status: "auth_required", lastSyncAt: new Date("2026-10-10T06:00:00Z") },
      { type: "csv", name: "CSV", status: "error" },
      { type: "simplefin", name: "Bank C", status: "disabled" },
    ]);
    const d = await getDashboard(t.db, { today });
    expect(d.review).toEqual({ uncategorized: 0, suggestedRecurring: 1, alerts: 0 });
    expect(d.plan.uncategorized).toEqual({ count: 0, cents: 0n });
    // Shopping Oct actual 4500 with planned 0: committed spending 85000 + 4500, pace 170852 / 19.
    expect(d.plan).toMatchObject({ leftToSpendCents: 170852n, toAssignCents: 175452n, pace: { daysLeft: 19, perDayCents: 8992n, overCents: 0n } });
    expect(d.sync.lastSyncAt?.toISOString()).toBe("2026-10-13T06:00:00.000Z");
    expect(d.sync.attention.map((a) => [a.name, a.status])).toEqual([
      ["Bank B", "auth_required"],
      ["CSV", "error"],
    ]);
    const view = toDashboardView(d);
    expect(view.sync.lastSyncAt).toBe("2026-10-13T06:00:00.000Z");
    expect(DashboardView.parse(view)).toEqual(view);
  });
});
