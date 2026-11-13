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
  RealizedGainsResponse,
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
 * on a chosen date"), played end to end through the HTTP API on a fresh household.
 * Every statement is accepted only after the app's own value matched it to the
 * dollar; a difference is first explained and then closed with the information
 * that explains it, never by accepting the statement over it.
 *
 *   Oct 14  a brokerage account is created and its first statement (positions as
 *           of Oct 9) is imported from a CSV with the statement total: the
 *           account's value on Oct 9 equals the statement exactly.
 *           Closing prices for Oct 13 are entered; the Oct 13 statement is
 *           reconciled: within a dollar before the commit (one cent of rounding on
 *           one fund), exact after it.
 *   Oct 21  prices for Oct 20 and a dividend the statement already contains: the
 *           preview puts the whole 12.40 on the cash row. The owner records the
 *           dividend: it is income, but a positions-level account takes its cash
 *           from statements, so the second preview is still 12.40 short. The trade
 *           history is imported: the account becomes full history, its value comes
 *           from the lots and the cash they explain, and the third preview is one
 *           cent off (the cent of Oct 13). Only then is the statement accepted.
 *           Lots, cost basis, gains and performance appear; the contribution is a
 *           ledger transfer; the value still equals the statement.
 *   Oct 28  a sale, a buy and a withdrawal after the last statement, valued from
 *           the lots: the Oct 27 statement is 8.31 above the app, all on the cash
 *           row (a dividend not yet recorded); once it is recorded the preview is
 *           exact, to the cent, before anything is accepted. The dashboard agrees.
 *
 * A margin account (negative cash) plays the same gate in the second suite.
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
/**
 * Oct 20 from the lots, before the statement is accepted: 12.5 × 315 + 40 × 75.10 + 33.333 × 62
 * (→ 2066.65) = 9008.15 of securities; cash = the Oct 13 statement (9430.37) less the same
 * shares at the Oct 13 closes (3901.25 + 2992.00 + 2049.98 = 8943.23) = 487.14, plus the 12.40
 * dividend. One cent under the statement: the cent the brokerage rounded off VXUS on Oct 13.
 */
const LOTS_OCT_20 = "950769";
/**
 * After the Oct 20 statement: 2.5 VTI sold at 316.00 (+790.00) and 10 BND bought at 75.20
 * (−752.00) on Oct 22, a BND dividend of 8.31 on Oct 23, 300.00 withdrawn on Oct 26.
 * The Oct 27 statement by hand: 10 × 318 + 50 × 75.30 + 33.333 × 62.40 (→ 2079.98) = 9024.98,
 * cash 499.55 + 790.00 − 752.00 + 8.31 − 300.00 = 245.86, total 9270.84.
 */
