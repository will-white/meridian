import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { IsoDate } from "@meridian/shared";
import { account, balanceSnapshot, connection, holdingSnapshot, investmentTxn, price, security, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, seedInvestmentLots, type InvestmentSeed } from "../test/investmentSeed.js";
import { loadCashFlowInput, projectForHousehold } from "./cashflow.js";
import { getDashboard } from "./dashboard.js";
import { getAllocation, getHoldings, getPortfolio } from "./investmentViews.js";
import { rebuildLotsForAccounts } from "./lots.js";
import { getPerformance } from "./performance.js";
import { pricesStatus } from "./prices.js";
import { valuationSeries, valueAccountsOn } from "./valuation.js";

/**
 * Audit batch b9-conformance-plan-investments: the service-level findings on the INV seed
 * (docs/audit/phases-1-3/b9-conformance-plan-investments.md). Hand figures in the comments.
 */

const q = { today: INV_SEED_TODAY, now: INV_SEED_NOW };

describe.skipIf(!TEST_DATABASE_URL)("audit b9: investments conformance", () => {
  let t: TestDb | undefined;
  afterEach(async () => {
    await t?.cleanup();
    t = undefined;
  });
  const fresh = async (lots = true): Promise<{ db: TestDb["db"]; S: InvestmentSeed }> => {
    t = await createTestDb();
    const S = await seedInvestmentFixture(t.db);
    if (lots) await seedInvestmentLots(t.db, S);
    return { db: t.db, S };
  };

  it("b9-08: without a price provider no account is 'behind'; with one, one trading day is singular", async () => {
    const { db, S } = await fresh();
    const R = S.accounts.roth;
    // BND's latest close is 10-12 (the 10-13 row removed); the expected close at INV_SEED_NOW is 10-13: one trading day.
    await db.delete(price).where(and(eq(price.securityId, S.securities.bnd), eq(price.date, "2026-10-13")));

    const withFeed = await getHoldings(db, q);
    expect(withFeed.rows.find((r) => r.ticker === "BND")).toMatchObject({ priceDate: "2026-10-12", priceStatus: "stale" });
    expect(withFeed.accountWarnings.filter((w) => w.kind === "price_stale" && w.accountId === R).map((w) => w.message)).toEqual(["Prices are 1 trading day behind (latest 10/12/26)"]);
    const feedStatus = await pricesStatus(db, { now: INV_SEED_NOW, provider: "tiingo" });
    expect(feedStatus.securities.find((s) => s.ticker === "BND")).toMatchObject({ priceStatus: "stale", tradingDaysBehind: 1, fetched: true });
    expect(feedStatus.counts.stale).toBe(1);

    // PRICE_PROVIDER=none: the same prices are the expected source, not a lag. Values are unchanged.
    const noFeed = await getHoldings(db, { ...q, priceFeed: false });
    expect(noFeed.totalCents).toBe(withFeed.totalCents);
    expect(noFeed.rows.find((r) => r.ticker === "BND")).toMatchObject({ priceDate: "2026-10-12", priceStatus: "implied", priceStale: false });
    expect(noFeed.accountWarnings.some((w) => w.kind === "price_stale")).toBe(false);
    expect((await getAllocation(db, { ...q, priceFeed: false })).accountWarnings.some((w) => w.kind === "price_stale")).toBe(false);
    const portfolio = await getPortfolio(db, { ...q, period: "1m", priceFeed: false });
    expect(portfolio.accounts.flatMap((a) => a.warnings).some((w) => w.kind === "price_stale")).toBe(false);
    const noFeedStatus = await pricesStatus(db, { now: INV_SEED_NOW, provider: null });
    expect(noFeedStatus.securities.find((s) => s.ticker === "BND")).toMatchObject({ priceStatus: "implied", tradingDaysBehind: 0 });
    expect(noFeedStatus.counts.stale).toBe(0);
    // A close on the expected date is current with or without a feed.
    expect(noFeedStatus.securities.find((s) => s.ticker === "VTI")).toMatchObject({ latestPriceDate: "2026-10-13", priceStatus: "current" });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("audit b9: the cash flow's opening balances", () => {
  let t: TestDb | undefined;
  afterEach(async () => {
    await t?.cleanup();
    t = undefined;
  });
  const today: IsoDate = "2026-11-13";

  it("b9-02: an account without a feed is rolled forward by the rows dated after its balance; a stale opening is named", async () => {
    t = await createTestDb();
    const db = t.db;
    const [conn] = await db.insert(connection).values({ type: "simplefin", name: "Bank" }).returning({ id: connection.id });
    const [cu, savings, bank, fresh] = await db
      .insert(account)
      .values([
        { name: "Credit Union Checking", type: "checking", taxTreatment: "none", balanceCents: 100000n, balanceDate: "2026-10-31", lowBalanceThresholdCents: 100000n },
        { name: "Savings", type: "savings", taxTreatment: "none", balanceCents: 500000n, balanceDate: "2026-09-15" },
        { name: "Bank Checking", type: "checking", taxTreatment: "none", connectionId: conn!.id, externalId: "b1", balanceCents: 300000n, balanceDate: "2026-11-10" },
        { name: "Bank Card", type: "credit", taxTreatment: "none", connectionId: conn!.id, externalId: "b2", balanceCents: -20000n, balanceDate: "2026-11-12" },
      ])
      .returning({ id: account.id });
    const row = (accountId: string, date: IsoDate, amountCents: bigint, pending = false) => ({ accountId, date, amountCents, rawDescription: "ROW", source: "csv" as const, pending });
    await db.insert(transaction).values([
      row(cu!.id, "2026-10-20", -7000n), // before the balance: inside it
      row(cu!.id, "2026-10-31", -1000n), // on the balance's day: inside it (a balance is the end of its day)
      row(cu!.id, "2026-11-02", -80000n),
      row(cu!.id, "2026-11-06", -15000n),
      row(cu!.id, "2026-11-14", -999n), // after today: not yet
      row(cu!.id, "2026-11-12", -500n, true), // pending: added as before
      row(bank!.id, "2026-11-12", -4000n), // a feed account's own balance is the bank's: never rolled forward
    ]);

    const load = await loadCashFlowInput(db, { today, horizonDays: 30 });
    const by = new Map(load.accounts.map((a) => [a.name, a]));
    // 1,000.00 − 800.00 − 150.00 (posted after 10-31, through today) − 5.00 pending = 45.00
    expect(by.get("Credit Union Checking")).toMatchObject({ openingCents: 4500n, balanceDate: "2026-10-31", rolledForwardCents: -95000n, rolledForwardRows: 2, dataThrough: "2026-11-06" });
    expect(by.get("Savings")).toMatchObject({ openingCents: 500000n, balanceDate: "2026-09-15", rolledForwardCents: 0n, rolledForwardRows: 0, dataThrough: "2026-09-15" });
    expect(by.get("Bank Checking")).toMatchObject({ openingCents: 300000n, balanceDate: "2026-11-10", rolledForwardCents: 0n, rolledForwardRows: 0, dataThrough: "2026-11-10" });
    expect(by.get("Bank Card")).toMatchObject({ openingCents: -20000n, dataThrough: "2026-11-12" });
    expect(fresh).toBeDefined();
    expect(load.warnings).toEqual([
      "Bank Checking: the projection starts from the bank's balance of 11/10/26; sync its connection for a newer one",
      "Credit Union Checking: the projection starts from the balance of 10/31/26 plus 2 transactions through 11/06/26; record a newer balance or import its transactions",
      "Savings: the projection starts from the balance of 09/15/26; record a newer balance or import its transactions",
    ]);

    // The projection and the dashboard read the same opening: Credit Union Checking is already below its 1,000.00 threshold.
    const projection = await projectForHousehold(db, { today, horizonDays: 30 });
    const cuSeries = projection.accounts.find((a) => a.name === "Credit Union Checking")!;
    expect(cuSeries).toMatchObject({ openingCents: 4500n, alreadyBelow: true, rolledForwardCents: -95000n, rolledForwardRows: 2, dataThrough: "2026-11-06" });
    const dash = await getDashboard(db, { today });
    expect(dash.cashFlow.balancesAsOf).toBe("2026-09-15");
    expect(dash.cashFlow.warnings).toEqual(expect.arrayContaining(load.warnings));

    // A newer balance recorded by hand replaces the roll-forward, and the warning goes.
    await db.update(account).set({ balanceCents: 4500n, balanceDate: "2026-11-12" }).where(eq(account.id, cu!.id));
    const after = await loadCashFlowInput(db, { today, horizonDays: 30 });
    expect(after.accounts.find((a) => a.id === cu!.id)).toMatchObject({ openingCents: 4000n, rolledForwardCents: 0n, rolledForwardRows: 0, dataThrough: "2026-11-12" });
    expect(after.warnings.some((w) => w.startsWith("Credit Union Checking"))).toBe(false);
    expect(savings).toBeDefined();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("audit b9: a full-history account before its first statement", () => {
  let t: TestDb | undefined;
  afterEach(async () => {
    await t?.cleanup();
    t = undefined;
  });
  const today: IsoDate = "2026-11-13";
  // 11:00 in New York on Fri 11-13: before the close, so the expected price date is Thu 11-12.
  const now = new Date("2026-11-13T16:00:00Z");

  /**
   * A brokerage with its whole trade history and no price row before its one statement:
   * 2025-10-01 +10,000.00 deposit, buy 20 VTI @ 250 (5,000.00) and 50 BND @ 70 (3,500.00);
   * 2026-06-01 sell 5 VTI @ 280 (+1,400.00); statement 2026-11-12: 15 VTI @ 300 = 4,500.00,
   * 50 BND @ 72 = 3,600.00, balance 11,000.00 (cash 10,000 − 5,000 − 3,500 + 1,400 = 2,900.00).
   */
  async function seed() {
    t = await createTestDb();
    const db = t.db;
    const [brk] = await db
      .insert(account)
      .values({ name: "Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false, balanceCents: 1_100_000n, balanceDate: "2026-11-12" })
      .returning({ id: account.id });
    const [vti, bnd] = await db
      .insert(security)
      .values([
        { ticker: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", assetClass: "us_stock", priceMode: "provider", needsReview: false },
        { ticker: "BND", name: "Vanguard Total Bond Market ETF", type: "etf", assetClass: "bonds", priceMode: "provider", needsReview: false },
      ])
      .returning({ id: security.id });
    const B = brk!.id;
    await db.insert(transaction).values({ accountId: B, date: "2025-10-01", amountCents: 1_000_000n, rawDescription: "EFT RECEIVED", source: "csv", isTransfer: true });
    const trade = (type: "buy" | "sell", securityId: string, date: IsoDate, quantity: string, priceValue: string, amountCents: bigint, seq: number) => ({
      accountId: B,
      securityId,
      date,
      sequence: seq,
      type,
      quantity,
      price: priceValue,
      amountCents,
      feeCents: 0n,
      source: "csv" as const,
      externalId: `csvid:B9-05-${seq}`,
      rawDescription: type === "buy" ? "YOU BOUGHT" : "YOU SOLD",
    });
    await db.insert(investmentTxn).values([
      trade("buy", vti!.id, "2025-10-01", "20", "250", -500_000n, 1),
      trade("buy", bnd!.id, "2025-10-01", "50", "70", -350_000n, 2),
      trade("sell", vti!.id, "2026-06-01", "5", "280", 140_000n, 3),
    ]);
    await db.insert(holdingSnapshot).values([
      { accountId: B, securityId: vti!.id, date: "2026-11-12", quantity: "15", price: "300", valueCents: 450_000n, source: "csv" },
      { accountId: B, securityId: bnd!.id, date: "2026-11-12", quantity: "50", price: "72", valueCents: 360_000n, source: "csv" },
    ]);
    await db.insert(balanceSnapshot).values({ accountId: B, date: "2026-11-12", balanceCents: 1_100_000n, source: "csv" });
    await db.insert(price).values([
      { securityId: vti!.id, date: "2026-11-12", close: "300", source: "implied" },
      { securityId: bnd!.id, date: "2026-11-12", close: "72", source: "implied" },
    ]);
    await db.transaction((tx) => rebuildLotsForAccounts(tx, [B]));
    return { db, B, vti: vti!.id, bnd: bnd!.id };
  }

  it("b9-05: the Portfolio values it from its trades' prices, as the Performance page does, instead of counting it as a flow", async () => {
    const { db, B, vti, bnd } = await seed();

    // The lots basis on 2026-10-13: 15 VTI at the 06-01 sale's 280 + 50 BND at the 10-01 buy's 70 + cash 2,900.00 = 10,600.00.
    const [oct] = await valueAccountsOn(db, { accountIds: [B], date: "2026-10-13", now });
    expect(oct).toMatchObject({ basis: "lots", valueCents: 1_060_000n, missing: [] });
    expect(oct!.lines.find((l) => l.securityId === vti)).toMatchObject({ priceSource: "txn", priceDate: "2026-06-01", valueCents: 420_000n });
    expect(oct!.lines.find((l) => l.securityId === bnd)).toMatchObject({ priceSource: "txn", priceDate: "2025-10-01", valueCents: 350_000n });

    // 1y to the expected price date: 2025-11-12 → 2026-11-12. Start 20 × 250 + 50 × 70 + 1,500.00 cash = 10,000.00; end the
    // statement's 11,000.00; no flow inside: growth 1,000.00. Before the fix the start was null and the 10,000.00 a flow.
    const portfolio = await getPortfolio(db, { today, now, period: "1y", priceFeed: false });
    expect(portfolio.asOf).toBe("2026-11-12");
    const brokerage = portfolio.accounts.find((a) => a.accountId === B)!;
    expect(brokerage.period).toMatchObject({ from: "2025-11-12", to: "2026-11-12", startCents: 1_000_000n, endCents: 1_100_000n, changeCents: 100_000n, netFlowsCents: 0n, growthCents: 100_000n });
    expect(portfolio.periodChange).toMatchObject({ startCents: 1_000_000n, netFlowsCents: 0n, growthCents: 100_000n });

    // The Performance page reads the same values on the same dates.
    const performance = await getPerformance(db, { from: "2025-11-12", to: "2026-11-12", today, now, accountIds: [B], benchmarkSecurityId: null });
    const perf = performance.accounts.find((a) => a.accountId === B)!;
    expect(perf.startValueCents).toBe(brokerage.period!.startCents);
    expect(perf.endValueCents).toBe(brokerage.period!.endCents);

    // The value line is drawn before the statement too, on the values the performance engine uses.
    const series = await valuationSeries(db, { from: "2026-10-12", to: "2026-10-14", today, now, accountIds: [B] });
    expect(series.portfolio.map((p) => p.valueCents)).toEqual([1_060_000n, 1_060_000n, 1_060_000n]);
  });
});
