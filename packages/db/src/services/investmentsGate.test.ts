import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mapPositionsCsvRows, matchesToDollar, parseCsv, parseFixed8, type IsoDate } from "@meridian/shared";
import { accountReconciliation, balanceSnapshot, holdingSnapshot, price } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, seedInvestmentLots, type InvestmentSeed } from "../test/investmentSeed.js";
import { getDashboard } from "./dashboard.js";
import { rebuildImpliedPrices, replaceHoldingSnapshot, type SnapshotPosition } from "./holdings.js";
import { getHoldings } from "./investmentViews.js";
import { upsertPrices } from "./prices.js";
import { commitReconciliation, previewReconciliation } from "./reconcile.js";
import { cashSecurity, resolveSecurity } from "./securities.js";
import { valueAccountsOn } from "./valuation.js";

const f8 = parseFixed8;
const TODAY = INV_SEED_TODAY;
const NOW = INV_SEED_NOW;

/**
 * The Phase 3 gate (seams G4; plan step 13) on the INV seed, end to end through the services:
 * a positions CSV for the Roth IRA dated 10-12 → the snapshot and its implied price → a
 * fake-provider price fetch for 10-13 → the reconcile preview against the 10-13 statement
 * within $1 (not exact: the statement's fund NAV differs from the carried one) → the commit →
 * the post-commit value equals the statement exactly → the dashboard counts nothing awaiting.
 */
