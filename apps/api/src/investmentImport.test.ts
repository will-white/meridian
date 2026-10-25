import { and, count, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, balanceSnapshot, holdingSnapshot, importLog, job, security } from "@meridian/db";
import { INV_SEED_TODAY } from "@meridian/db/testing";
import type {
  AccountView,
  ConnectionView,
  HoldingSnapshotView,
  InvestmentTxnList,
  LotsResponse,
  PositionsImportResult,
  PositionsPreviewResponse,
  RealizedGainsResponse,
  SecurityView,
  SetLotPicksResponse,
  TradesImportResult,
  TradesPreviewResponse,
} from "@meridian/shared";
import { TEST_DATABASE_URL } from "./test/helpers.js";
import { freshInvestmentApp, viewerCookies, type InvestmentApp } from "./test/investments.js";

/**
 * Positions and trade-history CSV imports (imports design §3.6–3.9, tests 7–9, 11, 13–14,
 * 27; plan decisions 5, 14, 17): preview without writes, commit with the import_log record,
 * idempotent re-import, the Bridge comparison on a SimpleFIN-fed account, snapshot
 * precedence, user edits surviving a re-import, and the lots, realized gains and lot picks
 * the trades produce. Numbers are hand-calculated under the engine's rules (FIFO by
 * acquisition date, basis consumed half-away, proceeds split by largest remainder).
 */

const TODAY = INV_SEED_TODAY;

const POSITIONS = [
  "Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total",
  'VTI,VANGUARD TOTAL STOCK MKT ETF,10.5,250.00,"$2,625.00","$2,100.00"',
  "VTI,VANGUARD TOTAL STOCK MKT ETF,2.25,250.00,$562.50,$500.00",
  "SPAXX**,FIDELITY GOVERNMENT MONEY MARKET,150.25,1.00,$150.25,--",
  "Pending Activity,,,,$12.34,",
  'Account Total,,,,"$3,350.09",',
].join("\n");

const BRIDGE_POSITIONS = [
  "Symbol,Description,Quantity,Last Price,Current Value",
  'VTI,Vanguard Total Stock,40,312.50,"$12,500.00"',
  'VXUS,Vanguard Intl,100,71.20,"$7,120.00"',
  'AAPL,Apple,25,240.00,"$6,000.00"',
  'CASH,Cash & Cash Investments,1432.00,1.00,"$1,432.00"',
].join("\n");

const TRADES_HEADER = "Date,Action,Symbol,Quantity,Price,Fee,Amount,Id";
const TRADE_ROWS = [
  "2026-10-01,YOU BOUGHT,VTI,10,250.00,,-2500.00,T1",
  "2026-10-01,YOU BOUGHT,VTI,10,250.00,,-2500.00,T2",
  "2026-09-15,DIVIDEND RECEIVED,VTI,,,,12.34,T3",
  "2026-09-15,REINVESTMENT,VTI,0.0523,,,-12.34,T4",
  "2026-10-05,YOU SOLD,VTI,-4,249.65,0,998.60,T5",
  "2026-10-02,YOU BOUGHT,ABC,5,48.123,4.95,,T6",
];
const TRADES = [TRADES_HEADER, ...TRADE_ROWS].join("\n");
const JOURNAL_ROW = "2026-10-06,JOURNALED SPP PURCHASE CREDIT (Cash),,,,,,T7";

