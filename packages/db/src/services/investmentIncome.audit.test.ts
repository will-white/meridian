import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { parseFixed8, type PlanCategoryRowResult } from "@meridian/shared";
import { balanceSnapshot, investmentTxn, job, transaction } from "../schema/index.js";
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
});
