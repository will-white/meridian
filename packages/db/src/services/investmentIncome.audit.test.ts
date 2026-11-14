import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { parseFixed8, type PlanCategoryRowResult } from "@meridian/shared";
import { balanceSnapshot, category, investmentTxn, job, rule, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, seedInvestmentLots, type InvestmentSeed } from "../test/investmentSeed.js";
import { getInvestmentIncome, runInvestmentIncomeFeed, setInvestmentIncomeFeed } from "./investmentIncome.js";
import { createInvestmentTxn, deleteInvestmentTxn } from "./investmentTxns.js";
import { getPlan } from "./plan.js";

/**
 * Audit batch b6-investment-views: the Income view and the feed into the plan
 * (docs/audit/phases-1-3/b6-investment-views.md). Each case runs on a fresh INV seed.
 */

const f8 = parseFixed8;
const TODAY = INV_SEED_TODAY;
const NOW = INV_SEED_NOW;
const q = { today: TODAY, now: NOW };
const ctx = () => ({ userId: null, batchId: randomUUID(), today: TODAY });

describe.skipIf(!TEST_DATABASE_URL)("audit b6: investment income", () => {
  let t: TestDb | undefined;
  afterEach(async () => {
    await t?.cleanup();
    t = undefined;
  });
  const fresh = async (): Promise<{ db: TestDb["db"]; S: InvestmentSeed }> => {
    t = await createTestDb();
    const S = await seedInvestmentFixture(t.db);
    await seedInvestmentLots(t.db, S);
    return { db: t.db, S };
  };
  const octoberDividends = async (db: TestDb["db"], S: InvestmentSeed) => {
    const plan = await getPlan(db, { from: "2026-10", to: "2026-10", today: TODAY });
    const row = plan.rows.find((r): r is PlanCategoryRowResult => r.kind === "category" && r.categoryId === S.categories.dividends)!;
    return row.cells[0]!;
  };
  const syntheticRows = async (db: TestDb["db"], accountId: string) =>
    (await db.select({ date: transaction.date, amountCents: transaction.amountCents }).from(transaction).where(and(eq(transaction.accountId, accountId), eq(transaction.source, "investment")))).map((r) => [r.date, r.amountCents]).sort();

  it("b6-02: a dividend fed into the plan leaves it when its reinvest row is recorded later, and comes back when that row goes", async () => {
    const { db, S } = await fresh();
    const R = S.accounts.roth;
    // Create mode: R's four dividends become synthetic Dividends rows (08-05 2,240; 09-04 2,260; 09-28 2,455; 10-06 2,280).
    const set = await setInvestmentIncomeFeed(db, R, "create", { ...ctx(), now: NOW });
    expect(set.run).toMatchObject({ created: 4 });
    expect((await octoberDividends(db, S)).actualCents).toBe(2280n);

    // The 10-06 BND dividend was reinvested: 0.30481283 sh × 74.80 = 22.80 bought back (plan decision 6's two rows).
    const reinvest = await createInvestmentTxn(db, { accountId: R, date: "2026-10-06", type: "reinvest", securityId: S.securities.bnd, quantity: f8("0.30481283"), price: f8("74.8") }, ctx());
    expect(reinvest.items[0]).toMatchObject({ type: "reinvest", amountCents: -2280n });
    // The writer takes the synthetic row out at once: no cash arrived, so October has no dividend income in the plan.
    expect(await syntheticRows(db, R)).toEqual([
      ["2026-08-05", 2240n],
      ["2026-09-04", 2260n],
      ["2026-09-28", 2455n],
    ]);
    expect((await octoberDividends(db, S)).actualCents).toBe(0n);
    const income = await getInvestmentIncome(db, { ...q, accountId: R });
    expect(income.rows.find((r) => r.id === S.txns["rDivBndOct"])).toMatchObject({ reinvested: true, ledgerTransactionId: null, linkStatus: "not_fed", fed: false });
    expect(income.months.find((m) => m.month === "2026-10")).toMatchObject({ dividendsCents: 2280n, reinvestedCents: 2280n });
    expect(income.feed.accounts[0]).toMatchObject({ created: 3, awaiting: 0, fed: 3 });
    // Feed passes stay idempotent: the reinvested dividend is never re-created.
    expect(await runInvestmentIncomeFeed(db, { accountIds: [R], now: NOW })).toMatchObject({ created: 0, deleted: 0, unchanged: 3 });

    // Deleting the reinvest row makes it a cash dividend again: a feed pass is queued and feeds it.
    await db.delete(job).where(eq(job.type, "investments.income_feed"));
    await deleteInvestmentTxn(db, reinvest.items[0]!.id, {}, ctx());
    expect(await db.select().from(job).where(eq(job.type, "investments.income_feed"))).toHaveLength(1);
    expect(await runInvestmentIncomeFeed(db, { accountIds: [R], now: NOW })).toMatchObject({ created: 1, unchanged: 3 });
    expect((await octoberDividends(db, S)).actualCents).toBe(2280n);
  });

  it("b6-02: a feed pass removes a fed row whose reinvest arrived by another path (dividend first, reinvest later)", async () => {
    const { db, S } = await fresh();
    const R = S.accounts.roth;
    await setInvestmentIncomeFeed(db, R, "create", { ...ctx(), now: NOW });
    // A reinvest row written directly (as an import from before this fix left it), bypassing the writers.
    const [div] = await db.select().from(investmentTxn).where(eq(investmentTxn.id, S.txns["rDivVtiSep"]!));
    await db.insert(investmentTxn).values({ accountId: R, securityId: S.securities.vti, date: "2026-09-28", sequence: 99, type: "reinvest", quantity: "0.08", price: "306.875", amountCents: -2455n, source: "manual" });
    expect(div!.ledgerTransactionId).not.toBeNull();
    expect(await runInvestmentIncomeFeed(db, { accountIds: [R], now: NOW })).toMatchObject({ created: 0, deleted: 1, unchanged: 3 });
    expect(await syntheticRows(db, R)).toEqual([
      ["2026-08-05", 2240n],
      ["2026-09-04", 2260n],
      ["2026-10-06", 2280n],
    ]);
    // A synthetic row whose category the owner locked stays (the owner's call), as when the feed is turned off.
    await db.update(transaction).set({ categoryLocked: true }).where(and(eq(transaction.accountId, R), eq(transaction.date, "2026-10-06")));
    await db.insert(investmentTxn).values({ accountId: R, securityId: S.securities.bnd, date: "2026-10-06", sequence: 99, type: "reinvest", quantity: "0.30481283", price: "74.8", amountCents: -2280n, source: "manual" });
    expect(await runInvestmentIncomeFeed(db, { accountIds: [R], now: NOW })).toMatchObject({ deleted: 0 });
    expect((await syntheticRows(db, R)).map((r) => r[0])).toContain("2026-10-06");
  });

  it("b6-04: All covers every income row, even dividends dated before the account's first statement", async () => {
    const { db, S } = await fresh();
    const R = S.accounts.roth;
    // A CSV-only Roth whose first statement is 2026-10-09; its dividends (08-05, 09-04, 09-28, 10-06) came from an activity export.
    await db.delete(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, R), lt(balanceSnapshot.date, "2026-10-09")));
    const ytd = await getInvestmentIncome(db, { ...q, accountId: R, period: "ytd" });
    expect(ytd.totals.totalCents).toBe(9235n);
    const all = await getInvestmentIncome(db, { ...q, accountId: R, period: "all" });
    // From the day before the first dividend, so the (from, to] window includes it: 2,240 + 2,260 + 2,455 + 2,280 = 9,235.
    expect(all.period).toEqual({ kind: "all", from: "2026-08-04", to: "2026-10-13", days: 70, partial: false, note: null });
    expect(all.totals.totalCents).toBe(9235n);
    expect(all.rows.map((r) => r.date)).toEqual(["2026-08-05", "2026-09-04", "2026-09-28", "2026-10-06"]);
    // The household: B's first trade (2024-03-01) is before every income row, so All starts there (as before); it holds YTD's 32,435.
    const household = await getInvestmentIncome(db, { ...q, period: "all" });
    expect(household.period?.from).toBe("2024-03-01");
    expect(household.totals.totalCents).toBe(32435n);
    expect((await getInvestmentIncome(db, { ...q, period: "ytd" })).totals.totalCents).toBe(32435n);
  });

  it("b6-15: every month of the period is listed, months without income as zeros", async () => {
    const { db } = await fresh();
    const v = await getInvestmentIncome(db, q);
    // YTD from 2025-12-31: January through October, income in March, June, August, September and October only.
    expect(v.months.map((m) => [m.month, m.totalCents])).toEqual([
      ["2026-01", 0n],
      ["2026-02", 0n],
      ["2026-03", 8360n],
      ["2026-04", 0n],
      ["2026-05", 0n],
      ["2026-06", 4720n],
      ["2026-07", 0n],
      ["2026-08", 2890n],
      ["2026-09", 14185n],
      ["2026-10", 2280n],
    ]);
    expect(v.months[0]).toEqual({ month: "2026-01", dividendsCents: 0n, interestCents: 0n, feesCents: 0n, reinvestedCents: 0n, totalCents: 0n, bySecurity: [], byAccount: [] });
    expect(v.totals.totalCents).toBe(32435n);
    // A one-month window ending mid-month lists the two months it touches.
    const m = await getInvestmentIncome(db, { ...q, period: "1m" });
    expect(m.months.map((x) => x.month)).toEqual(["2026-09", "2026-10"]);
  });

  const monthDividends = async (db: TestDb["db"], S: InvestmentSeed, month: string) => {
    const plan = await getPlan(db, { from: month, to: month, today: TODAY });
    const row = plan.rows.find((r): r is PlanCategoryRowResult => r.kind === "category" && r.categoryId === S.categories.dividends)!;
    return row.cells[0]!.actualCents;
  };
  const bankCategory = async (db: TestDb["db"], id: string) => {
    const [row] = await db.select({ categoryId: transaction.categoryId, categoryLocked: transaction.categoryLocked }).from(transaction).where(eq(transaction.id, id));
    return row;
  };
  // B's 09-28 VTI dividend (4,910, linked to the 09-29 bank row) bought back: 0.16 sh × 306.875 = 49.10.
  const reinvestVtiSep = (db: TestDb["db"], S: InvestmentSeed) =>
    createInvestmentTxn(db, { accountId: S.accounts.brokerage, date: "2026-09-28", type: "reinvest", securityId: S.securities.vti, quantity: f8("0.16"), price: f8("306.875") }, ctx());

  it("b6-02, second round: in link mode a reinvested dividend's bank row leaves the plan whichever arrives first", async () => {
    // Order 1, the reviewer's probe d2: B's feed categorizes its seven bank rows, then the reinvest row is recorded.
    const first = await fresh();
    const B = first.S.accounts.brokerage;
    expect(await runInvestmentIncomeFeed(first.db, { accountIds: [B], now: NOW })).toMatchObject({ categorized: 7 });
    // September: 4,150 (09-22) + 4,910 (09-29) + 410 (09-30) = 9,470.
    expect(await monthDividends(first.db, first.S, "2026-09")).toBe(9470n);
    await reinvestVtiSep(first.db, first.S);
    // The writer takes the feed category back at once: no cash stayed, so September is 4,150 + 410 = 4,560 (it stayed 9,470).
    expect(await bankCategory(first.db, first.S.ledger["divVtiSep"]!)).toEqual({ categoryId: null, categoryLocked: false });
    expect(await monthDividends(first.db, first.S, "2026-09")).toBe(4560n);
    const income = await getInvestmentIncome(first.db, { ...q, accountId: B });
    expect(income.rows.find((r) => r.id === first.S.txns["divVtiSep"])).toMatchObject({ reinvested: true, ledgerTransactionId: first.S.ledger["divVtiSep"], linkStatus: "linked", fed: false });
    // A feed pass leaves it out (nothing to take back, nothing categorized).
    expect(await runInvestmentIncomeFeed(first.db, { accountIds: [B], now: NOW })).toMatchObject({ categorized: 0, deleted: 0, unchanged: 6 });
    expect(await monthDividends(first.db, first.S, "2026-09")).toBe(4560n);
    await t!.cleanup();
    t = undefined;

    // Order 2 on a fresh seed: the reinvest row first, then the feed. The same plan.
    const second = await fresh();
    await reinvestVtiSep(second.db, second.S);
    expect(await runInvestmentIncomeFeed(second.db, { accountIds: [second.S.accounts.brokerage], now: NOW })).toMatchObject({ categorized: 6 });
    expect(await bankCategory(second.db, second.S.ledger["divVtiSep"]!)).toEqual({ categoryId: null, categoryLocked: false });
    expect(await monthDividends(second.db, second.S, "2026-09")).toBe(4560n);
  });

  it("b6-02, second round: a feed pass takes the feed category back from a reinvested dividend's bank row, leaving the household's own choices", async () => {
    const { db, S } = await fresh();
    const B = S.accounts.brokerage;
    const [brokerage] = await db.insert(category).values({ name: "Brokerage income", bucket: "income", position: 2 }).returning({ id: category.id });
    // The household's rules: VTI dividends to "Brokerage income", VXUS dividends to Dividends (the feed category).
    await db.insert(rule).values([
      { name: "VTI dividends", position: 1, conditions: { description: { op: "contains", value: "DIVIDEND VTI" } }, actions: { setCategoryId: brokerage!.id } },
      { name: "VXUS dividends", position: 2, conditions: { description: { op: "contains", value: "DIVIDEND VXUS" } }, actions: { setCategoryId: S.categories.dividends } },
    ]);
    expect(await runInvestmentIncomeFeed(db, { accountIds: [B], now: NOW })).toMatchObject({ categorized: 7 });
    // The owner put the March VTI dividend in Dividends by hand (locked).
    await db.update(transaction).set({ categoryLocked: true }).where(eq(transaction.id, S.ledger["divVtiMar"]!));
    // Reinvest rows written directly (as an import from before this fix left them), bypassing the writers.
    await db.insert(investmentTxn).values([
      { accountId: B, securityId: S.securities.vti, date: "2026-09-28", sequence: 99, type: "reinvest", quantity: "0.16", price: "306.875", amountCents: -4910n, source: "manual" },
      { accountId: B, securityId: S.securities.vxus, date: "2026-09-22", sequence: 99, type: "reinvest", quantity: "0.625", price: "66.4", amountCents: -4150n, source: "manual" },
      { accountId: B, securityId: S.securities.vti, date: "2026-03-25", sequence: 99, type: "reinvest", quantity: "0.16", price: "285", amountCents: -4560n, source: "manual" },
    ]);
    // One bank row goes back to what the rules give it (09-29 VTI: "Brokerage income"); the VXUS rule
    // already gives the feed category and the March row is the owner's: both stay.
    expect(await runInvestmentIncomeFeed(db, { accountIds: [B], now: NOW })).toMatchObject({ categorized: 0, deleted: 1, unchanged: 4 });
    expect(await bankCategory(db, S.ledger["divVtiSep"]!)).toEqual({ categoryId: brokerage!.id, categoryLocked: false });
    expect(await bankCategory(db, S.ledger["divVxusSep"]!)).toEqual({ categoryId: S.categories.dividends, categoryLocked: false });
    expect(await bankCategory(db, S.ledger["divVtiMar"]!)).toEqual({ categoryId: S.categories.dividends, categoryLocked: true });
    // September in the plan: 4,150 (VXUS, by the household's rule) + 410 = 4,560.
    expect(await monthDividends(db, S, "2026-09")).toBe(4560n);
    expect(await runInvestmentIncomeFeed(db, { accountIds: [B], now: NOW })).toMatchObject({ categorized: 0, deleted: 0, unchanged: 4 });
  });
});