describe.skipIf(!TEST_DATABASE_URL)("investments gate (G4, INV seed)", () => {
  let t: TestDb;
  let S: InvestmentSeed;
  let R: string;
  let B: string;
  const ctx = () => ({ userId: null, batchId: randomUUID(), today: TODAY, now: NOW });

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
    await seedInvestmentLots(t.db, S);
    R = S.accounts.roth;
    B = S.accounts.brokerage;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("positions CSV → implied prices → fake-provider fetch → preview within $1 → commit → exact → awaitingReconcile 0", async () => {
    // 1. A Fidelity-style positions file for the Roth IRA as of 10-12.
    const csv = [
      "Symbol,Description,Quantity,Price,Current Value",
      "VTI,VANGUARD TOTAL STOCK MARKET ETF,20,310.00,6200.00",
      "BND,VANGUARD TOTAL BOND MARKET ETF,100,74.90,7490.00",
      ",Vanguard Target Retirement 2050 Trust,100,42.05,4205.00",
      "CASH,Cash,270.00,1.00,270.00",
    ].join("\n");
    const mapped = mapPositionsCsvRows(
      parseCsv(csv),
      { hasHeader: true, asOf: { mode: "request" }, symbol: { column: "Symbol" }, name: { column: "Description" }, quantity: { column: "Quantity" }, price: { column: "Price" }, value: { column: "Current Value" } },
      { asOfDate: "2026-10-12" },
    );
    expect(mapped.errors).toEqual([]);
    expect(mapped.positions).toHaveLength(4);
    const positions: SnapshotPosition[] = [];
    for (const p of mapped.positions) {
      const securityId = p.isCash ? (await cashSecurity(t.db)).row.id : (await resolveSecurity(t.db, { ticker: p.ticker, name: p.name }, { createIfMissing: false })).id;
      expect(securityId).not.toBeNull();
      positions.push({ securityId: securityId!, quantity: p.quantity, price: p.price, valueCents: p.valueCents, reportedCostBasisCents: p.costBasisCents });
    }
    const written = await t.db.transaction(async (tx) => {
      const result = await replaceHoldingSnapshot(tx, { accountId: R, date: "2026-10-12", source: "csv", positions, today: TODAY });
      const implied = await rebuildImpliedPrices(tx, { securityIds: result.securityIds, dates: ["2026-10-12"] });
      return { result, implied };
    });
    expect(written.result).toMatchObject({ inserted: 4, totalValueCents: 1816500n, balanceWritten: true, balanceCents: 1816500n, simplefinFed: false });
    // The fund's statement price became its implied close; the ETFs keep their provider closes.
    expect(written.implied.written).toBe(1);
    const [tr] = await t.db.select().from(price).where(and(eq(price.securityId, S.securities.tr2050), eq(price.date, "2026-10-12")));
    expect(tr).toMatchObject({ source: "implied", close: "42.05000000" });
    const [bal] = await t.db.select().from(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, R), eq(balanceSnapshot.date, "2026-10-12")));
    expect(bal).toMatchObject({ balanceCents: 1816500n, source: "csv" });

    // 2. The nightly fetch with a fake provider writes the 10-13 closes.
    await t.db.delete(price).where(and(eq(price.date, "2026-10-13"), inArray(price.securityId, [S.securities.vti, S.securities.bnd, S.securities.vxus, S.securities.aapl])));
    const fetched = await upsertPrices(
      t.db,
      [
        { securityId: S.securities.vti, date: "2026-10-13" as IsoDate, close: f8("312.5"), source: "provider", provider: "tiingo", adjClose: f8("312.5"), fetchedAt: NOW },
        { securityId: S.securities.bnd, date: "2026-10-13" as IsoDate, close: f8("74.8"), source: "provider", provider: "tiingo", adjClose: f8("74.8"), fetchedAt: NOW },
        { securityId: S.securities.vxus, date: "2026-10-13" as IsoDate, close: f8("71.2"), source: "provider", provider: "tiingo", adjClose: f8("71.2"), fetchedAt: NOW },
        { securityId: S.securities.aapl, date: "2026-10-13" as IsoDate, close: f8("240"), source: "provider", provider: "tiingo", adjClose: f8("240"), fetchedAt: NOW },
      ],
    );
    expect(fetched).toMatchObject({ inserted: 4, updated: 0, kept: 0 });
    const [valued] = await valueAccountsOn(t.db, { accountIds: [R], date: "2026-10-13", now: NOW });
    expect(valued).toMatchObject({ basis: "positions", asOf: "2026-10-12", valueCents: 1820500n, cashAnchor: "2026-10-12" });

    // 3. The 10-13 statement: the fund's NAV is 42.055, fifty cents above the carried value.
    const statement = {
      accountId: R,
      date: "2026-10-13" as IsoDate,
      rows: [
        { ticker: "VTI", quantity: f8("20"), price: f8("312.5") },
        { ticker: "BND", quantity: f8("100"), price: f8("74.8") },
        { securityId: S.securities.tr2050, quantity: f8("100"), valueCents: 420550n },
        { isCash: true, quantity: f8("270") },
      ],
    };
    const preview = await previewReconciliation(t.db, statement, { today: TODAY, now: NOW });
    expect(preview).toMatchObject({ statementTotalCents: 1820550n, differenceCents: -50n, matchesToDollar: true, unexplainedCents: 0n, alreadyReconciled: false });
    expect(matchesToDollar(preview.differenceCents!)).toBe(true);
    expect(preview.differenceCents).not.toBe(0n);
    expect(preview.rows.map((r) => [r.ticker ?? r.name, r.status, r.valueDiffCents])).toEqual([
      ["BND", "match", 0n],
      ["Vanguard Target Retirement 2050 Trust", "value", -50n],
      ["VTI", "match", 0n],
      ["Cash", "match", 0n],
    ]);
    expect(preview.balance).toEqual({ balanceCents: 1816500n, balanceDate: "2026-10-12", differenceCents: -4050n });

    // 4. Commit: the statement becomes the app's truth for 10-13.
    const commit = await commitReconciliation(t.db, { ...statement, accept: true }, ctx());
    expect(commit).toMatchObject({ accepted: true, preCommitDifferenceCents: -50n, matchesToDollar: true, rowsWritten: 4, impliedPricesWritten: 1 });
    expect(commit.app).toMatchObject({ basis: "snapshot", asOf: "2026-10-13", valueCents: 1820550n, balanceDiffCents: 0n });
    expect(commit.app.valueCents).toBe(1820550n);
    const [post] = await valueAccountsOn(t.db, { accountIds: [R], date: "2026-10-13", now: NOW });
    expect(post!.valueCents).toBe(1820550n);
    const [tr13] = await t.db.select().from(price).where(and(eq(price.securityId, S.securities.tr2050), eq(price.date, "2026-10-13")));
    expect(tr13).toMatchObject({ source: "implied", close: "42.05500000" });
    const rows = await t.db.select().from(holdingSnapshot).where(and(eq(holdingSnapshot.accountId, R), eq(holdingSnapshot.date, "2026-10-13")));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.source === "manual")).toBe(true);
    const [record] = await t.db.select().from(accountReconciliation).where(eq(accountReconciliation.accountId, R));
    expect(record).toMatchObject({ statementDate: "2026-10-13", diffCents: -50n, reconciled: true, accepted: true, holdingSnapshotDate: "2026-10-13", appBasis: "positions", appAsOf: "2026-10-12" });
    const again = await previewReconciliation(t.db, statement, { today: TODAY, now: NOW });
    expect(again).toMatchObject({ differenceCents: 0n, alreadyReconciled: true });

    // The views agree with the statement: the Holdings page's Roth lines are the statement's.
    const holdings = await getHoldings(t.db, { today: TODAY, now: NOW, accountId: R });
    expect(holdings).toMatchObject({ totalCents: 1820550n, holdingsCents: 1820550n, cashCents: 27000n, residualCents: 0n });

    // 5. The brokerage's statement is exact; the dashboard then has nothing awaiting a check.
    const b = await commitReconciliation(
      t.db,
      {
        accountId: B,
        date: "2026-10-13",
        rows: [
          { ticker: "VTI", quantity: f8("40"), price: f8("312.5") },
          { ticker: "VXUS", quantity: f8("100"), price: f8("71.2") },
          { ticker: "AAPL", quantity: f8("25"), price: f8("240") },
          { isCash: true, quantity: f8("1432") },
        ],
        accept: true,
      },
      ctx(),
    );
    expect(b).toMatchObject({ preCommitDifferenceCents: 0n, matchesToDollar: true });
    expect(b.app.valueCents).toBe(2705200n);
    const dashboard = await getDashboard(t.db, { today: TODAY, now: NOW });
    expect(dashboard.investments).toMatchObject({ asOf: "2026-10-13", totalCents: 2705200n + 1820550n, awaitingReconcile: 0, fidelityCounts: { balance_only: 0, positions: 1, full_history: 1 } });
    expect(dashboard.netWorth.breakdown).toMatchObject({ investmentsCents: 2705200n + 1820550n, investmentsAsOf: "2026-10-13" });
  });
});