const BND_DIVIDEND = "831";
const WITHDRAWAL = "30000";
const TOTAL_OCT_27 = "927084";
/** The same day before the BND dividend is recorded. */
const APP_OCT_27_BEFORE = "926253";
/** Oct 26 at that day's closes: 10 × 317 + 50 × 75.25 + 33.333 × 62.20 (→ 2073.31) + cash 245.86. */
const VALUE_OCT_26 = 925167;

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

  it("a week later: a dividend on the cash row is explained, recorded, and counted once the trade history is in; only then is the statement accepted", async () => {
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
    const preview = () => send<ReconcilePreviewResponse>("POST", "/api/reconcile/preview", statement);
    const first = await preview();
    expect(first).toMatchObject({ differenceCents: `-${DIVIDEND}`, unexplainedCents: "0", matchesToDollar: false });
    expect(first.rows.filter((r) => r.status !== "match").map((r) => [r.isCash, r.status, r.valueDiffCents])).toEqual([[true, "cash", `-${DIVIDEND}`]]);

    // Recording the dividend makes it income. A positions-level account takes its cash from statements, so its value does not move.
    await send("POST", "/api/investments/txns", { type: "dividend", accountId, securityId: securityIds["VTI"], date: "2026-10-16", amountCents: DIVIDEND, today });
    const income = await get<IncomeView>(`/api/investments/income?period=1m&today=${today}`);
    // A one-month period lists both months it touches, September at zero (audit b6-15).
    expect(income.months.map((m) => [m.month, m.dividendsCents, m.interestCents])).toEqual([
      ["2026-09", "0", "0"],
      ["2026-10", DIVIDEND, "0"],
    ]);
    expect(income.totals.dividendsCents).toBe(DIVIDEND);
    expect(await valueOn("2026-10-20")).toMatchObject({ value: APP_OCT_20, basis: "positions", fidelity: "positions" });
    const second = await preview();
    expect(second).toMatchObject({ differenceCents: `-${DIVIDEND}`, unexplainedCents: "0", matchesToDollar: false });

    // The trade history: the account is full history, and the lots explain the cash, dividend included.
    const trades = await send<TradesPreviewResponse>("POST", "/api/import/trades/preview", { csvText: TRADES, accountId, mapping: TRADES_MAPPING });
    expect(trades.errors).toEqual([]);
    expect(trades.unknownActions).toBe(0);
    expect(trades.trades.map((r) => [r.kind, r.security?.ticker ?? null, r.quantity, r.amountCents])).toEqual([
      ["cash_in", null, null, CONTRIBUTION],
      ["buy", "VTI", "12.5", "-375000"],
      ["buy", "BND", "40", "-300000"],
      ["buy", "VXUS", "33.333", "-199998"],
    ]);
    const result = await send<TradesImportResult>("POST", "/api/import/trades/commit", { csvText: TRADES, accountId, mapping: TRADES_MAPPING, today });
    expect(result).toMatchObject({ created: 4, updated: 0, securitiesCreated: 0, ledgerCreated: 1, errors: [] });
    expect(result.lotsRebuilt).toBeGreaterThanOrEqual(1);
    // Lots agree with the latest statement (Oct 13), so the account is full history.
    expect((await account()).investment).toMatchObject({ fidelity: "full_history", positionsMatch: true, lastSnapshotDate: "2026-10-13" });

    const fromLots = await valueOn("2026-10-20");
    expect(fromLots).toMatchObject({ value: LOTS_OCT_20, basis: "lots", fidelity: "full_history", asOf: "2026-10-16" });
    expect(fromLots.lines.filter((l) => l.kind !== "position").map((l) => [l.kind, l.valueCents])).toEqual([
      ["cash_plug", "48714"],
      ["cash", DIVIDEND],
    ]);
    const third = await preview();
    expect(third).toMatchObject({ differenceCents: "-1", unexplainedCents: "0", matchesToDollar: true });
    expect(third.app.valueCents).toBe(LOTS_OCT_20);
    expect(rowBrief(third)).toEqual([
      ["BND", "match", "0"],
      ["VTI", "match", "0"],
      ["VXUS", "match", "0"],
      ["cash", "cash", "-1"],
    ]);

    const commit = await send<ReconcileCommitResponse>("POST", "/api/reconcile/commit", { ...statement, accept: true });
    expect(commit).toMatchObject({ accepted: true, preCommitDifferenceCents: "-1", matchesToDollar: true });
    expect(commit.app.valueCents).toBe(TOTAL_OCT_20);
    expect(await valueOn("2026-10-20")).toMatchObject({ value: TOTAL_OCT_20, basis: "snapshot", asOf: "2026-10-20", balanceDiff: "0", fidelity: "full_history" });
  });

  it("the full history adds lots, cost basis, gains and performance without moving the statement value", async () => {
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

  it("after the last statement the value comes from the lots: a sale, a buy, a dividend and a withdrawal later, the next statement matches to the cent before it is accepted", async () => {
    setClock("2026-10-28");
    const txn = (body: object) => send("POST", "/api/investments/txns", { accountId, today, ...body });
    await txn({ type: "sell", date: "2026-10-22", securityId: securityIds["VTI"], quantity: "2.5", price: "316" });
    await txn({ type: "buy", date: "2026-10-22", securityId: securityIds["BND"], quantity: "10", price: "75.2" });
    await txn({ type: "transfer", direction: "out", date: "2026-10-26", amountCents: `-${WITHDRAWAL}` });
    await setPrices("2026-10-26", { VTI: "317", BND: "75.25", VXUS: "62.2" });
    await setPrices("2026-10-27", { VTI: "318", BND: "75.3", VXUS: "62.4" });

    // From the lots: the new quantities at the Oct 27 closes, the Oct 20 statement's cash, the trades' cash and the withdrawal.
    const before = await valueOn("2026-10-27");
    expect(before).toMatchObject({ value: APP_OCT_27_BEFORE, basis: "lots", fidelity: "full_history", asOf: "2026-10-22" });
    expect(before.lines.map((l) => [l.kind === "position" ? l.ticker : l.kind, l.valueCents]).sort()).toEqual([
      ["BND", "376500"], // 50 × 75.30
      ["VTI", "318000"], // 10 × 318
      ["VXUS", "207998"], // 33.333 × 62.40
      ["carried_flows", `-${WITHDRAWAL}`],
      ["cash", "3800"], // + 790.00 − 752.00
      ["cash_plug", "49955"], // the Oct 20 statement's cash
    ]);

    const statement = {
      accountId,
      date: "2026-10-27",
      statementTotalCents: TOTAL_OCT_27,
      rows: [
        { ticker: "VTI", quantity: "10", price: "318" },
        { ticker: "BND", quantity: "50", price: "75.3" },
        { ticker: "VXUS", quantity: "33.333", price: "62.4" },
        { isCash: true, quantity: "245.86" },
      ],
      today,
    };
    const first = await send<ReconcilePreviewResponse>("POST", "/api/reconcile/preview", statement);
    expect(first).toMatchObject({ differenceCents: `-${BND_DIVIDEND}`, unexplainedCents: "0", matchesToDollar: false });
    expect(rowBrief(first)).toEqual([
      ["BND", "match", "0"],
      ["VTI", "match", "0"],
      ["VXUS", "match", "0"],
      ["cash", "cash", `-${BND_DIVIDEND}`],
    ]);

    // The missing 8.31 is a dividend: once recorded, the app equals the statement to the cent, row for row.
    await txn({ type: "dividend", date: "2026-10-23", securityId: securityIds["BND"], amountCents: BND_DIVIDEND });
    expect(await valueOn("2026-10-27")).toMatchObject({ value: TOTAL_OCT_27, basis: "lots" });
    const second = await send<ReconcilePreviewResponse>("POST", "/api/reconcile/preview", statement);
    expect(second).toMatchObject({ statementTotalCents: TOTAL_OCT_27, differenceCents: "0", unexplainedCents: "0", matchesToDollar: true });
    expect(second.app.valueCents).toBe(TOTAL_OCT_27);
    expect(rowBrief(second)).toEqual([
      ["BND", "match", "0"],
      ["VTI", "match", "0"],
      ["VXUS", "match", "0"],
      ["cash", "match", "0"],
    ]);
    const commit = await send<ReconcileCommitResponse>("POST", "/api/reconcile/commit", { ...statement, accept: true });
    expect(commit).toMatchObject({ accepted: true, preCommitDifferenceCents: "0", matchesToDollar: true });
    expect(commit.app.valueCents).toBe(TOTAL_OCT_27);
    expect(await valueOn("2026-10-27")).toMatchObject({ value: TOTAL_OCT_27, basis: "snapshot", asOf: "2026-10-27", balanceDiff: "0" });

    // The sale realized 790.00 − 2.5 × 300.00 = 40.00; the holdings carry the rest of the basis.
    const holdings = await get<HoldingsView>(`/api/investments/holdings?today=${today}`);
    const rows = new Map(holdings.rows.map((r) => [r.ticker, r]));
    expect(rows.get("VTI")).toMatchObject({ quantity: "10", valueCents: "318000", costBasisCents: "300000", gainCents: "18000" });
    expect(rows.get("BND")).toMatchObject({ quantity: "50", valueCents: "376500", costBasisCents: "375200", gainCents: "1300" });
    expect(rows.get("VXUS")).toMatchObject({ quantity: "33.333", valueCents: "207998", costBasisCents: "199998", gainCents: "8000" });
    expect(holdings.totalCents).toBe(TOTAL_OCT_27);
    const realized = await get<RealizedGainsResponse>(`/api/investments/realized?accountId=${accountId}&from=2026-09-01&to=${today}`);
    expect(realized.summary.shortTerm).toEqual({ proceedsCents: "79000", basisCents: "75000", gainCents: "4000", count: 1 });

    // Performance: 9,237.13 in, 300.00 out, growth = 9,270.84 − 8,937.13; two sub-periods, split on the withdrawal's day.
    const perf = await get<PerformanceView>(`/api/investments/performance?accountIds=${accountId}&period=all&today=${today}`);
    const a = perf.accounts.find((x) => x.accountId === accountId)!;
    expect(a.block).toMatchObject({ method: "true_twr", startValueCents: "0", endValueCents: TOTAL_OCT_27, contributionsCents: CONTRIBUTION, withdrawalsCents: WITHDRAWAL, netFlowsCents: "893713", growthCents: "33371" });
    expect(a.block.flows.map((f) => [f.date, f.amountCents, f.kind, f.source])).toEqual([
      ["2026-09-14", CONTRIBUTION, "cash", "ledger"],
      ["2026-10-26", `-${WITHDRAWAL}`, "cash", "ledger"],
    ]);
    // (V(Oct 26) + 300.00) ÷ 9,237.13, then V(Oct 27) ÷ V(Oct 26).
    expect(a.block.twr.rate).toBeCloseTo(((VALUE_OCT_26 + 30000) / 923713) * (927084 / VALUE_OCT_26) - 1, 9);
    const income = await get<IncomeView>(`/api/investments/income?period=1m&today=${today}`);
    expect(income.totals.dividendsCents).toBe((BigInt(DIVIDEND) + BigInt(BND_DIVIDEND)).toString());
  });

  it("the dashboard agrees and the viewer role can read but not reconcile", async () => {
    const dash = await get<DashboardView>(`/api/dashboard?today=${today}`);
    expect(dash.netWorth.breakdown?.investmentsCents).toBe(TOTAL_OCT_27);
    const needsReview = (await get<SecurityView[]>("/api/investments/securities")).filter((s) => s.needsReview).length;
    expect(dash.investments).toMatchObject({ totalCents: TOTAL_OCT_27, fidelityCounts: { balance_only: 0, positions: 0, full_history: 1 }, awaitingReconcile: 0, securitiesNeedingReview: needsReview });

    const cookies = await viewerCookies(t);
    const read = await t.app.inject({ method: "GET", url: `/api/investments/portfolio?today=${today}`, cookies });
    expect(read.statusCode).toBe(200);
    const write = await t.app.inject({ method: "POST", url: "/api/reconcile/commit", payload: { accountId, date: "2026-10-27", rows: [], statementTotalCents: TOTAL_OCT_27, today }, cookies });
    expect(write.statusCode).toBe(403);
    expect(write.json().code).toBe("viewer");
  });
});