describe.skipIf(!TEST_DATABASE_URL)("positions and trades CSV import routes", () => {
  let A: InvestmentApp;
  let X: string;
  let Y: string;
  let B: string;
  let positionsMapping: unknown;
  let tradesMapping: Record<string, unknown>;
  let tradesProfileId: string;

  beforeAll(async () => {
    A = await freshInvestmentApp({ lots: true });
    B = A.S.accounts.brokerage;
    const created = await A.t.call({ method: "POST", url: "/api/accounts", payload: { name: "Schwab", type: "brokerage" } });
    expect(created.statusCode).toBe(200);
    // Investment-type accounts start off-budget (plan decision 15; imports test 26).
    expect((created.json() as AccountView).onBudget).toBe(false);
    X = (created.json() as AccountView).id;
    const trades = await A.t.call({ method: "POST", url: "/api/accounts", payload: { name: "Schwab trades", type: "brokerage" } });
    expect(trades.statusCode).toBe(200);
    Y = (trades.json() as AccountView).id;
  });
  afterAll(async () => {
    await A?.t.cleanup();
  });

  const auditCount = async (): Promise<number> => (await A.t.db.db.select({ n: count() }).from(auditLog))[0]!.n;
  const securityCount = async (): Promise<number> => (await A.t.db.db.select({ n: count() }).from(security))[0]!.n;
  const latestLog = async (kind: "csv.positions" | "csv.trades") => (await A.t.db.db.select().from(importLog).where(eq(importLog.kind, kind)).orderBy(desc(importLog.startedAt)).limit(1))[0]!;
  const previewPositions = async (payload: Record<string, unknown>) => {
    const res = await A.t.call({ method: "POST", url: "/api/import/positions/preview", payload });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as PositionsPreviewResponse;
  };
  const commitPositions = async (payload: Record<string, unknown>) => A.t.call({ method: "POST", url: "/api/import/positions/commit", payload: { today: TODAY, ...payload } });
  const previewTrades = async (payload: Record<string, unknown>) => {
    const res = await A.t.call({ method: "POST", url: "/api/import/trades/preview", payload });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as TradesPreviewResponse;
  };
  const commitTrades = async (payload: Record<string, unknown>) => A.t.call({ method: "POST", url: "/api/import/trades/commit", payload: { today: TODAY, ...payload } });

  it("previews a positions file without creating anything", async () => {
    const noDate = await A.t.call({ method: "POST", url: "/api/import/positions/preview", payload: { csvText: POSITIONS, accountId: X } });
    expect(noDate.statusCode).toBe(400);
    expect(noDate.json().code).toBe("as_of_required");
    const empty = await A.t.call({ method: "POST", url: "/api/import/positions/preview", payload: { csvText: " ", accountId: X, asOfDate: "2026-10-13" } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe("empty_csv");

    const securities = await securityCount();
    const preview = await previewPositions({ csvText: POSITIONS, accountId: X, asOfDate: "2026-10-13" });
    expect(preview.mapping).toMatchObject({ hasHeader: true, asOf: { mode: "request" }, symbol: { column: "Symbol" }, quantity: { column: "Quantity" }, price: { column: "Last Price" }, value: { column: "Current Value" }, costBasis: { column: "Cost Basis Total" } });
    positionsMapping = preview.mapping;
    expect(preview.asOf).toBe("2026-10-13");
    // Two VTI sub-lots merge: 10.5 + 2.25 = 12.75 shares, 2 625.00 + 562.50; SPAXX's "--" cost is unreadable.
    expect(preview.positions).toHaveLength(2);
    const vti = preview.positions.find((p) => p.security.ticker === "VTI")!;
    expect(vti).toMatchObject({ quantity: "12.75", price: "250", valueCents: "318750", costBasisCents: "260000", existing: null, security: { id: A.S.securities.vti, matchedBy: "ticker", isNew: false, isCash: false, needsReview: false } });
    const spaxx = preview.positions.find((p) => p.security.ticker === "SPAXX")!;
    expect(spaxx).toMatchObject({ quantity: "150.25", price: "1", valueCents: "15025", costBasisCents: null, security: { id: null, matchedBy: "new", isNew: true, needsReview: true, isCash: false } });
    expect(spaxx.security.suggestion).toMatchObject({ ticker: "SPAXX", type: "fund" });
    expect(preview).toMatchObject({
      totalValueCents: "333775",
      knownBalanceCents: null,
      differenceCents: null,
      matchesToDollar: null,
      setBalanceDefault: true,
      pendingActivityCents: "1234",
      snapshotExists: false,
      existingSource: null,
      willReplace: true,
      rowsRead: 5,
      errors: [],
    });
    expect(preview.skipped.map((s) => s.reason)).toEqual(["pending_activity", "totals_row"]);
    expect(await securityCount()).toBe(securities);

    // A choice links the SPAXX row to an existing security for this preview.
    const chosen = await previewPositions({ csvText: POSITIONS, accountId: X, asOfDate: "2026-10-13", choices: [{ rowIndex: spaxx.rowIndex, security: { kind: "existing", securityId: A.S.securities.bnd } }] });
    expect(chosen.positions.find((p) => p.rowIndex === spaxx.rowIndex)!.security).toMatchObject({ id: A.S.securities.bnd, ticker: "BND", matchedBy: "choice", isNew: false });
    const checking = await A.t.call({ method: "POST", url: "/api/import/positions/preview", payload: { csvText: POSITIONS, accountId: A.S.accounts.checking, asOfDate: "2026-10-13" } });
    expect(checking.statusCode).toBe(400);
    expect(checking.json().code).toBe("not_investment_account");
  });

  it("commits positions once, idempotently, with the balance, the log row and a saved profile", async () => {
    const audits = await auditCount();
    const res = await commitPositions({ csvText: POSITIONS, accountId: X, mapping: positionsMapping, asOfDate: "2026-10-13", saveProfile: { name: "Fidelity" } });
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json() as PositionsImportResult;
    // SPAXX is created (needs review, implied-priced money market); VTI's 10-13 implied close loses to the provider row, SPAXX's 1.00 is written.
    expect(result).toMatchObject({ asOf: "2026-10-13", positions: 2, inserted: 2, updated: 0, unchanged: 0, deleted: 0, securitiesCreated: 1, impliedPrices: 1, totalValueCents: "333775", knownBalanceCents: null, differenceCents: null, matchesToDollar: null, balanceWritten: true, errors: [] });
    expect(await auditCount()).toBe(audits);

    const [balance] = await A.t.db.db.select().from(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, X), eq(balanceSnapshot.date, "2026-10-13")));
    expect(balance).toMatchObject({ balanceCents: 333775n, source: "csv" });
    const accounts = (await A.t.call({ method: "GET", url: "/api/accounts" })).json() as AccountView[];
    expect(accounts.find((a) => a.id === X)).toMatchObject({ balanceCents: "333775", balanceDate: "2026-10-13" });
    const log = await latestLog("csv.positions");
    expect(log).toMatchObject({ id: result.importLogId, status: "ok" });
    expect((log.rawPayload as { csvText: string }).csvText).toBe(POSITIONS);
    expect(log.stats).toMatchObject({ rowsRead: 5, rowsRejected: 0, rowsSkipped: 2, positions: 2, inserted: 2, securitiesCreated: 1, impliedPrices: 1, balanceWritten: 1 });
    expect(log.message).toBe("Snapshot 2026-10-13: 2 positions, $3337.75");
    const spaxx = ((await A.t.call({ method: "GET", url: "/api/investments/securities?q=SPAXX" })).json() as SecurityView[]).find((s) => s.ticker === "SPAXX")!;
    expect(spaxx).toMatchObject({ needsReview: true, priceMode: "implied", type: "fund", assetClass: "cash", held: true, latestPrice: { date: "2026-10-13", close: "1", source: "implied" } });
    const connections = (await A.t.call({ method: "GET", url: "/api/connections" })).json() as ConnectionView[];
    const profile = connections.find((c) => c.name === "Fidelity")!;
    expect(profile).toMatchObject({ type: "csv", csvKind: "positions", csvMapping: null, tradesMapping: null });
    expect(profile.positionsMapping).toMatchObject({ symbol: { column: "Symbol" } });
    expect(log.connectionId).toBe(profile.id);
    const valuation = await A.t.db.db.select().from(job).where(eq(job.type, "investments.valuation"));
    expect(valuation.map((j) => j.payload["accountId"])).toContain(X);
    expect((await A.t.db.db.select().from(job).where(eq(job.type, "prices.fetch"))).length).toBe(0);

    // The profile drives the next preview; the same file again changes nothing.
    const viaProfile = await previewPositions({ csvText: POSITIONS, accountId: X, profileId: profile.id, asOfDate: "2026-10-13" });
    expect(viaProfile).toMatchObject({ snapshotExists: true, existingSource: "csv", willReplace: true });
    expect(viaProfile.positions.find((p) => p.security.ticker === "VTI")!.existing).toEqual({ quantity: "12.75", valueCents: "318750" });
    const again = (await commitPositions({ csvText: POSITIONS, accountId: X, mapping: positionsMapping, asOfDate: "2026-10-13" })).json() as PositionsImportResult;
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 2, deleted: 0, securitiesCreated: 0 });
    expect(await auditCount()).toBe(audits);
    expect((await A.t.db.db.select({ n: count() }).from(importLog).where(eq(importLog.kind, "csv.positions")))[0]!.n).toBe(2);
    expect((await A.t.db.db.select({ n: count() }).from(holdingSnapshot).where(eq(holdingSnapshot.accountId, X)))[0]!.n).toBe(2);

    // A file with SPAXX only replaces the set: VTI's row goes, the balance follows.
    const only = ["Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total", "SPAXX**,FIDELITY GOVERNMENT MONEY MARKET,160.00,1.00,$160.00,--"].join("\n");
    const replaced = (await commitPositions({ csvText: only, accountId: X, mapping: positionsMapping, asOfDate: "2026-10-13" })).json() as PositionsImportResult;
    expect(replaced).toMatchObject({ positions: 1, inserted: 0, updated: 1, deleted: 1, totalValueCents: "16000", balanceWritten: true });
    expect(((await A.t.call({ method: "GET", url: "/api/accounts" })).json() as AccountView[]).find((a) => a.id === X)).toMatchObject({ balanceCents: "16000" });

    // With a snapshot on file, X cannot leave the investment types; a move between them is fine.
    const toChecking = await A.t.call({ method: "PATCH", url: `/api/accounts/${X}`, payload: { type: "checking" } });
    expect(toChecking.statusCode).toBe(409);
    expect(toChecking.json().code).toBe("account_has_investment_data");
    expect((await A.t.call({ method: "PATCH", url: `/api/accounts/${X}`, payload: { type: "ira" } })).json()).toMatchObject({ type: "ira", taxTreatment: "pre_tax" });
    expect((await A.t.call({ method: "PATCH", url: `/api/accounts/${X}`, payload: { type: "brokerage" } })).json()).toMatchObject({ type: "brokerage", taxTreatment: "taxable" });

    const future = await commitPositions({ csvText: POSITIONS, accountId: X, mapping: positionsMapping, asOfDate: "2026-10-15" });
    expect(future.statusCode).toBe(400);
    expect(future.json().code).toBe("future_date");
    expect((await latestLog("csv.positions")).status).toBe("error");
    const noRows = await commitPositions({ csvText: "Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total\nPending Activity,,,,$1.00,", accountId: X, mapping: positionsMapping, asOfDate: "2026-10-13" });
    expect(noRows.statusCode).toBe(400);
    expect(noRows.json().code).toBe("no_rows");
  });

  it("compares a SimpleFIN-fed account's file with the Bridge balance and honours snapshot precedence", async () => {
    const preview = await previewPositions({ csvText: BRIDGE_POSITIONS, accountId: B, asOfDate: "2026-10-13" });
    // 12 500 + 7 120 + 6 000 + 1 432 = 27 052.00, exactly the Bridge balance of 10-13.
    expect(preview).toMatchObject({ totalValueCents: "2705200", knownBalanceCents: "2705200", differenceCents: "0", matchesToDollar: true, setBalanceDefault: false, snapshotExists: true, existingSource: "simplefin", willReplace: true });
    expect(preview.positions.find((p) => p.security.ticker === "VTI")).toMatchObject({ existing: { quantity: "40", valueCents: "1250000" } });
    expect(preview.positions.find((p) => p.security.isCash)).toMatchObject({ quantity: "1432", valueCents: "143200", security: { id: A.S.securities.cash, matchedBy: "cash", isNew: false } });

    const commit = (await commitPositions({ csvText: BRIDGE_POSITIONS, accountId: B, mapping: preview.mapping, asOfDate: "2026-10-13" })).json() as PositionsImportResult;
    // The csv set outranks the simplefin set (source counts as a column), the cash row is new; the Bridge balance is left alone.
    expect(commit).toMatchObject({ positions: 4, inserted: 1, updated: 3, deleted: 0, knownBalanceCents: "2705200", differenceCents: "0", matchesToDollar: true, balanceWritten: false, securitiesCreated: 0 });
    const snapshot = (await A.t.call({ method: "GET", url: `/api/investments/accounts/${B}/snapshots/2026-10-13` })).json() as HoldingSnapshotView;
    expect(snapshot).toMatchObject({ source: "csv", totalValueCents: "2705200", knownBalanceCents: "2705200", differenceCents: "0", matchesToDollar: true });
    expect(snapshot.rows).toHaveLength(4);
    const [balance] = await A.t.db.db.select().from(balanceSnapshot).where(and(eq(balanceSnapshot.accountId, B), eq(balanceSnapshot.date, "2026-10-13")));
    expect(balance).toMatchObject({ balanceCents: 2705200n, source: "simplefin" });

    // A manual set on that date outranks any later csv commit.
    const manual = await A.t.call({ method: "PUT", url: `/api/investments/accounts/${B}/positions`, payload: { asOfDate: "2026-10-13", positions: [{ security: { kind: "existing", securityId: A.S.securities.vti }, quantity: "40", price: "312.5" }], today: TODAY } });
    expect(manual.statusCode).toBe(200);
    const refused = await commitPositions({ csvText: BRIDGE_POSITIONS, accountId: B, mapping: preview.mapping, asOfDate: "2026-10-13" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("snapshot_precedence");
    const log = await latestLog("csv.positions");
    expect(log.status).toBe("error");
    expect(log.message).toContain("manual");
  });

  it("previews trades with classification, resolution and duplicates, and blocks unknown actions", async () => {
    const preview = await previewTrades({ csvText: TRADES, accountId: Y });
    expect(preview.mapping).toMatchObject({ date: { column: "Date", format: "YYYY-MM-DD" }, action: { column: "Action" }, symbol: { column: "Symbol" }, quantity: { column: "Quantity" }, price: { column: "Price" }, amount: { column: "Amount" }, fee: { columns: ["Fee"] } });
    tradesMapping = { ...(preview.mapping as Record<string, unknown>), externalId: { column: "Id" } };
    const mapped = await previewTrades({ csvText: TRADES, accountId: Y, mapping: tradesMapping });
    expect(mapped.totalRows).toBe(6);
    expect(mapped).toMatchObject({ duplicateCount: 0, changedCount: 0, userEditedCount: 0, unknownActions: 0, errors: [], skipped: [] });
    expect(mapped.trades.map((t) => [t.date, t.sequence, t.type, t.externalId])).toEqual([
      ["2026-09-15", 0, "dividend", "csvid:T3"],
      ["2026-09-15", 1, "reinvest", "csvid:T4"],
      ["2026-10-01", 0, "buy", "csvid:T1"],
      ["2026-10-01", 1, "buy", "csvid:T2"],
      ["2026-10-02", 0, "buy", "csvid:T6"],
      ["2026-10-05", 0, "sell", "csvid:T5"],
    ]);
    const byId = new Map(mapped.trades.map((t) => [t.externalId, t]));
    expect(byId.get("csvid:T1")).toMatchObject({ quantity: "10", price: "250", amountCents: "-250000", feeCents: "0", derived: [], duplicate: false, security: { id: A.S.securities.vti, matchedBy: "ticker", isNew: false } });
    // The reinvest's price is implied: 12.34 / 0.0523 = 235.94646272.
    expect(byId.get("csvid:T4")).toMatchObject({ quantity: "0.0523", price: "235.94646272", amountCents: "-1234", derived: ["price"] });
    expect(byId.get("csvid:T3")).toMatchObject({ quantity: null, amountCents: "1234", ledgerMatch: null });
    // 5 × 48.123 = 240.615 → 24 062, plus 4.95 of fees: −24 557, amount derived; ABC is new.
    expect(byId.get("csvid:T6")).toMatchObject({ amountCents: "-24557", feeCents: "495", derived: ["amount"], security: { id: null, ticker: "ABC", matchedBy: "new", isNew: true } });
    expect(byId.get("csvid:T5")).toMatchObject({ quantity: "4", price: "249.65", amountCents: "99860" });
    expect(mapped.actionsFound.map((a) => [a.key, a.count, a.kind])).toEqual(
      expect.arrayContaining([
        ["you bought", 3, "buy"],
        ["dividend received", 1, "dividend"],
        ["reinvestment", 1, "reinvest"],
        ["you sold", 1, "sell"],
      ]),
    );

    const withJournal = [TRADES, JOURNAL_ROW].join("\n");
    const unknown = await previewTrades({ csvText: withJournal, accountId: Y, mapping: tradesMapping });
    expect(unknown.unknownActions).toBe(1);
    expect(unknown.actionsFound.find((a) => a.kind === null)).toMatchObject({ key: "journaled spp purchase credit (cash)", count: 1, fromProfile: false });
    const refused = await commitTrades({ csvText: withJournal, accountId: Y, mapping: tradesMapping });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("unknown_action");
    expect(refused.json().error).toContain("journaled spp purchase credit (cash)");
    expect((await latestLog("csv.trades")).status).toBe("error");
    const skipped = await previewTrades({ csvText: withJournal, accountId: Y, mapping: { ...tradesMapping, actionMap: { journaled: "skip" } } });
    expect(skipped.unknownActions).toBe(0);
    expect(skipped.skipped).toEqual([{ rowIndex: 7, reason: "skip", text: expect.stringContaining("JOURNALED") }]);
  });

  it("commits trades idempotently, keeps owner edits, and rebuilds lots, realized gains and picks", async () => {
    const res = await commitTrades({ csvText: TRADES, accountId: Y, mapping: { ...tradesMapping, actionMap: { journaled: "skip" } }, saveProfile: { name: "Fidelity trades" } });
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json() as TradesImportResult;
    expect(result).toMatchObject({ created: 6, updated: 0, unchanged: 0, skippedEdited: 0, linked: 0, ledgerCreated: 0, ledgerSkipped: 0, transfersPaired: 0, securitiesCreated: 1, lotsRebuilt: 1, warnings: [], errors: [] });
    const log = await latestLog("csv.trades");
    expect(log).toMatchObject({ id: result.importLogId, status: "ok" });
    expect(log.stats).toMatchObject({ rowsRead: 6, created: 6, securitiesCreated: 1, lotsRebuilt: 1 });
    const profile = ((await A.t.call({ method: "GET", url: "/api/connections" })).json() as ConnectionView[]).find((c) => c.name === "Fidelity trades")!;
    expect(profile).toMatchObject({ csvKind: "trades", csvMapping: null, positionsMapping: null });
    expect(profile.tradesMapping).toMatchObject({ actionMap: { journaled: "skip" }, externalId: { column: "Id" } });
    tradesProfileId = profile.id;
    expect((await A.t.db.db.select().from(job).where(eq(job.type, "investments.income_feed"))).length).toBeGreaterThanOrEqual(1);
    // The rebuilt lots are Y's value (a lots-basis account): the per-account valuation job is queued (plan decision 9), beside X's from the positions commit.
    const valuation = await A.t.db.db.select().from(job).where(eq(job.type, "investments.valuation"));
    expect(valuation.find((j) => j.payload["accountId"] === Y)).toMatchObject({ status: "queued", payload: { reason: "trades", accountId: Y, dedupeKey: `investments.valuation:${Y}` } });
    const txns = (await A.t.call({ method: "GET", url: `/api/investments/txns?accountId=${Y}` })).json() as InvestmentTxnList;
    expect(txns.items).toHaveLength(6);
    // Trades alone also pin the account to the investment types.
    const retyped = await A.t.call({ method: "PATCH", url: `/api/accounts/${Y}`, payload: { type: "savings" } });
    expect(retyped.statusCode).toBe(409);
    expect(retyped.json().code).toBe("account_has_investment_data");
    const sell = txns.items.find((t) => t.externalId === "csvid:T5")!;
    expect(sell).toMatchObject({ type: "sell", amountCents: "99860", source: "csv", userEdited: false });

    // A trades profile is not a positions profile.
    const wrongKind = await A.t.call({ method: "POST", url: "/api/import/positions/preview", payload: { csvText: POSITIONS, accountId: X, profileId: tradesProfileId, asOfDate: "2026-10-13" } });
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json().code).toBe("bad_profile");
    // The profile's own map marks its keys.
    const fromProfile = await previewTrades({ csvText: [TRADES, JOURNAL_ROW].join("\n"), accountId: Y, profileId: tradesProfileId });
    expect(fromProfile.actionsFound.find((a) => a.key.startsWith("journaled"))).toMatchObject({ kind: "skip", fromProfile: true });
    expect(fromProfile.duplicateCount).toBe(6);

    const again = (await commitTrades({ csvText: TRADES, accountId: Y, mapping: tradesMapping })).json() as TradesImportResult;
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 6, skippedEdited: 0, securitiesCreated: 0 });

    // The sale's amount changes in the file: the preview flags it, the commit updates that row only.
    const edited = [TRADES_HEADER, ...TRADE_ROWS.map((r) => r.replace("998.60", "998.75"))].join("\n");
    const changed = await previewTrades({ csvText: edited, accountId: Y, mapping: tradesMapping });
    expect(changed).toMatchObject({ duplicateCount: 6, changedCount: 1, userEditedCount: 0 });
    expect(changed.trades.find((t) => t.externalId === "csvid:T5")).toMatchObject({ duplicate: true, changed: true, amountCents: "99875" });
    const updated = (await commitTrades({ csvText: edited, accountId: Y, mapping: tradesMapping })).json() as TradesImportResult;
    expect(updated).toMatchObject({ created: 0, updated: 1, unchanged: 5 });
    expect((await A.t.call({ method: "GET", url: `/api/investments/txns/${sell.id}` })).json().amountCents).toBe("99875");

    // An owner edit of a source-owned column protects the row from the file.
    const patched = await A.t.call({ method: "PATCH", url: `/api/investments/txns/${sell.id}`, payload: { price: "249.70", today: TODAY } });
    expect(patched.json()).toMatchObject({ price: "249.7", userEdited: true });
    const protectedPreview = await previewTrades({ csvText: TRADES, accountId: Y, mapping: tradesMapping });
    expect(protectedPreview).toMatchObject({ duplicateCount: 6, userEditedCount: 1, changedCount: 0 });
    const third = (await commitTrades({ csvText: TRADES, accountId: Y, mapping: tradesMapping })).json() as TradesImportResult;
    expect(third).toMatchObject({ created: 0, updated: 0, unchanged: 5, skippedEdited: 1 });
    expect((await A.t.call({ method: "GET", url: `/api/investments/txns/${sell.id}` })).json()).toMatchObject({ price: "249.7", amountCents: "99875" });

    // Lots: the 09-15 reinvest lot (0.0523 @ 12.34) is consumed first under FIFO, then 3.9477 of the first 10-01 lot:
    // basis 250 000 × 3.9477 / 10 = 98 692.5 → 98 693, leaving 151 307 on 6.0523 shares.
    const lots = (await A.t.call({ method: "GET", url: `/api/investments/lots?accountId=${Y}&today=${TODAY}` })).json() as LotsResponse;
    expect(lots.accounts).toEqual([{ accountId: Y, fidelity: "full_history", lotMethod: "fifo", positionCheckDate: null, warnings: [] }]);
    const byTxn = new Map(lots.lots.map((l) => [txns.items.find((t) => t.id === l.openedByTxnId)!.externalId, l]));
    expect(byTxn.get("csvid:T1")).toMatchObject({ ticker: "VTI", originalQuantity: "10", quantity: "6.0523", originalCostBasisCents: "250000", costBasisCents: "151307", openedBy: "buy", acquiredDate: "2026-10-01" });
    expect(byTxn.get("csvid:T2")).toMatchObject({ quantity: "10", costBasisCents: "250000" });
    expect(byTxn.get("csvid:T6")).toMatchObject({ ticker: "ABC", quantity: "5", costBasisCents: "24557", valueCents: null, priceDate: null });
    expect(byTxn.has("csvid:T4")).toBe(false);
    const withClosed = (await A.t.call({ method: "GET", url: `/api/investments/lots?accountId=${Y}&includeClosed=true&today=${TODAY}` })).json() as LotsResponse;
    expect(withClosed.lots.find((l) => l.openedBy === "reinvest")).toMatchObject({ originalQuantity: "0.0523", quantity: "0", closedDate: "2026-10-05", originalCostBasisCents: "1234" });

    // Realized: proceeds 99 875 split 1 306 / 98 569 (largest remainder) against bases 1 234 and 98 693: gain −52, both short.
    const realized = (await A.t.call({ method: "GET", url: `/api/investments/realized?from=2026-10-01&to=2026-10-31&accountId=${Y}` })).json() as RealizedGainsResponse;
    expect(realized.summary.shortTerm).toEqual({ proceedsCents: "99875", basisCents: "99927", gainCents: "-52", count: 2 });
    expect(realized.summary.longTerm.count).toBe(0);
    expect(realized.disposals.map((d) => [d.quantity, d.proceedsCents, d.basisCents, d.gainCents, d.term]).sort()).toEqual([
      ["0.0523", "1306", "1234", "72", "short"],
      ["3.9477", "98569", "98693", "-124", "short"],
    ]);
    expect(realized.byAccount).toEqual([{ accountId: Y, name: "Schwab trades", summary: realized.summary }]);

    // Specific identification: pick the second lot for the whole sale; the basis is 4 × 25 000.
    const audits = await auditCount();
    const picks = await A.t.call({ method: "PUT", url: `/api/investments/txns/${sell.id}/lot-picks`, payload: { picks: [{ lotId: byTxn.get("csvid:T2")!.id, quantity: "4" }] } });
    expect(picks.statusCode, picks.body).toBe(200);
    expect(picks.json() as SetLotPicksResponse).toMatchObject({ picks: [{ sellTxnId: sell.id, lotId: byTxn.get("csvid:T2")!.id, quantity: "4", position: 0 }], warnings: [] });
    expect(await auditCount()).toBe(audits + 1);
    const picked = (await A.t.call({ method: "GET", url: `/api/investments/realized?from=2026-10-01&to=2026-10-31&accountId=${Y}` })).json() as RealizedGainsResponse;
    expect(picked.summary.shortTerm).toEqual({ proceedsCents: "99875", basisCents: "100000", gainCents: "-125", count: 1 });
    expect((await A.t.call({ method: "GET", url: `/api/investments/txns/${sell.id}` })).json().lotPicks).toHaveLength(1);
    const bad = async (payload: Record<string, unknown>, url = `/api/investments/txns/${sell.id}/lot-picks`) => {
      const r = await A.t.call({ method: "PUT", url, payload });
      expect(r.statusCode).toBe(400);
      return r.json().code as string;
    };
    expect(await bad({ picks: [{ lotId: byTxn.get("csvid:T6")!.id, quantity: "1" }] })).toBe("pick_security_mismatch");
    expect(await bad({ picks: [{ lotId: byTxn.get("csvid:T2")!.id, quantity: "5" }] })).toBe("picks_exceed_sale");
    expect(await bad({ picks: [{ lotId: "00000000-0000-4000-8000-000000000000", quantity: "1" }] })).toBe("lot_not_found");
    expect(await bad({ picks: [] }, `/api/investments/txns/${txns.items.find((t) => t.externalId === "csvid:T1")!.id}/lot-picks`)).toBe("not_a_sale");
    expect((await A.t.call({ method: "PUT", url: `/api/investments/txns/${sell.id}/lot-picks`, payload: { picks: [] } })).json().picks).toEqual([]);
    expect(await auditCount()).toBe(audits + 2);
    expect(((await A.t.call({ method: "GET", url: `/api/investments/realized?from=2026-10-01&to=2026-10-31&accountId=${Y}` })).json() as RealizedGainsResponse).summary.shortTerm.gainCents).toBe("-52");

    const rebuilt = await A.t.call({ method: "POST", url: "/api/investments/lots/rebuild", payload: { accountId: Y } });
    expect(rebuilt.json()).toEqual({ accounts: 1, lots: 4, disposals: 2, warnings: [] });
  });

  it("refuses imports to the viewer role", async () => {
    const cookies = await viewerCookies(A.t);
    const bodies: Array<[string, Record<string, unknown>]> = [
      ["/api/import/positions/preview", { csvText: POSITIONS, accountId: X, asOfDate: "2026-10-13" }],
      ["/api/import/positions/commit", { csvText: POSITIONS, accountId: X, mapping: positionsMapping, asOfDate: "2026-10-13" }],
      ["/api/import/trades/preview", { csvText: TRADES, accountId: Y }],
      ["/api/import/trades/commit", { csvText: TRADES, accountId: Y, mapping: tradesMapping }],
    ];
    for (const [url, payload] of bodies) {
      const res = await A.t.app.inject({ method: "POST", url, cookies, payload });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe("viewer");
    }
  });
});
