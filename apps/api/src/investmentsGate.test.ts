import type { InjectOptions } from "fastify";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AccountView,
  DashboardView,
  HoldingsView,
  IncomeView,
  LotsResponse,
  PerformanceView,
  PositionsImportResult,
  PositionsPreviewResponse,
  ReconcileCommitResponse,
  ReconcilePreviewResponse,
  SecurityView,
  TradesImportResult,
  TradesPreviewResponse,
  ValuationSummaryResponse,
  IsoDate,
} from "@meridian/shared";
import { createTestApp, TEST_DATABASE_URL, type TestApp } from "./test/helpers.js";
import { viewerCookies } from "./test/investments.js";

/**
 * Phase 3 gate (spec: "account values match brokerage statements to the dollar
 * on a chosen date"), played end to end through the HTTP API on a fresh household:
 *
 *   Oct 14  a brokerage account is created and its first statement (positions as
 *           of Oct 9) is imported from a CSV with the statement total: the
 *           account's value on Oct 9 equals the statement exactly.
 *           Closing prices for Oct 13 are entered; the Oct 13 statement is
 *           reconciled: within a dollar before the commit (one cent of rounding on
 *           one fund), exact after it.
 *   Oct 21  prices for Oct 20 and a dividend the statement already contains: the
 *           preview explains the whole difference on the cash row; the dividend is
 *           recorded; the statement is accepted and the value is exact again.
 *           The trade history is imported: the account becomes full history, the
 *           lots match the statement, cost basis and gains appear, the
 *           contribution is a ledger transfer, performance is computed, and the
 *           value still equals the statement. The dashboard agrees.
 *
 * Every statement total is hand-calculated from the quantities and prices in the
 * test (quantity × price rounded half away from zero at the cent).
 */

const STATEMENT_1 = ["Symbol,Description,Quantity,Last Price,Current Value", "VTI,VANGUARD TOTAL STOCK MARKET ETF,12.5,310.42,3880.25", "BND,VANGUARD TOTAL BOND MARKET ETF,40,74.915,2996.60", "VXUS,VANGUARD TOTAL INTL STOCK ETF,33.333,61.07,2035.65", "CASH,CASH,487.15,1.00,487.15"].join("\n");
const POSITIONS_MAPPING = { hasHeader: true, asOf: { mode: "request" }, symbol: { column: "Symbol" }, name: { column: "Description" }, quantity: { column: "Quantity" }, price: { column: "Last Price" }, value: { column: "Current Value" } };
/** 3880.25 + 2996.60 + 2035.65 + 487.15 */
const TOTAL_OCT_9 = "939965";
/** 12.5 × 312.10 + 40 × 74.80 + 33.333 × 61.50 (→ 2049.98) + 487.15 */
const APP_OCT_13 = "943038";
/** The brokerage rounds the VXUS line to 2049.97: one cent under the app. */
const TOTAL_OCT_13 = "943037";
/** 12.5 × 315 + 40 × 75.10 + 33.333 × 62 (→ 2066.65) + 487.15 */
const APP_OCT_20 = "949530";
/** The same positions plus the 12.40 dividend received on Oct 16 in cash. */
const TOTAL_OCT_20 = "950770";
const DIVIDEND = "1240";
const TRADES = [
  "Run Date,Action,Symbol,Description,Quantity,Price,Amount",
  "09/14/2026,ELECTRONIC FUNDS TRANSFER RECEIVED,,,,,9237.13",
  "09/15/2026,YOU BOUGHT,VTI,VANGUARD TOTAL STOCK MARKET ETF,12.5,300.00,-3750.00",
  "09/15/2026,YOU BOUGHT,BND,VANGUARD TOTAL BOND MARKET ETF,40,75.00,-3000.00",
  "09/15/2026,YOU BOUGHT,VXUS,VANGUARD TOTAL INTL STOCK ETF,33.333,60.00,-1999.98",
].join("\n");
const TRADES_MAPPING = { hasHeader: true, date: { column: "Run Date", format: "MM/DD/YYYY" }, action: { column: "Action" }, symbol: { column: "Symbol" }, name: { column: "Description" }, quantity: { column: "Quantity" }, price: { column: "Price" }, amount: { column: "Amount" } };
/** 9237.13 − 3750.00 − 3000.00 − 1999.98 = 487.15, the cash on the first statement. */
const CONTRIBUTION = "923713";

