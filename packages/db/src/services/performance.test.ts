import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFixed8 } from "@meridian/shared";
import { account, auditLog, balanceSnapshot, investmentTxn, job, lot, lotDisposal, price, transaction } from "../schema/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../test/db.js";
import { INV_SEED_NOW, INV_SEED_TODAY, seedInvestmentFixture, seedInvestmentLots, type InvestmentSeed } from "../test/investmentSeed.js";
import { getPerformance, loadExternalFlows, loadPerformanceInput } from "./performance.js";

const f8 = parseFixed8;

/**
 * Lots design TC27 (the external-flow loader) and the views design's performance figures
 * (§3.12, test 11) on the INV seed through `getPerformance`: B from its lots with the anchored
 * cash of the chain, R from the chain's points, the household total by Modified Dietz, the VTI
 * shadow portfolio. Rates are compared to 1e-6 as the views design asks; where the chain's
 * definition of R's end value (1,820,000 on 10-13, the Portfolio's number) differs from the
 * views design's carried statement (1,810,000), the chain's figure is asserted.
 */
describe.skipIf(!TEST_DATABASE_URL)("performance services (INV seed)", () => {
  let t: TestDb;
  let S: InvestmentSeed;
  let B: string;
  let R: string;
  let C: string;

  /** Row counts of every table a performance read could touch (the zero-writes assertion of TC26). */
  const tableCounts = async () => {
    const count = async (table: PgTable) => {
      const [row] = await t.db.select({ n: sql<number>`count(*)::int` }).from(table);
      return row!.n;
    };
    return Promise.all([investmentTxn, lot, lotDisposal, balanceSnapshot, price, auditLog, job, transaction].map(count));
  };

  beforeAll(async () => {
    t = await createTestDb();
    S = await seedInvestmentFixture(t.db);
    await seedInvestmentLots(t.db, S);
    B = S.accounts.brokerage;
    R = S.accounts.roth;
    C = S.accounts.checking;
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  it("loads external flows per decision 11: ledger transfers win over their investment twins, income and pending rows are not flows (TC27)", async () => {
    const [x] = await t.db.insert(account).values({ name: "X Brokerage", type: "brokerage", taxTreatment: "taxable", onBudget: false }).returning({ id: account.id });
    const X = x!.id;
    const p1 = randomUUID();
    try {
      await runTc27(X, p1);
    } finally {
      await t.db.delete(account).where(eq(account.id, X));
    }
  });

  const runTc27 = async (X: string, p1: string) => {
    const ledger = await t.db
      .insert(transaction)
      .values([
        { accountId: X, source: "manual", date: "2026-01-02", amountCents: 100000n, rawDescription: "TRANSFER FROM CHECKING", isTransfer: true, transferPairId: p1 },
        { accountId: C, source: "manual", date: "2026-01-02", amountCents: -100000n, rawDescription: "TRANSFER TO X", isTransfer: true, transferPairId: p1 },
        { accountId: X, source: "manual", date: "2026-01-15", amountCents: 5000n, rawDescription: "401K CONTRIBUTION", isTransfer: true },
        { accountId: X, source: "manual", date: "2026-01-20", amountCents: 4321n, rawDescription: "DIVIDEND" },
        { accountId: X, source: "manual", date: "2026-02-27", amountCents: 20000n, rawDescription: "TRANSFER (PENDING)", isTransfer: true, pending: true },
        { accountId: X, source: "manual", date: "2026-02-15", amountCents: 9000n, rawDescription: "EFT RECEIVED", isTransfer: true },
      ])
      .returning({ id: transaction.id, date: transaction.date, amountCents: transaction.amountCents });
    const ledgerId = (date: string, cents: bigint) => ledger.find((r) => r.date === date && r.amountCents === cents)!.id;
    const inv = await t.db
      .insert(investmentTxn)
      .values([
        { accountId: X, securityId: null, date: "2026-01-03", type: "transfer", transferDirection: "in", quantity: null, amountCents: 100000n, source: "csv" },
        { accountId: X, securityId: null, date: "2026-02-10", type: "transfer", transferDirection: "in", quantity: null, amountCents: 7000n, source: "csv" },
        // Linked to its bank row: the ledger row is the flow.
        { accountId: X, securityId: null, date: "2026-02-15", type: "transfer", transferDirection: "in", quantity: null, amountCents: 9000n, source: "csv", ledgerTransactionId: ledgerId("2026-02-15", 9000n) },
      ])
      .returning({ id: investmentTxn.id, date: investmentTxn.date });
    const invId = (date: string) => inv.find((r) => r.date === date)!.id;

    const flows = await loadExternalFlows(t.db, [X], "2026-01-01", "2026-02-28", { now: INV_SEED_NOW });
    expect(flows).toEqual([
      { date: "2026-01-02", amountCents: 100000n, kind: "cash", source: "ledger", accountId: X, counterpartyAccountId: C, pairId: p1, sourceId: ledgerId("2026-01-02", 100000n) },
      { date: "2026-01-15", amountCents: 5000n, kind: "cash", source: "ledger", accountId: X, counterpartyAccountId: null, pairId: null, sourceId: ledgerId("2026-01-15", 5000n) },
      { date: "2026-02-10", amountCents: 7000n, kind: "cash", source: "investment_txn", accountId: X, counterpartyAccountId: null, pairId: null, sourceId: invId("2026-02-10") },
      { date: "2026-02-15", amountCents: 9000n, kind: "cash", source: "ledger", accountId: X, counterpartyAccountId: null, pairId: null, sourceId: ledgerId("2026-02-15", 9000n) },
    ]);
    // The window is (from, to]: a flow dated `from` is excluded, one dated `to` is kept.
    expect((await loadExternalFlows(t.db, [X], "2026-01-02", "2026-01-15")).map((f) => f.date)).toEqual(["2026-01-15"]);

    // A securities transfer in is valued at market on its date (the row's own price, else the latest close: VTI 309.00 on 10-09).
    const [inKind] = await t.db
      .insert(investmentTxn)
      .values({ accountId: X, securityId: S.securities.vti, date: "2026-10-09", type: "transfer", transferDirection: "in", quantity: "2", price: null, amountCents: 0n, source: "manual" })
      .returning({ id: investmentTxn.id });
    try {
      const securitiesOnly = await loadExternalFlows(t.db, [X], "2026-10-01", "2026-10-13", { openingValues: false });
      expect(securitiesOnly).toEqual([{ date: "2026-10-09", amountCents: 61800n, kind: "securities", source: "investment_txn", accountId: X, counterpartyAccountId: null, pairId: null, sourceId: inKind!.id }]);
      // That trade makes X a full-history account the chain first values on 10-09 (2 VTI at 309 + the 121,000 of carried contributions): an opening value beside the securities flow.
      const october = await loadExternalFlows(t.db, [X], "2026-10-01", "2026-10-13", { now: INV_SEED_NOW });
      expect(october.map((f) => [f.date, f.kind, f.amountCents, f.source])).toEqual([
        ["2026-10-09", "opening_value", 182800n, "engine"],
        ["2026-10-09", "securities", 61800n, "investment_txn"],
      ]);
    } finally {
      await t.db.delete(investmentTxn).where(eq(investmentTxn.id, inKind!.id));
    }
  };

  it("adds the opening value of an account the chain first values inside the window", async () => {
    // R has no value before 2025-10-13: a window starting earlier sees it enter at its first reported balance.
    const flows = await loadExternalFlows(t.db, [R], "2025-10-01", "2025-10-31", { now: INV_SEED_NOW });
    expect(flows).toEqual([{ date: "2025-10-13", amountCents: 1500000n, kind: "opening_value", source: "engine", accountId: R, counterpartyAccountId: null, pairId: null, sourceId: null }]);
    expect(await loadExternalFlows(t.db, [R], "2025-10-13", "2026-10-13", { now: INV_SEED_NOW })).toEqual([]);
  });

  it("feeds the chain's points for the positions account and the lots service's build for the full-history account", async () => {
    const input = await loadPerformanceInput(t.db, { from: "2025-10-13", to: "2026-10-13", asOf: "2026-10-13", accountIds: [B, R], benchmarkSecurityId: S.securities.vti, now: INV_SEED_NOW });
    const byId = new Map(input.accounts.map((a) => [a.accountId, a]));
    const roth = byId.get(R)!;
    expect(roth).toMatchObject({ fidelity: "positions", lotMethod: "fifo", txns: [], lotPicks: [], cashAnchors: [], latestHoldingSnapshot: null });
    expect(roth.valuations).toEqual([
      { date: "2025-10-13", valueCents: 1500000n },
      { date: "2026-10-09", valueCents: 1810000n },
      { date: "2026-10-13", valueCents: 1820000n },
    ]);
    const brokerage = byId.get(B)!;
    expect(brokerage).toMatchObject({ fidelity: "full_history", valuations: [] });
    expect(brokerage.txns).toHaveLength(11);
    expect(brokerage.cashAnchors).toEqual([
      { date: "2025-10-13", balanceCents: 2000000n },
      { date: "2026-10-09", balanceCents: 2679200n },
      { date: "2026-10-12", balanceCents: 2673200n },
      { date: "2026-10-13", balanceCents: 2705200n },
    ]);
    expect(brokerage.cashFlows.map((f) => [f.date, f.amountCents, f.source])).toEqual([
      ["2024-02-28", 500000n, "ledger"],
      ["2024-06-07", 580000n, "ledger"],
      ["2025-01-14", 575000n, "ledger"],
      ["2026-04-13", 500000n, "ledger"],
    ]);
    expect(brokerage.latestHoldingSnapshot).toMatchObject({ date: "2026-10-13" });
    expect([...brokerage.latestHoldingSnapshot!.quantities.entries()].sort()).toEqual([[S.securities.aapl, f8("25")], [S.securities.vti, f8("40")], [S.securities.vxus, f8("100")]].sort());
    const stored = await t.db.select({ id: lot.id, openedByTxnId: lot.openedByTxnId }).from(lot).where(eq(lot.accountId, B));
    for (const l of stored) expect(brokerage.lotId!(l.openedByTxnId, 0)).toBe(l.id);
    expect(input.prices.map((p) => p.securityId).sort()).toEqual([S.securities.aapl, S.securities.vti, S.securities.vxus].sort());
    expect(input.prices.find((p) => p.securityId === S.securities.vti)!.points.map((p) => p.date)).toEqual(["2025-10-13", "2026-04-10", "2026-04-13", "2026-10-09", "2026-10-12", "2026-10-13"]);
    expect(input.benchmark).toMatchObject({ securityId: S.securities.vti, adjusted: true });
    expect(input.accountNames.get(C)).toBe("Checking");
    expect(input.securities.get(S.securities.vti)).toMatchObject({ ticker: "VTI", assetClass: "us_stock" });
  });

  it("computes the 1y performance of the views design: B by true TWR with anchored cash, R by Modified Dietz on the chain's points, the VTI shadow (views test 11)", async () => {
    const before = await tableCounts();
    const r = await getPerformance(t.db, { from: "2025-10-13", to: "2026-10-13", today: INV_SEED_TODAY, detail: "full", now: INV_SEED_NOW });
    expect(await tableCounts()).toEqual(before);
    expect(r).toMatchObject({ from: "2025-10-13", to: "2026-10-13", asOf: "2026-10-13", today: INV_SEED_TODAY, days: 365, detail: "full" });
    expect(r.accounts.map((a) => a.name)).toEqual(["Fidelity Roth IRA", "Vanguard Brokerage"]);
    const [roth, brokerage] = r.accounts;

    // B: V(2025-10-13) = 2,000,000; V(04-12) = 1,830,000 + 200,000 + 8,360 = 2,038,360; V(10-13) = 2,705,200.
    expect(brokerage).toMatchObject({ method: "true_twr", fidelity: "full_history", startValueCents: 2000000n, endValueCents: 2705200n, contributionsCents: 500000n, withdrawalsCents: 0n, netFlowsCents: 500000n, growthCents: 205200n, openingValue: null });
    expect(brokerage!.subPeriods.map((s) => [s.from, s.to, s.beginValueCents, s.flowCents, s.endValueCents])).toEqual([
      ["2025-10-13", "2026-04-12", 2000000n, 0n, 2038360n],
      ["2026-04-12", "2026-10-13", 2038360n, 500000n, 2705200n],
    ]);
    expect(brokerage!.twr.rate).toBeCloseTo(0.0861681306, 6);
    expect(brokerage!.twr.annualized).toBeCloseTo(0.0861681306, 6);
    expect(brokerage!.xirr.annualized).toBeCloseTo(0.0913942, 6);
    expect(brokerage!.xirr.investorFlows).toEqual([
      { date: "2025-10-13", amountCents: -2000000n },
      { date: "2026-04-13", amountCents: -500000n },
      { date: "2026-10-13", amountCents: 2705200n },
    ]);
    expect(brokerage!.flows).toHaveLength(1);
    expect(brokerage!.flows[0]).toMatchObject({ date: "2026-04-13", amountCents: 500000n, kind: "cash", source: "ledger", counterpartyAccountId: C, internal: false });
    expect(brokerage!.statementCheck).toMatchObject({ date: "2026-10-13", statementCents: 2705200n, securitiesCents: 2562000n, impliedCashCents: 143200n, trackedCashCents: 143200n, trackedFrom: "2026-10-12", differenceCents: 0n });
    expect(brokerage!.lots).toHaveLength(4);
    const storedLots = new Set((await t.db.select({ id: lot.id }).from(lot).where(eq(lot.accountId, B))).map((l) => l.id));
    for (const l of brokerage!.lots) expect(storedLots.has(l.id)).toBe(true);
    const holdings = new Map(brokerage!.holdings.map((h) => [h.securityId, h]));
    expect(holdings.get(S.securities.vti)).toMatchObject({ quantity: f8("40"), valueCents: 1250000n, costBasisCents: 1080000n, unrealizedCents: 170000n, lotCount: 2 });
    expect(holdings.get(S.securities.vxus)).toMatchObject({ quantity: f8("100"), valueCents: 712000n, costBasisCents: 580000n });
    expect(holdings.get(S.securities.aapl)).toMatchObject({ quantity: f8("25"), valueCents: 600000n, costBasisCents: 575000n });
    expect(holdings.get(null)).toMatchObject({ valueCents: 143200n, priceSource: "cash" });
    expect(brokerage!.income.reduce((acc, m) => acc + m.dividendCents + m.interestCents, 0n)).toBe(23200n);
    expect(brokerage!.warnings.filter((w) => w.code === "position_mismatch" || w.code === "statement_mismatch")).toEqual([]);
    expect(brokerage!.benchmark).toMatchObject({ securityId: S.securities.vti, adjusted: true, shadowValueCents: 2942639n, startPrice: f8("260"), endPrice: f8("312.5") });
    expect(brokerage!.benchmark!.twr.rate).toBeCloseTo(0.2019230769, 6);

    // R: points 1,500,000 (2025-10-13) → 1,810,000 (10-09) → 1,820,000 (10-13, the chain's repriced positions); no flows.
    expect(roth).toMatchObject({ method: "modified_dietz", fidelity: "positions", startValueCents: 1500000n, endValueCents: 1820000n, contributionsCents: 0n, netFlowsCents: 0n, growthCents: 320000n, openingValue: null, realized: null, gains: null, income: [], holdings: [], lots: [] });
    expect(roth!.subPeriods.map((s) => [s.from, s.to, s.beginValueCents, s.endValueCents, s.endCarried])).toEqual([
      ["2025-10-13", "2026-10-09", 1500000n, 1810000n, false],
      ["2026-10-09", "2026-10-13", 1810000n, 1820000n, false],
    ]);
    expect(roth!.twr.rate).toBeCloseTo(0.2133333, 6);
    expect(roth!.xirr.annualized).toBeCloseTo(0.2133333, 6);
    expect(roth!.benchmark).toMatchObject({ shadowValueCents: 1802885n });

    // Total: Modified Dietz over R's boundary; sub-period 1 as the views design (0.1304774289), sub-period 2 = 360 / 44,892.
    expect(r.total).toMatchObject({ method: "modified_dietz", startValueCents: 3500000n, endValueCents: 4525200n, contributionsCents: 500000n, growthCents: 525200n, partialGains: true, excludedInternalFlows: 0, accountIds: [R, B] });
    expect(r.total.subPeriods.map((s) => [s.from, s.to, s.beginValueCents, s.flowCents, s.endValueCents])).toEqual([
      ["2025-10-13", "2026-10-09", 3500000n, 500000n, 4489200n],
      ["2026-10-09", "2026-10-13", 4489200n, 0n, 4525200n],
    ]);
    expect(r.total.subPeriods[0]!.rate).toBeCloseTo(0.1304774289, 6);
    expect(r.total.twr.rate).toBeCloseTo(0.139543, 6);
    expect(r.total.xirr.annualized).toBeCloseTo(0.1403348, 6);
    expect(r.benchmark).toMatchObject({ securityId: S.securities.vti, adjusted: true, shadowValueCents: 4745524n });
    expect(r.benchmark!.twr.rate).toBeCloseTo(0.2019230769, 6);
    expect(r.total.gains).toMatchObject({ unrealizedCents: 327000n, realizedCents: 0n });
    expect(r.securities.get(S.securities.vti)).toMatchObject({ ticker: "VTI", name: "Vanguard Total Stock Market ETF" });
    expect(r.accountNames.get(C)).toBe("Checking");
  });

  it("prices the cash anchors that predate from, so the start value is the chain's and the statement check tracks from the previous anchor", async () => {
    // B's latest reported balance on or before 2026-04-12 is 2025-10-13 (2,000,000), and closes exist on 2026-04-10 between the two:
    // the plug must use the 2025-10-13 closes (2,000,000 − 1,800,000 = 200,000), not the buys' prices (which would give 345,000).
    // V(04-12) = 20 × 290 + 100 × 66 + 25 × 236 + 200,000 + dividends 8,360 = 2,038,360 (the valuation series' point on that date).
    const spring = await getPerformance(t.db, { from: "2026-04-12", to: "2026-10-13", today: INV_SEED_TODAY, accountIds: [B], benchmarkSecurityId: null, detail: "full", now: INV_SEED_NOW });
    const b = spring.accounts[0]!;
    expect(b).toMatchObject({ method: "true_twr", startValueCents: 2038360n, endValueCents: 2705200n, netFlowsCents: 500000n, growthCents: 166840n });
    expect(b.subPeriods.map((s) => [s.from, s.to, s.beginValueCents, s.flowCents, s.endValueCents])).toEqual([["2026-04-12", "2026-10-13", 2038360n, 500000n, 2705200n]]);
    // 2,705,200 / 2,538,360 − 1
    expect(b.twr.rate).toBeCloseTo(0.0657274776, 6);
    expect(b.warnings.some((w) => w.code === "price_from_txn")).toBe(false);

    // No anchor inside (10-09, 10-11]: the statement check runs on the 10-09 balance and tracks cash from the 2025-10-13 one,
    // whose securities (1,800,000) need the 2025-10-13 closes: implied 2,679,200 − 2,536,000 = 143,200 = 200,000 − 580,000 + 23,200 + 500,000.
    const quiet = await getPerformance(t.db, { from: "2026-10-09", to: "2026-10-11", today: INV_SEED_TODAY, accountIds: [B], benchmarkSecurityId: null, detail: "full", now: INV_SEED_NOW });
    const q = quiet.accounts[0]!;
    expect(q).toMatchObject({ startValueCents: 2679200n, endValueCents: 2679200n });
    expect(q.statementCheck).toMatchObject({ date: "2026-10-09", statementCents: 2679200n, securitiesCents: 2536000n, impliedCashCents: 143200n, trackedCashCents: 143200n, trackedFrom: "2025-10-13", differenceCents: 0n });
    expect(q.warnings.some((w) => w.code === "statement_mismatch")).toBe(false);
  });

  it("defaults: since inception, today, the household benchmark; summary detail empties the lists; validation", async () => {
    const r = await getPerformance(t.db, { today: INV_SEED_TODAY, now: INV_SEED_NOW });
    // The earliest data of B and R is B's 2024-02-28 contribution; `to` is today; asOf = to.
    expect(r).toMatchObject({ from: "2024-02-27", to: "2026-10-14", asOf: "2026-10-14", detail: "summary" });
    // The household benchmark (VTI) has no close on or before 2024-02-27: no benchmark, with the reason.
    expect(r.benchmark).toBeNull();
    expect(r.total.benchmark).toBeNull();
    expect(r.warnings.some((w) => w.code === "no_benchmark_price" && w.securityId === S.securities.vti)).toBe(true);
    for (const a of r.accounts) {
      expect(a.subPeriods).toEqual([]);
      expect(a.flows).toEqual([]);
      expect(a.lots).toEqual([]);
      expect(a.disposals).toEqual([]);
      expect(a.xirr.investorFlows).toEqual([]);
      if (a.benchmark) expect(a.benchmark.legs).toEqual([]);
    }
    expect(r.total.subPeriods).toEqual([]);
    const brokerage = r.accounts.find((a) => a.accountId === B)!;
    // Since inception B starts at 0; its holdings as of today are still priced with the 10-13 closes.
    expect(brokerage).toMatchObject({ startValueCents: 0n, endValueCents: 2705200n, method: "true_twr" });
    expect(brokerage.holdings.find((h) => h.securityId === S.securities.vti)).toMatchObject({ valueCents: 1250000n, priceDate: "2026-10-13" });

    const none = await getPerformance(t.db, { from: "2025-10-13", to: "2026-10-13", today: INV_SEED_TODAY, benchmarkSecurityId: null, accountIds: [R], now: INV_SEED_NOW });
    expect(none.benchmark).toBeNull();
    expect(none.accounts[0]!.benchmark).toBeNull();
    expect(none.total.accountIds).toEqual([R]);

    await expect(getPerformance(t.db, { from: "2026-10-13", to: "2026-10-13", today: INV_SEED_TODAY })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(getPerformance(t.db, { from: "2026-10-01", to: "2026-10-15", today: INV_SEED_TODAY })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(getPerformance(t.db, { from: "2026-10-01", to: "2026-10-13", asOf: "2026-10-15", today: INV_SEED_TODAY })).rejects.toMatchObject({ status: 400, code: "validation" });
    await expect(getPerformance(t.db, { from: "2026-10-01", to: "2026-10-13", today: INV_SEED_TODAY, accountIds: [C] })).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await expect(getPerformance(t.db, { from: "2026-10-01", to: "2026-10-13", today: INV_SEED_TODAY, benchmarkSecurityId: S.securities.cash })).rejects.toMatchObject({ status: 400, code: "validation" });
  });
});
