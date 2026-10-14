import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AccountChangesView,
  AccountInvestmentView,
  AccountValuationView,
  AccountView,
  AllocationTargetsView,
  AllocationView,
  AsOfQuery,
  AuthStatus,
  ConnectionView,
  CreateInvestmentTxnBody,
  CreateSecurityBody,
  DashboardView,
  HoldingSnapshotView,
  HoldingsView,
  HouseholdSettingView,
  IncomeView,
  InvestmentPeriodQuery,
  InvestmentTxnView,
  LineValuationView,
  LotView,
  LotsResponse,
  ManualPositionInput,
  ManualPositionsBody,
  MappedTradeView,
  PerformanceQuery,
  PerformanceRequestBody,
  PerformanceResponse,
  PerformanceView,
  PortfolioView,
  PositiveFixed8String,
  PositionsCommitBody,
  PositionsCsvMapping,
  PositionsPreviewBody,
  PositionsPreviewResponse,
  PriceView,
  PricesStatusResponse,
  QueryUuidList,
  RealizedGainsResponse,
  ReconcileCommitBody,
  ReconcileCommitResponse,
  ReconcilePreviewBody,
  ReconcilePreviewResponse,
  ReconcileRowBody,
  ReconciliationView,
  ResolveSecurityResponse,
  SecurityView,
  SetAllocationTargetsBody,
  SetLotPicksBody,
  SetPriceBody,
  SetSecurityAllocationBody,
  TradeKind,
  TradesCsvMapping,
  UpdateAccountBody,
  UpdateHouseholdSettingBody,
  UpdateSecurityPricingBody,
  ValuationSeriesResponse,
  ValuationSummaryQuery,
  ValuationSummaryResponse,
} from "./api.js";
import { Fixed8String, NonNegFixed8String } from "./decimal.js";

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const U3 = "00000000-0000-4000-8000-000000000003";

const ok = (schema: z.ZodTypeAny, value: unknown) => expect(schema.safeParse(value).success, JSON.stringify(schema.safeParse(value))).toBe(true);
const bad = (schema: z.ZodTypeAny, value: unknown) => expect(schema.safeParse(value).success).toBe(false);
/** A contract with no defaults or transforms parses its own example back unchanged. */
const roundTrip = (schema: z.ZodTypeAny, value: unknown) => expect(schema.parse(value)).toEqual(value);