describe.skipIf(!TEST_DATABASE_URL)("Phase 3 gate: a brokerage account reconciles to its statements to the dollar", () => {
  let t: TestApp;
  let today: IsoDate = "2026-10-14";
  let now = new Date(`${today}T18:00:00Z`); // noon in Denver, before the US close: the expected price date is the day before
  const setClock = (date: IsoDate) => {
    today = date;
    now = new Date(`${date}T18:00:00Z`);
  };
  let accountId = "";
  const securityIds: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestApp({ now: () => now });
    await t.call({ method: "POST", url: "/api/auth/setup", payload: { username: "owner", password: "correct horse battery staple" } });
    const setup = await t.call({ method: "POST", url: "/api/auth/totp/setup" });
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.json().secret), digits: 6, period: 30 }).generate();
    await t.call({ method: "POST", url: "/api/auth/totp/confirm", payload: { code } });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  async function get<T>(url: string): Promise<T> {
    const res = await t.call({ method: "GET", url });
    expect(res.statusCode, `GET ${url}: ${res.body}`).toBe(200);
    return res.json() as T;
  }
  async function send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object): Promise<T> {
    const opts: InjectOptions = { method, url };
    if (payload !== undefined) opts.payload = payload;
    const res = await t.call(opts);
    expect([200, 201, 202], `${method} ${url}: ${res.statusCode} ${res.body}`).toContain(res.statusCode);
    return res.json() as T;
  }
  const account = async () => (await get<AccountView[]>("/api/accounts")).find((a) => a.id === accountId)!;
  const valueOn = async (asOf: IsoDate) => {
    const v = await get<ValuationSummaryResponse>(`/api/valuation/summary?asOf=${asOf}&accountIds=${accountId}&today=${today}`);
    const a = v.accounts.find((x) => x.accountId === accountId)!;
    return { total: v.totalCents, value: a.valueCents, basis: a.basis, fidelity: a.fidelity, asOf: a.asOf, lines: a.lines, balanceDiff: a.balanceDiffCents };
  };
  /** Rows as [ticker or "cash", status, value diff], in ticker order with cash last (the server's order). */
  const rowBrief = (p: ReconcilePreviewResponse) =>
    [...p.rows]
      .sort((a, b) => Number(a.isCash) - Number(b.isCash) || (a.ticker ?? "").localeCompare(b.ticker ?? ""))
      .map((r) => [r.isCash ? "cash" : r.ticker, r.status, r.valueDiffCents]);
  async function setPrices(date: IsoDate, closes: Record<string, string>) {
    for (const [ticker, close] of Object.entries(closes)) await send("PUT", `/api/prices/${securityIds[ticker]}/${date}`, { close, today });
  }

  it("creates the account off budget with no investment data yet", async () => {
    const created = await send<AccountView>("POST", "/api/accounts", { name: "Vanguard Brokerage", type: "brokerage" });
    accountId = created.id;
    expect(created).toMatchObject({ type: "brokerage", taxTreatment: "taxable", onBudget: false });
    expect(created.investment).toMatchObject({ fidelity: "balance_only", lastSnapshotDate: null, lastTradeDate: null, securityCount: 0, lastReconciliation: null });
  });

  it("imports the first statement: the value on its date equals the statement total exactly", async () => {
    const preview = await send<PositionsPreviewResponse>("POST", "/api/import/positions/preview", { csvText: STATEMENT_1, accountId, mapping: POSITIONS_MAPPING, asOfDate: "2026-10-09" });
    expect(preview.errors).toEqual([]);
    expect(preview.positions).toHaveLength(4);
    expect(preview.positions.map((p) => [p.security.ticker, p.quantity, p.price, p.valueCents])).toEqual([
      ["VTI", "12.5", "310.42", "388025"],
      ["BND", "40", "74.915", "299660"],
      ["VXUS", "33.333", "61.07", "203565"],
      [null, "487.15", "1", "48715"],
    ]);
    expect(preview.positions.map((p) => p.security.isCash)).toEqual([false, false, false, true]);
    expect(preview).toMatchObject({ asOf: "2026-10-09", totalValueCents: TOTAL_OCT_9, knownBalanceCents: null, matchesToDollar: null, snapshotExists: false });

    const result = await send<PositionsImportResult>("POST", "/api/import/positions/commit", {
      csvText: STATEMENT_1,
      accountId,
      mapping: POSITIONS_MAPPING,
      asOfDate: "2026-10-09",
      statementTotalCents: TOTAL_OCT_9,
      today,
    });
    expect(result).toMatchObject({ asOf: "2026-10-09", positions: 4, inserted: 4, totalValueCents: TOTAL_OCT_9, balanceWritten: true, errors: [] });
    expect(result.securitiesCreated).toBeGreaterThanOrEqual(3);

    for (const s of await get<SecurityView[]>("/api/investments/securities")) if (s.ticker) securityIds[s.ticker] = s.id;
    expect(Object.keys(securityIds).sort()).toEqual(["BND", "VTI", "VXUS"]);

    // The gate on the statement's own date: value = statement, to the cent.
    expect(await valueOn("2026-10-09")).toMatchObject({ total: TOTAL_OCT_9, value: TOTAL_OCT_9, basis: "snapshot", fidelity: "positions", asOf: "2026-10-09", balanceDiff: "0" });
    expect((await account()).investment).toMatchObject({ fidelity: "positions", lastSnapshotDate: "2026-10-09", lastSnapshotSource: "csv" });
  });

  it("reprices the positions with the next closes and reconciles the Oct 13 statement: within a dollar before, exact after", async () => {
    await setPrices("2026-10-13", { VTI: "312.1", BND: "74.8", VXUS: "61.5" });
    const repriced = await valueOn("2026-10-13");
    expect(repriced).toMatchObject({ value: APP_OCT_13, basis: "positions", asOf: "2026-10-09" });
    // No cash plug: the Oct 9 balance equals the Oct 9 positions, so the cash line is the statement's own 487.15.
    expect(repriced.lines.filter((l) => l.kind !== "position").map((l) => [l.kind, l.valueCents])).toEqual([["cash", "48715"]]);

    const statement = {
      accountId,
      date: "2026-10-13",
      statementTotalCents: TOTAL_OCT_13,
      rows: [
        { ticker: "VTI", quantity: "12.5", price: "312.1" },
        { ticker: "BND", quantity: "40", price: "74.8" },
        { ticker: "VXUS", quantity: "33.333", price: "61.5", valueCents: "204997" },
        { isCash: true, quantity: "487.15" },
      ],
      today,
    };
    const preview = await send<ReconcilePreviewResponse>("POST", "/api/reconcile/preview", statement);
    expect(preview).toMatchObject({ statementTotalCents: TOTAL_OCT_13, differenceCents: "1", unexplainedCents: "0", matchesToDollar: true, alreadyReconciled: false });
    expect(preview.app.valueCents).toBe(APP_OCT_13);
    expect(rowBrief(preview)).toEqual([
      ["BND", "match", "0"],
      ["VTI", "match", "0"],
      ["VXUS", "value", "1"],
      ["cash", "match", "0"],
    ]);

    const commit = await send<ReconcileCommitResponse>("POST", "/api/reconcile/commit", { ...statement, accept: true, note: "October 13 statement" });
    expect(commit).toMatchObject({ accepted: true, preCommitDifferenceCents: "1", matchesToDollar: true, rowsWritten: 4 });
    expect(commit.app.valueCents).toBe(TOTAL_OCT_13); // post-commit: exact
    expect(await valueOn("2026-10-13")).toMatchObject({ value: TOTAL_OCT_13, basis: "snapshot", asOf: "2026-10-13", balanceDiff: "0" });
    expect((await account()).investment?.lastReconciliation).toMatchObject({ statementDate: "2026-10-13", diffCents: "1", reconciled: true, accepted: true });
  });

  it("a week later: the preview explains a dividend on the cash row, the owner records it and accepts the statement", async () => {
    setClock("2026-10-21");
    await setPrices("2026-10-20", { VTI: "315", BND: "75.1", VXUS: "62" });
    expect(await valueOn("2026-10-20")).toMatchObject({ value: APP_OCT_20, basis: "positions", asOf: "2026-10-13" });

    const statement = {
      accountId,
      date: "2026-10-20",
      statementTotalCents: TOTAL_OCT_20,
      rows: [
        { ticker: "VTI", quantity: "12.5", price: "315" },
        { ticker: "BND", quantity: "40", price: "75.1" },
        { ticker: "VXUS", quantity: "33.333", price: "62" },
        { isCash: true, quantity: "499.55" },
      ],
      today,
    };
    const before = await send<ReconcilePreviewResponse>("POST", "/api/reconcile/preview", statement);
    expect(before).toMatchObject({ differenceCents: `-${DIVIDEND}`, unexplainedCents: "0", matchesToDollar: false });
    expect(before.rows.filter((r) => r.status !== "match").map((r) => [r.isCash, r.status, r.valueDiffCents])).toEqual([[true, "cash", `-${DIVIDEND}`]]);

    // Recording the dividend makes it income; the positions level still trusts the statement for cash.
    await send("POST", "/api/investments/txns", { type: "dividend", accountId, securityId: securityIds["VTI"], date: "2026-10-16", amountCents: DIVIDEND, today });
    const income = await get<IncomeView>(`/api/investments/income?period=1m&today=${today}`);
    expect(income.months.map((m) => [m.month, m.dividendsCents, m.interestCents])).toEqual([["2026-10", DIVIDEND, "0"]]);
    expect(income.totals.dividendsCents).toBe(DIVIDEND);

    const commit = await send<ReconcileCommitResponse>("POST", "/api/reconcile/commit", { ...statement, accept: true });
    expect(commit).toMatchObject({ accepted: true, preCommitDifferenceCents: `-${DIVIDEND}`, matchesToDollar: false });
    expect(commit.app.valueCents).toBe(TOTAL_OCT_20);
    expect(await valueOn("2026-10-20")).toMatchObject({ value: TOTAL_OCT_20, basis: "snapshot", asOf: "2026-10-20", balanceDiff: "0" });
  });

  it("the trade history makes the account full history without moving the statement value", async () => {
    const preview = await send<TradesPreviewResponse>("POST", "/api/import/trades/preview", { csvText: TRADES, accountId, mapping: TRADES_MAPPING });
    expect(preview.errors).toEqual([]);
    expect(preview.unknownActions).toBe(0);
    expect(preview.trades.map((r) => [r.kind, r.security?.ticker ?? null, r.quantity, r.amountCents])).toEqual([
      ["cash_in", null, null, CONTRIBUTION],
      ["buy", "VTI", "12.5", "-375000"],
      ["buy", "BND", "40", "-300000"],
      ["buy", "VXUS", "33.333", "-199998"],
    ]);
    const result = await send<TradesImportResult>("POST", "/api/import/trades/commit", { csvText: TRADES, accountId, mapping: TRADES_MAPPING, today });
    expect(result).toMatchObject({ created: 4, updated: 0, securitiesCreated: 0, ledgerCreated: 1, errors: [] });
    expect(result.lotsRebuilt).toBeGreaterThanOrEqual(1);

    // Lots agree with the statement, so the account is full history.
    expect((await account()).investment).toMatchObject({ fidelity: "full_history", positionsMatch: true, lastSnapshotDate: "2026-10-20" });
    const lots = await get<LotsResponse>(`/api/investments/lots?accountIds=${accountId}&today=${today}`);
    expect(lots.lots.map((l) => [l.ticker, l.openedBy, l.acquiredDate, l.quantity, l.costBasisCents, l.basisKnown]).sort()).toEqual([
      ["BND", "buy", "2026-09-15", "40", "300000", true],
      ["VTI", "buy", "2026-09-15", "12.5", "375000", true],
      ["VXUS", "buy", "2026-09-15", "33.333", "199998", true],
    ]);

    // Holdings carry cost basis and gains at the Oct 20 statement values.
    const holdings = await get<HoldingsView>(`/api/investments/holdings?today=${today}`);
    const rows = new Map(holdings.rows.map((r) => [r.ticker, r]));
    expect(rows.get("VTI")).toMatchObject({ quantity: "12.5", valueCents: "393750", costBasisCents: "375000", coverage: "full", gainCents: "18750" });
    expect(rows.get("BND")).toMatchObject({ quantity: "40", valueCents: "300400", costBasisCents: "300000", coverage: "full", gainCents: "400" });
    expect(rows.get("VXUS")).toMatchObject({ quantity: "33.333", valueCents: "206665", costBasisCents: "199998", coverage: "full", gainCents: "6667" });
    expect(holdings.totalCents).toBe(TOTAL_OCT_20);

    // The deposit is a ledger transfer (a contribution), never spending.
    const ledger = await get<{ items: Array<{ amountCents: string; isTransfer: boolean; accountId: string }> }>(`/api/transactions?accountId=${accountId}`);
    expect(ledger.items.map((r) => [r.amountCents, r.isTransfer])).toEqual([[CONTRIBUTION, true]]);

    // The statement value is unchanged by the history (the latest statement is newer than the last trade).
    expect(await valueOn("2026-10-20")).toMatchObject({ value: TOTAL_OCT_20, basis: "snapshot", fidelity: "full_history" });

    // Performance since inception: one contribution, growth = end − contribution, true TWR.
    const perf = await get<PerformanceView>(`/api/investments/performance?accountIds=${accountId}&period=all&today=${today}`);
    const a = perf.accounts.find((x) => x.accountId === accountId)!;
    expect(a.fidelity).toBe("full_history");
    const growth = (BigInt(TOTAL_OCT_20) - BigInt(CONTRIBUTION)).toString(); // 27057
    expect(a.block).toMatchObject({ method: "true_twr", startValueCents: "0", endValueCents: TOTAL_OCT_20, contributionsCents: CONTRIBUTION, withdrawalsCents: "0", netFlowsCents: CONTRIBUTION, growthCents: growth });
    expect(a.block.flows.map((f) => [f.date, f.amountCents, f.kind, f.source])).toEqual([["2026-09-14", CONTRIBUTION, "cash", "ledger"]]);
    // One sub-period from the deposit to the statement: TWR = 950770 / 923713 − 1 (period, not annualized under a year).
    expect(a.block.twr.rate).toBeCloseTo(950770 / 923713 - 1, 9);
    expect(a.block.twr.annualized).toBeNull();
    expect(perf.total).toMatchObject({ method: "true_twr", endValueCents: TOTAL_OCT_20, netFlowsCents: CONTRIBUTION, growthCents: growth });
  });

  it("the dashboard agrees and the viewer role can read but not reconcile", async () => {
    const dash = await get<DashboardView>(`/api/dashboard?today=${today}`);
    expect(dash.netWorth.breakdown?.investmentsCents).toBe(TOTAL_OCT_20);
    const needsReview = (await get<SecurityView[]>("/api/investments/securities")).filter((s) => s.needsReview).length;
    expect(dash.investments).toMatchObject({ totalCents: TOTAL_OCT_20, fidelityCounts: { balance_only: 0, positions: 0, full_history: 1 }, awaitingReconcile: 0, securitiesNeedingReview: needsReview });

    const cookies = await viewerCookies(t);
    const read = await t.app.inject({ method: "GET", url: `/api/investments/portfolio?today=${today}`, cookies });
    expect(read.statusCode).toBe(200);
    const write = await t.app.inject({ method: "POST", url: "/api/reconcile/commit", payload: { accountId, date: "2026-10-20", rows: [], statementTotalCents: TOTAL_OCT_20, today }, cookies });
    expect(write.statusCode).toBe(403);
    expect(write.json().code).toBe("viewer");
  });
});