/**
 * The same gate for a margin account, where cash is negative: +10,000.00 on Sep 1, 50 VTI
 * bought at 300.00 on Sep 2 (cash −5,000.00), the Sep 30 statement (VTI 15,000.00, cash
 * −5,000.00, total 10,000.00), a close of 310.00 on Oct 6 and 10 shares sold that day
 * (+3,100.00). By hand on Oct 6: 40 × 310 − 1,900.00 = 10,500.00, on every page.
 */
describe.skipIf(!TEST_DATABASE_URL)("Phase 3 gate: a margin account keeps its debit on every basis", () => {
  let t: TestApp;
  const today: IsoDate = "2026-10-14";
  const now = new Date(`${today}T18:00:00Z`);
  let accountId = "";
  let vti = "";

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
  async function send<T>(method: "POST" | "PUT", url: string, payload: object): Promise<T> {
    const res = await t.call({ method, url, payload });
    expect([200, 201, 202], `${method} ${url}: ${res.statusCode} ${res.body}`).toContain(res.statusCode);
    return res.json() as T;
  }
  const valueOn = async (asOf: IsoDate) => {
    const v = await get<ValuationSummaryResponse>(`/api/valuation/summary?asOf=${asOf}&accountIds=${accountId}&today=${today}`);
    const a = v.accounts.find((x) => x.accountId === accountId)!;
    return { value: a.valueCents, basis: a.basis, balanceDiff: a.balanceDiffCents, lines: a.lines.map((l) => [l.kind, l.valueCents]), warnings: a.warnings };
  };

  it("the statement with a negative cash line is the value on its date, and the positions carry the debit after it", async () => {
    accountId = (await send<AccountView>("POST", "/api/accounts", { name: "Margin Brokerage", type: "brokerage" })).id;
    vti = (await send<SecurityView>("POST", "/api/investments/securities", { ticker: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", assetClass: "us_stock" })).id;
    const csvText = ["Symbol,Description,Quantity,Price,Value", "VTI,Vanguard Total Stock Market ETF,50,300,15000.00", "CASH,Cash,-5000.00,1,-5000.00"].join("\n");
    const mapping = { hasHeader: true, asOf: { mode: "request" }, symbol: { column: "Symbol" }, name: { column: "Description" }, quantity: { column: "Quantity" }, price: { column: "Price" }, value: { column: "Value" } };
    const result = await send<PositionsImportResult>("POST", "/api/import/positions/commit", { csvText, accountId, mapping, asOfDate: "2026-09-30", statementTotalCents: "1000000", today });
    expect(result).toMatchObject({ positions: 2, totalValueCents: "1000000", balanceWritten: true });
    expect(await valueOn("2026-09-30")).toMatchObject({ value: "1000000", basis: "snapshot", balanceDiff: "0", warnings: [] });
    // Oct 6 close 310.00: 50 × 310 − 5,000.00
    await send("PUT", `/api/prices/${vti}/2026-10-06`, { close: "310", today });
    expect(await valueOn("2026-10-06")).toMatchObject({ value: "1050000", basis: "positions" });
  });

  it("after the trade history and a sale newer than the statement, the lots basis, the Performance page, the Portfolio and the reconcile all say 10,500.00", async () => {
    const txn = (body: object) => send("POST", "/api/investments/txns", { accountId, today, ...body });
    await txn({ type: "transfer", direction: "in", date: "2026-09-01", amountCents: "1000000" });
    await txn({ type: "buy", date: "2026-09-02", securityId: vti, quantity: "50", price: "300" });
    await txn({ type: "sell", date: "2026-10-06", securityId: vti, quantity: "10", price: "310" });

    // 40 × 310 = 12,400.00; the Sep 30 balance less the 50 shares at 300.00 = −5,000.00; the sale's +3,100.00.
    expect(await valueOn("2026-10-06")).toEqual({
      value: "1050000",
      basis: "lots",
      balanceDiff: null,
      lines: [
        ["position", "1240000"],
        ["cash_plug", "-500000"],
        ["cash", "310000"],
      ],
      warnings: ["Holdings exceed the 2026-09-30 balance by $5000.00: the difference is counted as negative cash (a margin loan, or holdings that changed or lost value since the last statement; turn the account's cash inference off if the balance is not its total value)"],
    });

    const perf = await get<PerformanceView>(`/api/investments/performance?accountIds=${accountId}&from=2026-08-31&to=2026-10-06&today=${today}`);
    const a = perf.accounts.find((x) => x.accountId === accountId)!;
    expect(a.block).toMatchObject({ method: "true_twr", startValueCents: "0", endValueCents: "1050000", contributionsCents: "1000000", growthCents: "50000" });
    expect(a.block.twr.rate).toBeCloseTo(0.05, 9);

    const portfolio = await get<{ totalCents: string | null }>(`/api/investments/portfolio?asOf=2026-10-06&today=${today}`);
    expect(portfolio.totalCents).toBe("1050000");

    // The Oct 6 statement by hand: 40 shares at 310.00, cash −1,900.00, total 10,500.00.
    const preview = await send<ReconcilePreviewResponse>("POST", "/api/reconcile/preview", {
      accountId,
      date: "2026-10-06",
      statementTotalCents: "1050000",
      rows: [{ ticker: "VTI", quantity: "40", price: "310" }, { isCash: true, quantity: "-1900" }],
      today,
    });
    expect(preview).toMatchObject({ differenceCents: "0", matchesToDollar: true });
    expect(preview.rows.map((r) => [r.isCash ? "cash" : r.ticker, r.status, r.valueDiffCents])).toEqual([
      ["VTI", "match", "0"],
      ["cash", "match", "0"],
    ]);
  });
});