// ---- Shared fixtures ----
const returnFigure = { rate: 0.0861681306, annualized: 0.0861681306, reason: null, reasonDate: null };
const failedFigure = { rate: null, annualized: null, reason: "no_valuations", reasonDate: "2026-10-13" };
const xirr = { annualized: 0.0913942, period: null, investedDays: 365, reason: null, warnings: [], investorFlows: [{ date: "2025-10-13", amountCents: "-200000000" }] };
const flow = {
  date: "2026-04-13",
  amountCents: "50000000",
  kind: "cash",
  source: "ledger",
  accountId: U1,
  counterpartyAccountId: U2,
  counterpartyAccountName: "Checking",
  internal: false,
  internalReason: null,
  sourceId: U3,
};
const warning = { code: "position_mismatch", accountId: U1, securityId: U2, ticker: "VTI", date: "2026-10-13", lotsQuantity: "20", snapshotQuantity: "40" };
const accountRef = { accountId: U1, accountName: "Brokerage", type: "brokerage", taxTreatment: "taxable", fidelity: "full_history", fidelityNote: null };
const securityRef = { securityId: U2, ticker: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", assetClass: "us_stock", splits: [], needsReview: false };
const changeSummary = {
  from: "2025-10-13",
  to: "2026-10-13",
  startCents: "350000000",
  endCents: "452520000",
  changeCents: "102520000",
  changeBp: 2929,
  netFlowsCents: "50000000",
  growthCents: "52520000",
  growthReason: null,
  incomeCents: "3243500",
  uncategorizedRows: 1,
};
const performanceBlock = {
  method: "true_twr",
  startValueCents: "200000000",
  endValueCents: "270520000",
  openingValue: null,
  contributionsCents: "50000000",
  withdrawalsCents: "0",
  netFlowsCents: "50000000",
  growthCents: "20520000",
  twr: returnFigure,
  xirr,
  benchmark: null,
  subPeriods: [],
  flows: [flow],
  realized: null,
  gains: null,
  income: [{ month: "2026-09", securityId: U2, ticker: "VTI", dividendCents: "415000", interestCents: "0", feeCents: "0", reinvestedCents: "0" }],
  warnings: [warning],
};
const lot = {
  id: U3,
  openedByTxnId: U1,
  ordinal: 0,
  originLotId: null,
  accountId: U1,
  accountName: "Brokerage",
  securityId: U2,
  ticker: "VTI",
  securityName: "Vanguard Total Stock Market ETF",
  openedBy: "buy",
  acquiredDate: "2025-10-13",
  originalQuantity: "20",
  quantity: "20",
  originalCostBasisCents: "580000",
  costBasisCents: "580000",
  basisPerShare: "290",
  basisKnown: true,
  closedDate: null,
  priceDate: "2026-10-13",
  valueCents: "625000",
  unrealizedCents: "45000",
  term: "long",
};
const disposal = {
  accountId: U1,
  accountName: "Brokerage",
  securityId: U2,
  ticker: "VTI",
  closeTxnId: U3,
  lotId: null,
  kind: "unmatched_sell",
  date: "2026-10-09",
  acquiredDate: null,
  quantity: "4",
  proceedsCents: "51998",
  basisCents: null,
  gainCents: null,
  term: "unknown",
  basisKnown: false,
};
const gainTotals = { proceedsCents: "51998", basisCents: "52000", gainCents: "-2", count: 1 };
const realizedSummary = {
  shortTerm: gainTotals,
  longTerm: { proceedsCents: "0", basisCents: "0", gainCents: "0", count: 0 },
  unknownBasis: { proceedsCents: "0", quantity: "0", count: 0 },
  transfersOut: { quantity: "0", basisCents: "0" },
  washSalesApplied: false,
};
const line = {
  securityId: null,
  ticker: null,
  name: "Cash (from balance)",
  kind: "cash_plug",
  quantity: null,
  price: null,
  priceDate: null,
  priceSource: null,
  priceStatus: "cash",
  tradingDaysBehind: 0,
  valueCents: "123456",
  valueSource: "carried",
};
const positionLine = {
  securityId: U2,
  ticker: "VTI",
  name: "Vanguard Total Stock Market ETF",
  kind: "position",
  quantity: "100",
  price: "305.25",
  priceDate: "2026-10-13",
  priceSource: "provider",
  priceStatus: "current",
  tradingDaysBehind: 0,
  valueCents: "3052500",
  valueSource: "priced",
};
const dayChange = { cents: "38038", asOf: "2026-10-13", prior: "2026-10-12", reason: null };
const lastReconciliation = { id: U3, statementDate: "2026-10-13", diffCents: "0", reconciled: true, accepted: true, createdAt: "2026-10-13T20:00:00.000Z" };
const accountValuation = {
  accountId: U1,
  name: "Brokerage",
  type: "brokerage",
  taxTreatment: "taxable",
  fidelity: "positions",
  cashInference: "auto",
  date: "2026-10-13",
  basis: "snapshot",
  asOf: "2026-10-13",
  valueCents: "5807669",
  priceStatus: "current",
  stalest: null,
  missing: [],
  balanceDiffCents: "0",
  cashAnchor: "2026-10-13",
  lines: [positionLine, line],
  dayChange,
  lastReconciliation,
  warnings: [],
};
const securityView = {
  id: U2,
  ticker: "VTI",
  name: "Vanguard Total Stock Market ETF",
  type: "etf",
  assetClass: "us_stock",
  expenseRatioPpm: 300,
  cusip: "922908769",
  isin: null,
  currency: "USD",
  priceMode: "provider",
  providerSymbol: null,
  alwaysPrice: false,
  needsReview: false,
  archived: false,
  notes: null,
  aliases: [{ kind: "name", value: "vanguard total stock mkt etf" }],
  held: true,
  heldInAccounts: 2,
  latestPrice: { date: "2026-10-13", close: "305.25", source: "provider" },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
};
const previewRef = { id: U2, ticker: "VTI", name: "Vanguard Total Stock Market ETF", matchedBy: "ticker", isNew: false, needsReview: false, isCash: false, suggestion: null };
const positionsMapping = { asOf: { mode: "request" }, symbol: { column: "Symbol" }, quantity: { column: "Quantity" }, price: { column: "Last Price" }, value: { column: "Current Value" } };
const tradesMapping = { date: { column: "Run Date", format: "MM/DD/YYYY" }, action: { column: "Action" }, symbol: { column: "Symbol" }, quantity: { column: "Quantity" }, amount: { column: "Amount ($)" } };

describe("Fixed8String (numeric(20,8) on the wire)", () => {
  it("accepts up to 12 integer and 8 fraction digits, with a sign", () => {
    for (const s of ["0", "12.5", "-0.00000001", "123456789012.12345678", "1.1"]) ok(Fixed8String, s);
    ok(NonNegFixed8String, "12.50000000");
  });
  it("refuses 9 decimals, a 13-digit integer part, exponents and blanks", () => {
    bad(Fixed8String, "1.123456789");
    bad(Fixed8String, "1234567890123");
    bad(Fixed8String, "1234567890123.1");
    bad(Fixed8String, "1e5");
    bad(Fixed8String, "");
    bad(Fixed8String, " 1");
    bad(Fixed8String, "1.");
    bad(NonNegFixed8String, "-1");
  });
  it("PositiveFixed8String refuses zero in any spelling", () => {
    bad(PositiveFixed8String, "0");
    bad(PositiveFixed8String, "0.00000000");
    bad(PositiveFixed8String, "-1");
    ok(PositiveFixed8String, "0.00000001");
    ok(PositiveFixed8String, "4");
  });
});

describe("GET query helpers", () => {
  it("QueryUuidList splits a comma-separated list, trims, and refuses empties and non-uuids", () => {
    expect(QueryUuidList.parse(`${U1},${U2}`)).toEqual([U1, U2]);
    expect(QueryUuidList.parse(` ${U1} , ${U2},`)).toEqual([U1, U2]);
    bad(QueryUuidList, "");
    bad(QueryUuidList, "not-a-uuid");
    bad(QueryUuidList, `${U1},x`);
    bad(QueryUuidList, Array.from({ length: 51 }, () => U1).join(","));
  });
  it("AsOfQuery and InvestmentPeriodQuery read the Phase 2 query conventions and default the period", () => {
    expect(AsOfQuery.parse({ asOf: "2026-10-13", includeClosed: "true" })).toEqual({ asOf: "2026-10-13", includeClosed: true });
    expect(InvestmentPeriodQuery.parse({})).toEqual({ period: "1y" });
    expect(InvestmentPeriodQuery.parse({ period: "custom", from: "2026-01-01", to: "2026-10-13", today: "2026-10-13" })).toEqual({
      period: "custom",
      from: "2026-01-01",
      to: "2026-10-13",
      today: "2026-10-13",
    });
    bad(InvestmentPeriodQuery, { period: "2y" });
    bad(AsOfQuery, { asOf: "10/13/2026" });
  });
  it("ValuationSummaryQuery takes asOf, comma-separated accountIds and a 1m default period", () => {
    expect(ValuationSummaryQuery.parse({ asOf: "2026-10-13", accountIds: `${U1},${U2}` })).toEqual({ asOf: "2026-10-13", accountIds: [U1, U2], period: "1m" });
    bad(ValuationSummaryQuery, { accountIds: "nope" });
  });
  it("PerformanceQuery is the period query plus accountIds and a benchmark", () => {
    expect(PerformanceQuery.parse({ period: "ytd", accountIds: U1, benchmarkSecurityId: U2 })).toEqual({ period: "ytd", accountIds: [U1], benchmarkSecurityId: U2 });
    bad(PerformanceQuery, { benchmarkSecurityId: "VTI" });
  });
});

describe("Securities", () => {
  it("SecurityView round-trips and refuses a bad type", () => {
    roundTrip(SecurityView, securityView);
    bad(SecurityView, { ...securityView, type: "crypto" });
    bad(SecurityView, { ...securityView, latestPrice: { date: "2026-10-13", close: "-1", source: "provider" } });
  });
  it("CreateSecurityBody takes the expense ratio as a percent string and refuses a 9-decimal price mode mixup", () => {
    ok(CreateSecurityBody, { name: "Vanguard 500", type: "fund", assetClass: "us_stock", expenseRatioPercent: "0.04", cusip: "922908710", alwaysPrice: true });
    bad(CreateSecurityBody, { name: "", type: "fund", assetClass: "us_stock" });
    bad(CreateSecurityBody, { name: "X", type: "fund", assetClass: "us_stock", expenseRatioPercent: "100.1" });
    bad(CreateSecurityBody, { name: "X", type: "fund", assetClass: "us_stock", cusip: "12345" });
    expect(UpdateSecurityPricingBody.parse({ priceMode: "implied", providerSymbol: null, alwaysPrice: false, name: "ignored" })).toEqual({ priceMode: "implied", providerSymbol: null, alwaysPrice: false });
  });
  it("ResolveSecurityResponse is a status union", () => {
    ok(ResolveSecurityResponse, { status: "resolved", security: securityView, matchedBy: "alias" });
    ok(ResolveSecurityResponse, { status: "unresolved", suggestion: { ticker: "SPAXX", cusip: null, isin: null, name: "", type: "fund", assetClass: "cash" } });
    bad(ResolveSecurityResponse, { status: "maybe", security: securityView });
    bad(ResolveSecurityResponse, { status: "resolved", security: securityView, matchedBy: "new" });
  });
  it("SetSecurityAllocationBody allows null, [] or weighted splits", () => {
    ok(SetSecurityAllocationBody, { assetClass: "us_stock", splits: null });
    ok(SetSecurityAllocationBody, { assetClass: "us_stock", splits: [{ assetClass: "us_stock", weightBp: 5400 }, { assetClass: "intl_stock", weightBp: 3600 }, { assetClass: "bonds", weightBp: 1000 }] });
    bad(SetSecurityAllocationBody, { assetClass: "us_stock", splits: [{ assetClass: "us_stock", weightBp: 0 }] });
  });
});

describe("Positions and trades imports", () => {
  it("PositionsCsvMapping needs an identity column and a value (or quantity and price)", () => {
    expect(PositionsCsvMapping.parse(positionsMapping)).toMatchObject({ hasHeader: true, skipRows: 0, asOf: { mode: "request" } });
    ok(PositionsCsvMapping, { asOf: { mode: "column", column: 0, format: "MM/DD/YYYY" }, name: { column: "Description" }, value: { column: "Value" } });
    bad(PositionsCsvMapping, { asOf: { mode: "request" }, value: { column: "Value" } });
    bad(PositionsCsvMapping, { asOf: { mode: "request" }, symbol: { column: "Symbol" }, quantity: { column: "Quantity" } });
    bad(PositionsCsvMapping, { asOf: { mode: "clock" }, symbol: { column: "Symbol" }, value: { column: "Value" } });
  });
  it("TradesCsvMapping defaults the file conventions and only knows the trade kinds", () => {
    expect(TradesCsvMapping.parse(tradesMapping)).toMatchObject({ amountIncludesFees: true, reinvestRows: "separate", rowOrder: "auto", actionMap: {} });
    ok(TradesCsvMapping, { ...tradesMapping, actionMap: { journaled: "skip", "reinvest dividend": "reinvest_combined" }, fee: { columns: ["Commission ($)", "Fees ($)"] } });
    bad(TradesCsvMapping, { ...tradesMapping, actionMap: { journaled: "ignore" } });
    bad(TradesCsvMapping, { ...tradesMapping, symbol: undefined });
    bad(TradeKind, "unknown");
  });
  it("PositionsPreviewBody defaults choices; PositionsCommitBody needs the mapping and may carry the statement total", () => {
    expect(PositionsPreviewBody.parse({ csvText: "Symbol,Quantity\n", accountId: U1, asOfDate: "2026-10-13" })).toMatchObject({ choices: [] });
    ok(PositionsCommitBody, { csvText: "x", accountId: U1, mapping: positionsMapping, asOfDate: "2026-10-13", statementTotalCents: "335009", setBalance: true, choices: [{ rowIndex: 2, security: { kind: "existing", securityId: U2 } }] });
    bad(PositionsCommitBody, { csvText: "x", accountId: U1, asOfDate: "2026-10-13" });
    bad(PositionsCommitBody, { csvText: "x", accountId: U1, mapping: positionsMapping, statementTotalCents: "3350.09" });
  });
  it("PositionsPreviewResponse carries the import-time reconciliation line with matchesToDollar", () => {
    const response = {
      headers: ["Symbol", "Quantity"],
      sampleRows: [["VTI", "12.75"]],
      mapping: positionsMapping,
      asOf: "2026-10-13",
      positions: [{ rowIndex: 1, security: previewRef, quantity: "12.75", price: "250", valueCents: "318750", costBasisCents: "260000", warnings: [], existing: null }],
      totalValueCents: "333775",
      knownBalanceCents: "335009",
      differenceCents: "1234",
      matchesToDollar: false,
      setBalanceDefault: true,
      filterValues: [],
      pendingActivityCents: "1234",
      snapshotExists: false,
      existingSource: null,
      willReplace: true,
      rowsRead: 5,
      errors: [],
      skipped: [{ rowIndex: 4, reason: "pending_activity" }],
    };
    ok(PositionsPreviewResponse, response);
    bad(PositionsPreviewResponse, { ...response, matchesToDollar: "yes" });
  });
  it("MappedTradeView links to the ledger by ledgerTransactionId", () => {
    const trade = {
      rowIndex: 3,
      sequence: 0,
      date: "2026-10-09",
      type: "sell",
      kind: "sell",
      security: previewRef,
      quantity: "4",
      price: "130",
      amountCents: "51998",
      feeCents: "2",
      splitNum: null,
      splitDen: null,
      transferDirection: null,
      externalId: "inv:38638c9dc3e6f19929e61e0fd5a3841ad5aed967fddc90a1a233dbd75687955a",
      rawDescription: "YOU SOLD VANGUARD TOTAL STOCK MKT ETF (VTI)",
      derived: [],
      warnings: [],
      duplicate: false,
      changed: false,
      userEdited: false,
      ledgerMatch: { ledgerTransactionId: U3, date: "2026-10-09" },
    };
    roundTrip(MappedTradeView, trade);
    bad(MappedTradeView, { ...trade, ledgerMatch: { transactionId: U3, date: "2026-10-09" } });
    bad(MappedTradeView, { ...trade, feeCents: "-2" });
  });
});

describe("Holding snapshots and manual positions", () => {
  it("HoldingSnapshotView round-trips with dollar-only rows", () => {
    const snapshot = {
      accountId: U1,
      date: "2026-10-13",
      source: "csv",
      importLogId: U3,
      rows: [
        { securityId: U2, ticker: "VTI", name: "VTI", quantity: "12.75", price: "250", valueCents: "318750", reportedCostBasisCents: "260000" },
        { securityId: U3, ticker: null, name: "Company Stock Fund", quantity: null, price: null, valueCents: "15025", reportedCostBasisCents: null },
      ],
      totalValueCents: "333775",
      knownBalanceCents: null,
      differenceCents: null,
      matchesToDollar: null,
      updatedAt: "2026-10-13T00:00:00.000Z",
    };
    roundTrip(HoldingSnapshotView, snapshot);
    bad(HoldingSnapshotView, { ...snapshot, source: "ofx" });
  });
  it("ManualPositionInput needs a price (with a quantity) or a value; the body may set the statement total", () => {
    ok(ManualPositionInput, { security: { kind: "existing", securityId: U2 }, quantity: "10", price: "250" });
    ok(ManualPositionInput, { security: { kind: "create", security: { ticker: null, cusip: null, isin: null, name: "Fund", type: "fund", assetClass: "other" } }, valueCents: "15025" });
    bad(ManualPositionInput, { security: { kind: "existing", securityId: U2 }, quantity: "10" });
    bad(ManualPositionInput, { security: { kind: "existing", securityId: U2 }, price: "250" });
    ok(ManualPositionsBody, { asOfDate: "2026-10-13", statementTotalCents: "335009", positions: [{ security: { kind: "existing", securityId: U2 }, valueCents: "1" }] });
    bad(ManualPositionsBody, { asOfDate: "2026-10-13", positions: [] });
  });
});

describe("Investment transactions", () => {
  it("InvestmentTxnView round-trips with lot picks and the ledger link", () => {
    const txn = {
      id: U1,
      accountId: U2,
      accountName: "Brokerage",
      securityId: U3,
      ticker: "VTI",
      securityName: "VTI",
      date: "2026-10-09",
      sequence: 1,
      type: "sell",
      quantity: "4",
      price: "130",
      amountCents: "51998",
      feeCents: "2",
      splitNum: null,
      splitDen: null,
      transferDirection: null,
      counterpartyAccountId: null,
      transferGroupId: null,
      costBasisCents: null,
      acquiredDate: null,
      lotPicks: [{ id: U3, sellTxnId: U1, lotId: U2, quantity: "4", position: 0 }],
      ledgerTransactionId: U3,
      externalId: null,
      source: "manual",
      importLogId: null,
      rawDescription: null,
      memo: "sold a few",
      userEdited: false,
      createdAt: "2026-10-09T00:00:00.000Z",
      updatedAt: "2026-10-09T00:00:00.000Z",
    };
    roundTrip(InvestmentTxnView, txn);
    bad(InvestmentTxnView, { ...txn, source: "bank" });
  });
  it("CreateInvestmentTxnBody is a union by type: buys need quantity > 0 and a price, sells may pick lots, transfers carry a direction", () => {
    ok(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-02", type: "buy", securityId: U2, quantity: "5", price: "48.123", feeCents: "495" });
    ok(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-06", type: "reinvest", securityId: U2, quantity: "0.1", price: "123.4" });
    ok(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-09", type: "sell", securityId: U2, quantity: "4", price: "130", lotPicks: [{ lotId: U3, quantity: "4" }], today: "2026-10-13" });
    ok(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-05", type: "dividend", securityId: U2, amountCents: "1234" });
    ok(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-05", type: "interest", amountCents: "410" });
    ok(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-05", type: "fee", amountCents: "-495" });
    ok(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-05", type: "split", securityId: U2, splitNum: 2, splitDen: 1 });
    ok(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-01", type: "transfer", direction: "in", amountCents: "500000" });
    ok(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-01", type: "transfer", direction: "in", securityId: U2, quantity: "10", counterpartyAccountId: U3, costBasisCents: "250000", acquiredDate: "2024-01-15" });
    bad(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-02", type: "buy", securityId: U2, quantity: "0", price: "48.123" });
    bad(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-02", type: "buy", securityId: U2, quantity: "5" });
    bad(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-09", type: "sell", securityId: U2, quantity: "4", price: "130", lotPicks: [] });
    bad(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-05", type: "split", securityId: U2, splitNum: 0, splitDen: 1 });
    bad(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-01", type: "transfer", amountCents: "500000" });
    bad(CreateInvestmentTxnBody, { accountId: U1, date: "2026-10-01", type: "wire", amountCents: "500000" });
  });
  it("SetLotPicksBody is keyed by lot id and may be empty to clear the picks", () => {
    ok(SetLotPicksBody, { picks: [] });
    ok(SetLotPicksBody, { picks: [{ lotId: U1, quantity: "2.5" }] });
    bad(SetLotPicksBody, { picks: [{ openTxnId: U1, quantity: "2.5" }] });
    bad(SetLotPicksBody, { picks: [{ lotId: U1, quantity: "0" }] });
  });
  it("SetAllocationTargetsBody refuses a duplicate class; AllocationTargetsView round-trips", () => {
    ok(SetAllocationTargetsBody, { targets: [{ assetClass: "us_stock", targetBp: 5000 }, { assetClass: "intl_stock", targetBp: 2500 }, { assetClass: "bonds", targetBp: 2000 }, { assetClass: "cash", targetBp: 500 }] });
    ok(SetAllocationTargetsBody, { targets: [] });
    bad(SetAllocationTargetsBody, { targets: [{ assetClass: "us_stock", targetBp: 5000 }, { assetClass: "us_stock", targetBp: 5000 }] });
    bad(SetAllocationTargetsBody, { targets: [{ assetClass: "us_stock", targetBp: 10001 }] });
    roundTrip(AllocationTargetsView, { targets: [{ assetClass: "us_stock", targetBp: 10000 }], updatedAt: null });
  });
});

describe("Lots and performance", () => {
  it("PerformanceRequestBody defaults detail to summary and caps the account list", () => {
    expect(PerformanceRequestBody.parse({})).toEqual({ detail: "summary" });
    ok(PerformanceRequestBody, { from: "2025-10-13", to: "2026-10-13", accountIds: [U1, U2], benchmarkSecurityId: null, detail: "full" });
    bad(PerformanceRequestBody, { detail: "verbose" });
    bad(PerformanceRequestBody, { accountIds: U1 });
  });
  it("PerformanceResponse round-trips an account block with holdings, lots, disposals and a statement check", () => {
    const response = {
      from: "2025-10-13",
      to: "2026-10-13",
      asOf: "2026-10-13",
      today: "2026-10-13",
      days: 365,
      detail: "full",
      accounts: [
        {
          accountId: U1,
          name: "Brokerage",
          type: "brokerage",
          taxTreatment: "taxable",
          fidelity: "full_history",
          ...performanceBlock,
          holdings: [
            {
              accountId: U1,
              securityId: U2,
              ticker: "VTI",
              securityName: "VTI",
              assetClass: "us_stock",
              quantity: "40",
              priceDate: "2026-10-13",
              price: "312.5",
              priceSource: "provider",
              stale: false,
              valueCents: "1250000",
              costBasisCents: "1160000",
              unrealizedCents: "90000",
              unrealizedShortCents: "0",
              unrealizedLongCents: "90000",
              unknownBasisQuantity: "0",
              lotCount: 2,
            },
          ],
          lots: [lot],
          disposals: [disposal],
          statementCheck: { date: "2026-10-13", statementCents: "270520000", securitiesCents: "256200000", impliedCashCents: "14320000", trackedCashCents: "14320000", trackedFrom: "inception", differenceCents: "0" },
        },
      ],
      total: { ...performanceBlock, twr: failedFigure, accountIds: [U1], partialGains: false, excludedInternalFlows: 0 },
      benchmark: {
        securityId: U2,
        ticker: "VTI",
        name: "VTI",
        adjusted: false,
        twr: { rate: 0.2019230769, annualized: 0.2019230769, reason: null, reasonDate: null },
        xirr,
        shadowValueCents: "294263900",
        startPrice: "260",
        endPrice: "312.5",
        legs: [{ date: "2025-10-13", cents: "200000000", price: "260", priceDate: "2025-10-13", units: "76.92307692" }],
      },
      warnings: [],
    };
    roundTrip(PerformanceResponse, response);
    bad(PerformanceResponse, { ...response, accounts: [{ ...response.accounts[0], fidelity: "full" }] });
    bad(PerformanceResponse, { ...response, total: { ...response.total, twr: { ...failedFigure, reason: "bad_luck" } } });
  });
  it("LotView allows an unknown basis as null; LotsResponse carries the derived fidelity per account", () => {
    roundTrip(LotView, { ...lot, originalCostBasisCents: null, costBasisCents: null, basisPerShare: null, basisKnown: false, unrealizedCents: null });
    roundTrip(LotsResponse, { asOf: "2026-10-13", lots: [lot], accounts: [{ accountId: U1, fidelity: "positions", lotMethod: "specific", positionCheckDate: "2026-10-13", warnings: [warning] }] });
    bad(LotsResponse, { asOf: "2026-10-13", lots: [lot], accounts: [{ accountId: U1, history: "full", lotMethod: "fifo", positionCheckDate: null, warnings: [] }] });
    bad(LotView, { ...lot, openedBy: "sell" });
  });
  it("RealizedGainsResponse round-trips", () => {
    roundTrip(RealizedGainsResponse, { from: "2026-01-01", to: "2026-12-31", summary: realizedSummary, byAccount: [{ accountId: U1, name: "Brokerage", summary: realizedSummary }], disposals: [disposal] });
    bad(RealizedGainsResponse, { from: "2026-01-01", to: "2026-12-31", summary: { ...realizedSummary, washSalesApplied: true }, byAccount: [], disposals: [] });
  });
});

describe("Prices", () => {
  it("PriceView round-trips; SetPriceBody refuses a negative close", () => {
    roundTrip(PriceView, { securityId: U2, date: "2026-10-13", close: "305.25", adjClose: null, source: "provider", provider: "tiingo", suspect: false, updatedAt: "2026-10-13T21:30:00.000Z" });
    bad(PriceView, { securityId: U2, date: "2026-10-13", close: "305.25", adjClose: null, source: "provider", provider: "yahoo", suspect: false, updatedAt: "x" });
    ok(SetPriceBody, { close: "505.12", today: "2026-10-13" });
    bad(SetPriceBody, { close: "-1" });
    bad(SetPriceBody, { close: 505.12 });
  });
  it("PricesStatusResponse round-trips one security row and the counts", () => {
    const status = {
      provider: "tiingo",
      configured: true,
      fetchHourLocal: 18,
      catchupHourLocal: 6,
      timezone: "America/Denver",
      expectedDate: "2026-10-13",
      lastRun: { importLogId: U3, startedAt: "2026-10-13T00:00:00.000Z", finishedAt: null, status: "running", message: null, stats: { requests: 3 } },
      activeJob: { id: U1, status: "running", reason: "nightly", runAt: "2026-10-13T00:00:00.000Z" },
      securities: [
        {
          securityId: U2,
          ticker: "VTI",
          name: "VTI",
          priceMode: "provider",
          providerSymbol: null,
          alwaysPrice: false,
          held: true,
          latestPriceDate: "2026-10-09",
          latestClose: "305.25",
          latestSource: "provider",
          priceStatus: "stale",
          tradingDaysBehind: 2,
          fetchStatus: "rate_limited",
          fetchMessage: "429 after 3 attempts",
          fetchedAt: "2026-10-12T00:00:00.000Z",
          failures: 1,
          nextAttemptAt: "2026-10-14T00:00:00.000Z",
          backfilledFrom: "2025-10-01",
        },
      ],
      counts: { current: 3, stale: 1, notFound: 0, error: 0, implied: 2, manual: 1 },
    };
    roundTrip(PricesStatusResponse, status);
    bad(PricesStatusResponse, { ...status, securities: [{ ...status.securities[0], priceStatus: "fixed" }] });
  });
});

describe("Valuation", () => {
  it("LineValuationView uses the reconciled LineKind, HoldingPriceSource and PriceStatus spellings", () => {
    roundTrip(LineValuationView, line);
    roundTrip(LineValuationView, { ...positionLine, priceSource: "txn", priceStatus: "implied" });
    bad(LineValuationView, { ...line, kind: "residual" });
    bad(LineValuationView, { ...positionLine, priceSource: "fixed" });
    bad(LineValuationView, { ...positionLine, priceStatus: "fixed" });
  });
  it("AccountValuationView and ValuationSummaryResponse round-trip under asOf, fidelity and basis", () => {
    roundTrip(AccountValuationView, accountValuation);
    bad(AccountValuationView, { ...accountValuation, fidelity: "none" });
    bad(AccountValuationView, { ...accountValuation, basis: "chain" });
    const summary = {
      asOf: "2026-10-13",
      today: "2026-10-13",
      expectedDate: "2026-10-13",
      totalCents: "7007669",
      partial: true,
      missing: [],
      priceStatus: "current",
      dayChange: { ...dayChange, cents: "40038", bp: 57, partial: true, excluded: [{ accountId: U2, reason: "balance_only" }] },
      periodChange: { ...changeSummary, period: "1w", newAccounts: [{ id: U3, name: "HSA", openingCents: "200000" }] },
      accounts: [accountValuation],
    };
    roundTrip(ValuationSummaryResponse, summary);
    ok(ValuationSummaryResponse, { ...summary, periodChange: null });
    bad(ValuationSummaryResponse, { ...summary, dayChange: dayChange });
  });
  it("ValuationSeriesResponse round-trips nullable points", () => {
    roundTrip(ValuationSeriesResponse, {
      from: "2026-10-06",
      to: "2026-10-13",
      expectedDate: "2026-10-13",
      dates: ["2026-10-06", "2026-10-13"],
      accounts: [{ accountId: U1, name: "Brokerage", type: "brokerage", fidelity: "balance_only", firstDataDate: "2026-10-13", values: [null, "1000000"] }],
      portfolio: [
        { date: "2026-10-06", valueCents: null, partial: true, missing: [U1], priceStatus: "n/a" },
        { date: "2026-10-13", valueCents: "1000000", partial: false, missing: [], priceStatus: "current" },
      ],
    });
  });
});

describe("Reconciliation", () => {
  it("ReconcileRowBody needs an identity; the preview body carries the statement", () => {
    ok(ReconcileRowBody, { ticker: "VTI", quantity: "100", price: "305.25" });
    ok(ReconcileRowBody, { isCash: true, quantity: "2234.56" });
    expect(ReconcileRowBody.parse({ securityId: U2, quantity: "50.123", valueCents: "2531713" })).toEqual({ securityId: U2, isCash: false, quantity: "50.123", valueCents: "2531713" });
    bad(ReconcileRowBody, { quantity: "100", price: "305.25" });
    ok(ReconcilePreviewBody, { accountId: U1, date: "2026-10-13", statementTotalCents: "5807669", rows: [{ ticker: "VTI", quantity: "100", price: "305.25" }], today: "2026-10-13" });
    bad(ReconcilePreviewBody, { accountId: U1, date: "2026-10-13", rows: [], toleranceCents: "-1" });
    expect(ReconcileCommitBody.parse({ accountId: U1, date: "2026-10-13", rows: [] })).toMatchObject({ accept: true });
  });
  it("ReconcilePreviewResponse and ReconcileCommitResponse report matchesToDollar", () => {
    const row = {
      securityId: U2,
      ticker: "VFIAX",
      name: "Vanguard 500 Index Admiral",
      isCash: false,
      app: { quantity: "50.123", price: "505.1", priceDate: "2026-10-13", priceSource: "provider", valueCents: "2531713", valueSource: "priced" },
      statement: { quantity: "50.123", price: "505.12", valueCents: "2531813" },
      quantityDiff: "0",
      priceDiff: "-0.02",
      valueDiffCents: "-100",
      status: "price",
    };
    const preview = {
      accountId: U1,
      date: "2026-10-13",
      app: accountValuation,
      statementTotalCents: "5807769",
      differenceCents: "-100",
      unexplainedCents: "0",
      toleranceCents: "100",
      matchesToDollar: false,
      rows: [row],
      balance: { balanceCents: "5807669", balanceDate: "2026-10-13", differenceCents: "-100" },
      cashInferenceHint: { flowsSinceSnapshotCents: "100000", plugCents: "0", wouldReconcile: true },
      alreadyReconciled: false,
    };
    roundTrip(ReconcilePreviewResponse, preview);
    bad(ReconcilePreviewResponse, { ...preview, matchesToDollar: undefined, matchesToTheDollar: false });
    bad(ReconcilePreviewResponse, { ...preview, rows: [{ ...row, status: "mismatch" }] });
    roundTrip(ReconcileCommitResponse, { reconciliationId: U3, batchId: U1, accepted: true, preCommitDifferenceCents: "-100", matchesToDollar: false, app: accountValuation, rowsWritten: 3, impliedPricesWritten: 1 });
    roundTrip(ReconciliationView, {
      id: U3,
      accountId: U1,
      date: "2026-10-13",
      statementTotalCents: "5807769",
      differenceCents: "-100",
      unexplainedCents: "0",
      toleranceCents: "100",
      matchesToDollar: false,
      balance: preview.balance,
      appValueCents: "5807669",
      appBasis: "snapshot",
      appAsOf: "2026-10-13",
      cashInference: "auto",
      reconciled: false,
      accepted: true,
      holdingSnapshotDate: "2026-10-13",
      note: "Q3 statement",
      createdAt: "2026-10-13T20:00:00.000Z",
    });
  });
});

describe("Investment views", () => {
  it("PortfolioView round-trips", () => {
    roundTrip(PortfolioView, {
      today: "2026-10-13",
      asOf: "2026-10-13",
      period: { kind: "1y", from: "2025-10-13", to: "2026-10-13", days: 365, partial: false, note: null },
      totalCents: "452520000",
      dayChange: { ...dayChange, cents: "3600000", bp: 80, partial: false, excluded: [] },
      periodChange: changeSummary,
      accounts: [
        {
          ...accountRef,
          valuationDate: "2026-10-13",
          valuationSource: "simplefin",
          basis: "lots",
          valuationStale: false,
          positionsDate: "2026-10-13",
          positionsStale: false,
          valueCents: "270520000",
          dayChangeCents: "3200000",
          dayChangeBp: 119,
          holdingsCount: 3,
          cashCents: "0",
          residualCents: "14320000",
          closed: false,
          investmentIncomeFeed: "link",
          period: { ...changeSummary, startCents: "200000000", endCents: "270520000", changeCents: "70520000", changeBp: 3526, growthCents: "20520000", incomeCents: "2320000", uncategorizedRows: 1 },
          warnings: [{ accountId: U1, accountName: "Brokerage", kind: "lots_mismatch", message: "VTI lots cover 20 of 40 shares" }],
        },
      ],
      series: { dates: ["2026-10-12", "2026-10-13"], step: 1, total: ["448920000", "452520000"], accounts: [{ accountId: U1, points: [null, "270520000"] }] },
      fidelityCounts: { balance_only: 0, positions: 1, full_history: 1 },
      warnings: [],
    });
  });
  it("AllocationView round-trips a class with lines and a rebalance suggestion", () => {
    roundTrip(AllocationView, {
      today: "2026-10-13",
      asOf: "2026-10-13",
      totalCents: "452520000",
      classifiedCents: "452520000",
      unclassifiedCents: "0",
      targetsSet: true,
      classes: [
        {
          assetClass: "us_stock",
          currentCents: "250000000",
          currentBp: 5524,
          targetBp: 5000,
          targetCents: "226260000",
          driftBp: 524,
          driftCents: "23740000",
          outOfBand: true,
          lines: [{ securityId: U2, ticker: "VTI", name: "VTI", accountId: U1, accountName: "Brokerage", cents: "125000000", kind: "position", blended: false }],
        },
      ],
      byTaxTreatment: [{ taxTreatment: "taxable", cents: "270520000", bp: 5978, classes: [{ assetClass: "us_stock", cents: "125000000" }] }],
      byAccount: [{ ...accountRef, cents: "270520000", bp: 5978, classes: [{ assetClass: "us_stock", cents: "125000000", bp: 4620 }] }],
      unclassifiedAccounts: [{ ...accountRef, accountId: U3, fidelity: "balance_only", cents: "1000000", bpOfTotal: 22 }],
      rebalance: {
        triggered: true,
        bandBp: 500,
        minTradeCents: "10000",
        trades: [{ accountId: U1, accountName: "Brokerage", taxTreatment: "taxable", action: "sell", assetClass: "us_stock", securityId: U2, ticker: "VTI", inAccount: true, amountCents: "23740000", approxQuantity: "759.68", price: "312.5", estimatedGainCents: "1709280", note: null }],
        residual: [{ assetClass: "cash", amountCents: "0" }],
        belowMinimumCents: "0",
        notes: ["Sells in taxable accounts realize gains."],
      },
      warnings: [],
      accountWarnings: [],
    });
  });
  it("HoldingsView round-trips one row across accounts", () => {
    roundTrip(HoldingsView, {
      today: "2026-10-13",
      asOf: "2026-10-13",
      totalCents: "452520000",
      holdingsCents: "438200000",
      cashCents: "0",
      residualCents: "14320000",
      rows: [
        {
          ...securityRef,
          quantity: "60",
          price: "312.5",
          priceDate: "2026-10-13",
          priceSource: "provider",
          priceStatus: "current",
          priceStale: false,
          valueCents: "1875000",
          weightBp: 41,
          costBasisCents: "1160000",
          coverage: "partial",
          gainCents: null,
          gainBp: null,
          expenseRatioPpm: 300,
          accounts: [
            { ...accountRef, kind: "position", quantity: "40", valueCents: "1250000", costBasisCents: "1160000", basisSource: "lots", gainCents: "90000", lotCount: 2, unknownBasisQuantity: "0", snapshotDate: "2026-10-13", snapshotSource: "simplefin", priceSource: "provider", dollarOnly: false },
            { ...accountRef, accountId: U3, fidelity: "positions", kind: "position", quantity: "20", valueCents: "625000", costBasisCents: null, basisSource: null, gainCents: null, lotCount: null, unknownBasisQuantity: null, snapshotDate: "2026-10-09", snapshotSource: "csv", priceSource: "statement", dollarOnly: false },
          ],
        },
      ],
      weightedExpenseRatio: { ppm: 300, coveredBp: 10000, annualCostCents: "56250" },
      concentration: [{ level: "warn", securityId: U2, ticker: "VTI", weightBp: 1200, thresholdBp: 1000, message: "VTI is 12% of the portfolio" }],
      excludedAccounts: [{ ...accountRef, accountId: U3, fidelity: "balance_only", cents: "1000000" }],
      accountWarnings: [],
      warnings: [],
    });
  });
  it("PerformanceView round-trips the presentation block", () => {
    const block = {
      method: "modified_dietz",
      startValueCents: "150000000",
      endValueCents: "181000000",
      openingValue: null,
      contributionsCents: "0",
      withdrawalsCents: "0",
      netFlowsCents: "0",
      growthCents: "31000000",
      twr: returnFigure,
      xirr,
      benchmark: { twr: 0.2019230769, twrAnnualized: 0.2019230769, xirrAnnualized: 0.2019230769, shadowValueCents: "180288500", excessTwr: 0.0047436, startPrice: "260", endPrice: "312.5", reason: null },
      flows: [],
      flowsSource: "none",
      uncategorizedRows: 0,
      warnings: [{ code: "valuation_carried", accountId: U1, date: "2026-10-09" }],
      readable: ["Valued with the 2026-10-09 statement (no value on the period boundary)."],
      series: [
        { date: "2025-10-13", indexBp: 10000 },
        { date: "2026-10-13", indexBp: 12067 },
      ],
    };
    roundTrip(PerformanceView, {
      today: "2026-10-13",
      asOf: "2026-10-13",
      period: { kind: "1y", from: "2025-10-13", to: "2026-10-13", days: 365, partial: false, note: null },
      benchmark: { securityId: U2, ticker: "VTI", name: "VTI", adjusted: false, series: [{ date: "2025-10-13", indexBp: 10000 }] },
      total: block,
      accounts: [{ ...accountRef, block }],
      warnings: [],
    });
    bad(PerformanceView, { today: "2026-10-13", asOf: null, period: null, benchmark: null, total: { ...block, flowsSource: "bank" }, accounts: [], warnings: [] });
  });
  it("IncomeView round-trips months with fees and the feed block", () => {
    roundTrip(IncomeView, {
      today: "2026-10-13",
      asOf: "2026-10-13",
      period: { kind: "ytd", from: "2025-12-31", to: "2026-10-13", days: 286, partial: false, note: null },
      months: [{ month: "2026-09", dividendsCents: "1377500", interestCents: "41000", feesCents: "0", reinvestedCents: "0", totalCents: "1418500", bySecurity: [{ securityId: U2, ticker: "VTI", cents: "415000" }, { securityId: null, ticker: null, cents: "41000" }], byAccount: [{ accountId: U1, cents: "947000" }] }],
      totals: { dividendsCents: "3202500", interestCents: "41000", feesCents: "0", reinvestedCents: "0", totalCents: "3243500" },
      trailing12mCents: "3243500",
      yieldBp: 71,
      rows: [{ id: `inv:${U3}`, date: "2026-09-29", month: "2026-09", accountId: U1, accountName: "Brokerage", securityId: U2, ticker: "VTI", kind: "dividend", cents: "491000", reinvested: false, source: "investment_txn", ledgerTransactionId: U3, linkStatus: "linked", fed: true }],
      rowsTruncated: false,
      feed: { categoryId: U3, categoryName: "Dividends", accounts: [{ ...accountRef, mode: "link", linked: 7, created: 0, awaiting: 0, fed: 7, hasLedger: true, suggestedMode: "link" }] },
      warnings: [],
    });
  });
  it("AccountChangesView round-trips the attribution", () => {
    roundTrip(AccountChangesView, {
      ...accountRef,
      from: "2026-10-12",
      to: "2026-10-13",
      summary: { ...changeSummary, from: "2026-10-12", to: "2026-10-13", startCents: "267320000", endCents: "270520000", changeCents: "3200000", changeBp: 119, netFlowsCents: "0", growthCents: "3200000", incomeCents: "0", uncategorizedRows: 0 },
      holdings: [{ securityId: U2, ticker: "VTI", name: "VTI", kind: "position", quantityFrom: "40", quantityTo: "40", priceFrom: "310", priceTo: "312.5", valueFromCents: "1240000", valueToCents: "1250000", deltaCents: "10000", priceEffectCents: "10000", quantityEffectCents: "0" }],
      residualEffectCents: "0",
      flows: [],
      income: [],
      warnings: [],
    });
  });
});

describe("Phase 1/2 contracts extended for Phase 3", () => {
  it("AuthStatus gains an optional role", () => {
    ok(AuthStatus, { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, username: "owner", role: "viewer" });
    ok(AuthStatus, { setupRequired: false, authenticated: false, totpRequired: false, totpEnrolled: false });
    bad(AuthStatus, { setupRequired: false, authenticated: true, totpRequired: false, totpEnrolled: true, role: "admin" });
  });
  it("AccountView gains lotMethod, cashInference, investmentIncomeFeed and the investment block; UpdateAccountBody the three settings", () => {
    const investment = { fidelity: "positions", fidelityNote: "trade history incomplete: VTI lots cover 20 of 40 shares", positionsMatch: false, lastSnapshotDate: "2026-10-13", lastSnapshotSource: "simplefin", lastTradeDate: "2026-10-09", securityCount: 3, needsReviewCount: 1, lastReconciliation };
    roundTrip(AccountInvestmentView, investment);
    bad(AccountInvestmentView, { ...investment, fidelity: "none" });
    bad(AccountInvestmentView, { ...investment, reconciled: true, positionsMatch: undefined });
    const account = {
      id: U1,
      connectionId: null,
      connectionName: null,
      externalId: null,
      name: "Brokerage",
      institution: null,
      type: "brokerage",
      taxTreatment: "taxable",
      currency: "USD",
      onBudget: false,
      closed: false,
      balanceCents: "270520000",
      availableCents: null,
      balanceDate: "2026-10-13",
      transactionCount: 12,
      lowBalanceThresholdCents: null,
      paymentDay: null,
      paymentFromAccountId: null,
      statementDay: null,
      lotMethod: "fifo",
      cashInference: "auto",
      investmentIncomeFeed: "off",
      investment,
    };
    roundTrip(AccountView, account);
    roundTrip(AccountView, { ...account, type: "checking", taxTreatment: "none", investment: null });
    bad(AccountView, { ...account, lotMethod: "average" });
    ok(UpdateAccountBody, { lotMethod: "specific", cashInference: "off", investmentIncomeFeed: "create" });
    bad(UpdateAccountBody, { investmentIncomeFeed: "on" });
  });
  it("HouseholdSettingView and its patch gain the four investment fields", () => {
    roundTrip(HouseholdSettingView, {
      planStartMonth: "2026-08",
      zeroBased: false,
      lowBalanceThresholdCents: "0",
      primaryAccountId: null,
      projectionDefaultDays: 90,
      timezone: "America/Denver",
      benchmarkSecurityId: U2,
      investmentIncomeCategoryId: null,
      rebalanceBandBp: 500,
      rebalanceMinTradeCents: "10000",
      updatedAt: "2026-10-13T00:00:00.000Z",
    });
    ok(UpdateHouseholdSettingBody, { benchmarkSecurityId: null, investmentIncomeCategoryId: U3, rebalanceBandBp: 0, rebalanceMinTradeCents: "0" });
    bad(UpdateHouseholdSettingBody, { rebalanceBandBp: 6000 });
    bad(UpdateHouseholdSettingBody, { rebalanceMinTradeCents: "-1" });
  });
  it("ConnectionView carries the csv kind and the typed mapping for it", () => {
    const connection = {
      id: U1,
      type: "csv",
      name: "Fidelity positions",
      status: "ok",
      lastSyncAt: null,
      syncedThrough: null,
      lastError: null,
      lastErrors: [],
      csvMapping: null,
      csvKind: "positions",
      positionsMapping: PositionsCsvMapping.parse(positionsMapping),
      tradesMapping: null,
      accountCount: 1,
      activeJob: null,
      createdAt: "2026-10-13T00:00:00.000Z",
    };
    roundTrip(ConnectionView, connection);
    bad(ConnectionView, { ...connection, csvKind: "ofx" });
  });
  it("DashboardView gains a nullable investments block and a nullable net-worth breakdown", () => {
    const investments = DashboardView.shape.investments;
    ok(investments, null);
    ok(investments, {
      asOf: "2026-10-13",
      totalCents: "452520000",
      dayChangeCents: "3600000",
      dayChangeBp: 80,
      staleAccounts: [{ id: U3, name: "HSA", valuationDate: "2026-09-01" }],
      fidelityCounts: { balance_only: 0, positions: 1, full_history: 1 },
      awaitingReconcile: 0,
      securitiesNeedingReview: 1,
      priceFeed: { configured: true, expectedDate: "2026-10-13", stale: 1, notFound: 0, error: 0 },
    });
    bad(investments, { asOf: "2026-10-13", totalCents: "1" });
    const breakdown = DashboardView.shape.netWorth.shape.breakdown;
    ok(breakdown, null);
    ok(breakdown, { investmentsCents: "452520000", investmentsAsOf: "2026-10-13", cashCents: "575000", debtCents: "-45000", otherCents: "0" });
    bad(breakdown, { investmentsCents: "452520000" });
  });
});
