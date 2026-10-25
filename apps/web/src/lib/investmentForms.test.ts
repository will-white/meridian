import { describe, expect, it } from "vitest";
import type { LotView, SecurityView } from "@meridian/shared";
import {
  buildCreateSecurity,
  buildPositionsBody,
  buildSecurityPatch,
  defaultSecurityChip,
  defaultTradeAmountCents,
  derivedPriceText,
  derivedValueText,
  dollarsToCentsSigned,
  emptyTradeForm,
  estimatedLotGain,
  expenseRatioText,
  filterSecurities,
  isDisposal,
  lastReconciliationText,
  lotPickLabel,
  parseExpenseRatio,
  parseLotPicks,
  parsePositionRows,
  parseTradeForm,
  pickableLots,
  positionRowsFromSnapshot,
  positionsMatchText,
  securityDeleteReason,
  securityForm,
  statementTotalNote,
  txnSourceText,
  txnSummary,
  type PositionRowForm,
} from "./investmentForms.js";

const VTI: SecurityView = {
  id: "11111111-1111-4111-8111-111111111111",
  ticker: "VTI",
  name: "Vanguard Total Stock Market ETF",
  type: "etf",
  assetClass: "us_stock",
  expenseRatioPpm: 300,
  cusip: null,
  isin: null,
  currency: "USD",
  priceMode: "provider",
  providerSymbol: null,
  alwaysPrice: false,
  needsReview: false,
  archived: false,
  notes: null,
  aliases: [],
  held: true,
  heldInAccounts: 2,
  latestPrice: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TODAY = "2026-10-25";

describe("securities", () => {
  it("builds the edit form and reads an expense ratio as a percent", () => {
    expect(securityForm(VTI)).toEqual({ ticker: "VTI", name: VTI.name, type: "etf", assetClass: "us_stock", expenseRatio: "0.03", priceMode: "provider", providerSymbol: "", alwaysPrice: false, notes: "" });
    expect(securityForm({ ...VTI, expenseRatioPpm: null, ticker: null })).toMatchObject({ ticker: "", expenseRatio: "" });
    expect(expenseRatioText(326)).toBe("0.0326%");
    expect(expenseRatioText(null)).toBe("—");
  });

  it("parses expense ratios as the contract's percent string", () => {
    expect(parseExpenseRatio("")).toEqual({ ok: true, value: null });
    expect(parseExpenseRatio("0.03")).toEqual({ ok: true, value: "0.03" });
    expect(parseExpenseRatio(" 0.035% ")).toEqual({ ok: true, value: "0.035" });
    expect(parseExpenseRatio(".5")).toEqual({ ok: true, value: "0.5" });
    expect(parseExpenseRatio("1")).toEqual({ ok: true, value: "1" });
    expect(parseExpenseRatio("0.12345").ok).toBe(false);
    expect(parseExpenseRatio("100").ok).toBe(false);
    expect(parseExpenseRatio("abc").ok).toBe(false);
  });

  it("patches only what changed and mirrors ticker_required", () => {
    const same = buildSecurityPatch(securityForm(VTI), VTI);
    expect(same).toEqual({ ok: true, patch: {} });
    const edited = buildSecurityPatch({ ...securityForm(VTI), ticker: " vti ", expenseRatio: "0.04", providerSymbol: "VTI.US", notes: "core" }, VTI);
    expect(edited).toEqual({ ok: true, patch: { expenseRatioPercent: "0.04", providerSymbol: "VTI.US", notes: "core" } });
    const noTicker = buildSecurityPatch({ ...securityForm(VTI), ticker: "" }, VTI);
    expect(noTicker).toEqual({ ok: false, error: "Provider pricing needs a ticker or a provider symbol" });
    const implied = buildSecurityPatch({ ...securityForm(VTI), ticker: "", priceMode: "implied" }, VTI);
    expect(implied).toEqual({ ok: true, patch: { ticker: null, priceMode: "implied" } });
    expect(buildSecurityPatch({ ...securityForm(VTI), name: "  " }, VTI)).toEqual({ ok: false, error: "A name is required" });
    const cash: SecurityView = { ...VTI, type: "cash", assetClass: "cash", ticker: "CASH" };
    expect(buildSecurityPatch({ ...securityForm(cash), type: "fund" }, cash).ok).toBe(false);
  });

  it("builds a create body and refuses the cash type", () => {
    const r = buildCreateSecurity({ ticker: "abc", name: " ABC Corp ", type: "stock", assetClass: "us_stock", expenseRatio: "", priceMode: "provider", providerSymbol: "", alwaysPrice: true, notes: "" });
    expect(r).toEqual({ ok: true, body: { name: "ABC Corp", type: "stock", assetClass: "us_stock", ticker: "ABC", priceMode: "provider", providerSymbol: null, alwaysPrice: true } });
    const fund = buildCreateSecurity({ ticker: "", name: "Stable Value", type: "fund", assetClass: "bonds", expenseRatio: "0.2", priceMode: "implied", providerSymbol: "", alwaysPrice: false, notes: "401k only" });
    expect(fund).toEqual({ ok: true, body: { name: "Stable Value", type: "fund", assetClass: "bonds", ticker: null, priceMode: "implied", providerSymbol: null, alwaysPrice: false, expenseRatioPercent: "0.2", notes: "401k only" } });
    expect(buildCreateSecurity({ ticker: "", name: "X", type: "cash", assetClass: "cash", expenseRatio: "", priceMode: "implied", providerSymbol: "", alwaysPrice: false, notes: "" }).ok).toBe(false);
    expect(buildCreateSecurity({ ticker: "", name: "X", type: "stock", assetClass: "other", expenseRatio: "", priceMode: "provider", providerSymbol: "", alwaysPrice: false, notes: "" }).ok).toBe(false);
  });

  it("explains why a security cannot be deleted and picks the default chip", () => {
    expect(securityDeleteReason(VTI)).toBe("held in 2 accounts; merge it into another security or archive it instead");
    expect(securityDeleteReason({ ...VTI, held: false, heldInAccounts: 0 })).toBeNull();
    expect(securityDeleteReason({ ...VTI, type: "cash" })).toBe("the cash security is reserved");
    expect(defaultSecurityChip([VTI])).toBe("all");
    expect(defaultSecurityChip([VTI, { needsReview: true }])).toBe("review");
    const rows = [VTI, { ...VTI, id: "b", needsReview: true, held: false }, { ...VTI, id: "c", archived: true, needsReview: true }];
    expect(filterSecurities(rows, "review").map((s) => s.id)).toEqual(["b"]);
    expect(filterSecurities(rows, "held").map((s) => s.id)).toEqual([VTI.id]);
    expect(filterSecurities(rows, "all")).toHaveLength(3);
  });
});

describe("the account block", () => {
  it("spells the positions check and the last reconciliation", () => {
    expect(positionsMatchText({ positionsMatch: null, fidelityNote: null, lastSnapshotDate: null })).toBeNull();
    expect(positionsMatchText({ positionsMatch: true, fidelityNote: null, lastSnapshotDate: "2026-10-13" })).toEqual({ text: "positions match the latest statement (10/13/26)", tone: "ok" });
    expect(positionsMatchText({ positionsMatch: false, fidelityNote: "trade history incomplete: VTI lots cover 20 of 40 shares", lastSnapshotDate: "2026-10-13" })).toEqual({
      text: "trade history incomplete: VTI lots cover 20 of 40 shares",
      tone: "warn",
    });
    const rec = { id: "r", statementDate: "2026-10-13", diffCents: "0", reconciled: true, accepted: true, createdAt: "" };
    expect(lastReconciliationText(rec)).toEqual({ text: "Reconciled 10/13/26 · exact", tone: "ok" });
    expect(lastReconciliationText({ ...rec, diffCents: "-50" })).toEqual({ text: "Reconciled 10/13/26 · to the dollar", tone: "ok" });
    expect(lastReconciliationText({ ...rec, diffCents: "-250", reconciled: false, accepted: false })).toEqual({ text: "Checked 10/13/26 · off by $2.50", tone: "warn" });
    expect(lastReconciliationText({ ...rec, diffCents: null, reconciled: false })).toEqual({ text: "Reconciled 10/13/26 · no app value that day", tone: "neutral" });
    expect(lastReconciliationText(null)).toBeNull();
  });
});

describe("trade form", () => {
  it("applies the rounding rule to the default amount (imports design §3.10 worked example)", () => {
    expect(defaultTradeAmountCents("buy", "5", "48.123", "4.95")).toBe(-24_557n);
    expect(defaultTradeAmountCents("buy", "7", "51.37", "")).toBe(-35_959n);
    expect(defaultTradeAmountCents("buy", "7", "51.37", "4.95")).toBe(-36_454n);
    expect(defaultTradeAmountCents("sell", "4", "130", "0.02")).toBe(51_998n);
    expect(defaultTradeAmountCents("reinvest", "0.1", "123.40", "4.95")).toBe(-1_234n);
    expect(defaultTradeAmountCents("dividend", "1", "1", "")).toBeNull();
    expect(defaultTradeAmountCents("buy", "", "1", "")).toBeNull();
    expect(defaultTradeAmountCents("buy", "1", "1", "x")).toBeNull();
  });

  it("builds a buy with the typed fee and a sell without an amount", () => {
    const f = { ...emptyTradeForm(TODAY, "buy"), securityId: VTI.id, quantity: "5", price: "48.123", fee: "4.95", memo: " first " };
    expect(parseTradeForm(f, ACCOUNT, TODAY)).toEqual({ ok: true, body: { type: "buy", accountId: ACCOUNT, date: TODAY, today: TODAY, memo: "first", securityId: VTI.id, quantity: "5", price: "48.123", feeCents: "495" } });
    const sell = { ...emptyTradeForm("2026-10-09", "sell"), securityId: VTI.id, quantity: "-4", price: "130", amount: "519.98" };
    expect(parseTradeForm(sell, ACCOUNT, TODAY)).toEqual({ ok: false, error: "Enter a positive share quantity" });
    const sellOk = parseTradeForm({ ...sell, quantity: "4" }, ACCOUNT, TODAY);
    expect(sellOk).toEqual({ ok: true, body: { type: "sell", accountId: ACCOUNT, date: "2026-10-09", today: TODAY, securityId: VTI.id, quantity: "4", price: "130", amountCents: "51998" } });
    expect(parseTradeForm({ ...sell, quantity: "4", amount: "-519.98" }, ACCOUNT, TODAY).ok).toBe(false);
    expect(parseTradeForm({ ...f, amount: "245.57" }, ACCOUNT, TODAY).ok).toBe(false);
    expect(parseTradeForm({ ...f, date: "2026-12-01" }, ACCOUNT, TODAY)).toEqual({ ok: false, error: "The trade date cannot be in the future" });
  });

  it("signs income positive and fees negative; a dividend names its security", () => {
    const div = { ...emptyTradeForm(TODAY, "dividend"), securityId: VTI.id, amount: "12.34" };
    expect(parseTradeForm(div, ACCOUNT, TODAY)).toEqual({ ok: true, body: { type: "dividend", accountId: ACCOUNT, date: TODAY, today: TODAY, securityId: VTI.id, amountCents: "1234" } });
    expect(parseTradeForm({ ...div, securityId: "" }, ACCOUNT, TODAY).ok).toBe(false);
    const interest = parseTradeForm({ ...emptyTradeForm(TODAY, "interest"), amount: "1.05" }, ACCOUNT, TODAY);
    expect(interest).toEqual({ ok: true, body: { type: "interest", accountId: ACCOUNT, date: TODAY, today: TODAY, securityId: null, amountCents: "105" } });
    const fee = parseTradeForm({ ...emptyTradeForm(TODAY, "fee"), amount: "25" }, ACCOUNT, TODAY);
    expect(fee).toEqual({ ok: true, body: { type: "fee", accountId: ACCOUNT, date: TODAY, today: TODAY, securityId: null, amountCents: "-2500" } });
    expect(parseTradeForm({ ...emptyTradeForm(TODAY, "interest"), amount: "-1" }, ACCOUNT, TODAY).ok).toBe(false);
  });

  it("builds splits and transfers", () => {
    const split = parseTradeForm({ ...emptyTradeForm(TODAY, "split"), securityId: VTI.id, splitNum: "2", splitDen: "1" }, ACCOUNT, TODAY);
    expect(split).toEqual({ ok: true, body: { type: "split", accountId: ACCOUNT, date: TODAY, today: TODAY, securityId: VTI.id, splitNum: 2, splitDen: 1 } });
    expect(parseTradeForm({ ...emptyTradeForm(TODAY, "split"), securityId: VTI.id, splitNum: "2.5", splitDen: "1" }, ACCOUNT, TODAY).ok).toBe(false);
    const cashIn = parseTradeForm({ ...emptyTradeForm(TODAY, "transfer"), amount: "5,000" }, ACCOUNT, TODAY);
    expect(cashIn).toEqual({ ok: true, body: { type: "transfer", accountId: ACCOUNT, date: TODAY, today: TODAY, direction: "in", securityId: null, amountCents: "500000" } });
    const move = parseTradeForm({ ...emptyTradeForm(TODAY, "transfer"), direction: "out", securityId: VTI.id, quantity: "10", counterpartyAccountId: OTHER }, ACCOUNT, TODAY);
    expect(move).toEqual({ ok: true, body: { type: "transfer", accountId: ACCOUNT, date: TODAY, today: TODAY, direction: "out", securityId: VTI.id, quantity: "10", counterpartyAccountId: OTHER } });
    const outside = parseTradeForm({ ...emptyTradeForm(TODAY, "transfer"), securityId: VTI.id, quantity: "10", costBasis: "1,500.00", acquiredDate: "2024-01-15" }, ACCOUNT, TODAY);
    expect(outside).toEqual({ ok: true, body: { type: "transfer", accountId: ACCOUNT, date: TODAY, today: TODAY, direction: "in", securityId: VTI.id, quantity: "10", costBasisCents: "150000", acquiredDate: "2024-01-15" } });
    const unknownBasis = parseTradeForm({ ...emptyTradeForm(TODAY, "transfer"), securityId: VTI.id, quantity: "10" }, ACCOUNT, TODAY);
    expect(unknownBasis).toEqual({ ok: true, body: { type: "transfer", accountId: ACCOUNT, date: TODAY, today: TODAY, direction: "in", securityId: VTI.id, quantity: "10", costBasisCents: null, acquiredDate: null } });
    expect(parseTradeForm({ ...emptyTradeForm(TODAY, "transfer"), counterpartyAccountId: ACCOUNT, amount: "1" }, ACCOUNT, TODAY).ok).toBe(false);
  });

  it("describes rows", () => {
    const fmt = (q: string) => q;
    const row = { type: "sell" as const, quantity: "4", price: "130", splitNum: null, splitDen: null, transferDirection: null, securityId: VTI.id, lotPicks: [], source: "csv" as const, userEdited: true };
    expect(txnSummary(row, fmt)).toBe("Sell 4 × 130");
    expect(txnSummary({ ...row, type: "split", splitNum: 2, splitDen: 1 }, fmt)).toBe("Split 2:1");
    expect(txnSummary({ ...row, type: "transfer", transferDirection: "in", securityId: null, quantity: null }, fmt)).toBe("Transfer in (cash)");
    expect(txnSourceText(row)).toBe("imported · edited by hand");
    expect(txnSourceText({ source: "manual", userEdited: false })).toBe("manual");
    expect(isDisposal(row)).toBe(true);
    expect(isDisposal({ ...row, type: "buy" })).toBe(false);
    expect(isDisposal({ ...row, type: "transfer", transferDirection: "out" })).toBe(true);
    expect(lotPickLabel(row)).toBe("FIFO (no picks)");
    expect(lotPickLabel({ ...row, lotPicks: [{ id: "a", sellTxnId: "s", lotId: "l", quantity: "1", position: 0 }] })).toBe("Specific: 1 lot");
    expect(lotPickLabel({ ...row, type: "buy" })).toBeNull();
  });
});

describe("lot picks", () => {
  const lot = (id: string, acquiredDate: string, quantity: string, basis: string | null, closedDate: string | null = null, remaining = quantity): LotView => ({
    id,
    openedByTxnId: `t-${id}`,
    ordinal: 0,
    originLotId: null,
    accountId: ACCOUNT,
    accountName: "Brokerage",
    securityId: VTI.id,
    ticker: "VTI",
    securityName: VTI.name,
    openedBy: "buy",
    acquiredDate,
    originalQuantity: quantity,
    quantity: remaining,
    originalCostBasisCents: basis,
    costBasisCents: basis,
    basisPerShare: null,
    basisKnown: basis !== null,
    closedDate,
    priceDate: null,
    valueCents: null,
    unrealizedCents: null,
    term: "long",
  });
  // b is partly consumed today (remaining 2 of 5), c was bought after the sale, d was closed before it, e was closed by a later sale.
  const lots = [lot("b", "2025-06-01", "5", "50000", null, "2"), lot("a", "2024-01-15", "10", "120000"), lot("c", "2026-11-01", "3", "30000"), lot("d", "2024-02-01", "2", "20000", "2025-01-01", "0"), lot("e", "2024-03-01", "1", "10000", "2026-10-20", "0")];

  it("lists the lots acquired by the sale date and not closed before it, oldest first", () => {
    expect(pickableLots(lots, VTI.id, "2026-10-09").map((l) => l.id)).toEqual(["a", "e", "b"]);
    expect(pickableLots(lots, OTHER, "2026-10-09")).toEqual([]);
  });

  it("validates picks like the route, against the lot's original quantity", () => {
    expect(parseLotPicks({ a: "4", b: "" }, lots, "4")).toEqual({ ok: true, picks: [{ lotId: "a", quantity: "4" }], sumQuantity: "4" });
    expect(parseLotPicks({}, lots, "4")).toEqual({ ok: true, picks: [], sumQuantity: "0" });
    expect(parseLotPicks({ a: "3", b: "2" }, lots, "4")).toEqual({ ok: false, error: "The picks (5) exceed the sale's 4 shares" });
    // b has 2 left today but 5 originally: the picker allows 5 (the route's dry rebuild decides) and refuses 6.
    expect(parseLotPicks({ b: "5" }, lots, "10")).toEqual({ ok: true, picks: [{ lotId: "b", quantity: "5" }], sumQuantity: "5" });
    expect(parseLotPicks({ b: "6" }, lots, "10")).toEqual({ ok: false, error: "A pick exceeds the lot's quantity (5)" });
    expect(parseLotPicks({ a: "-1" }, lots, "10").ok).toBe(false);
    expect(parseLotPicks({ a: "abc" }, lots, "10").ok).toBe(false);
  });

  it("estimates a pick's gain with the engine's basis rounding", () => {
    // 4 of 10 shares with basis 1 200.00 → basis consumed 480.00; proceeds 4 × 130 = 520.00 → gain 40.00
    expect(estimatedLotGain(lots[1]!, "130", "4")).toBe(4000n);
    // 1 of 3 shares at basis 100.00 → 33.33 (3 333.33… rounds half away to 3333); proceeds 50.00 → 16.67
    expect(estimatedLotGain(lot("e", "2024-01-01", "3", "10000"), "50", "1")).toBe(1667n);
    expect(estimatedLotGain(lot("f", "2024-01-01", "3", null), "50", "1")).toBeNull();
    expect(estimatedLotGain(lots[1]!, null, "4")).toBeNull();
  });
});

describe("positions editor", () => {
  const existingRow = (patch: Partial<PositionRowForm>): PositionRowForm => ({ key: "k", securityId: VTI.id, create: null, label: "VTI", quantity: "", price: "", value: "", cost: "", ...patch });

  it("derives the other field", () => {
    expect(derivedValueText("12.75", "250")).toBe("3187.50");
    expect(derivedValueText("5", "48.123")).toBe("240.62");
    expect(derivedValueText("", "250")).toBeNull();
    expect(derivedPriceText("318750", "")).toBeNull();
    expect(derivedPriceText("3,187.50", "12.75")).toBe("250");
    expect(dollarsToCentsSigned("(12.50)")).toBe(-1250n);
    expect(dollarsToCentsSigned("1.005")).toBeNull();
  });

  it("builds rows from a snapshot", () => {
    const rows = positionRowsFromSnapshot({
      rows: [
        { securityId: VTI.id, ticker: "VTI", name: VTI.name, quantity: "12.75", price: "250", valueCents: "318750", reportedCostBasisCents: "260000" },
        { securityId: OTHER, ticker: null, name: "Stable Value", quantity: null, price: null, valueCents: "5000000", reportedCostBasisCents: null },
      ],
    });
    expect(rows.map(({ key: _k, ...r }) => r)).toEqual([
      { securityId: VTI.id, create: null, label: `VTI · ${VTI.name}`, quantity: "12.75", price: "250", value: "3187.50", cost: "2600.00" },
      { securityId: OTHER, create: null, label: "Stable Value", quantity: "", price: "", value: "50000.00", cost: "" },
    ]);
  });

  it("parses rows into ManualPositionInput and sums the values", () => {
    const r = parsePositionRows([
      existingRow({ key: "a", quantity: "12.75", price: "250", cost: "2,600" }),
      existingRow({ key: "b", securityId: null, create: { ticker: "", name: "Stable Value", type: "fund", assetClass: "bonds" }, value: "50,000.00" }),
      existingRow({ key: "c" }),
    ]);
    expect(r).toEqual({
      ok: true,
      positions: [
        { security: { kind: "existing", securityId: VTI.id }, quantity: "12.75", price: "250", costBasisCents: "260000" },
        { security: { kind: "create", security: { ticker: null, cusip: null, isin: null, name: "Stable Value", type: "fund", assetClass: "bonds" } }, valueCents: "5000000" },
      ],
      sumCents: 318750n + 5000000n,
    });
  });

  it("reports row errors mirroring the contract's refinements", () => {
    const bad = parsePositionRows([
      existingRow({ key: "noSec", securityId: null, quantity: "1", price: "1" }),
      existingRow({ key: "noPriceOrValue", quantity: "1" }),
      existingRow({ key: "priceNoQty", price: "250" }),
      existingRow({ key: "badQty", quantity: "-1", value: "10" }),
      existingRow({ key: "badCost", quantity: "1", price: "1", cost: "x" }),
    ]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["badCost", "badQty", "noPriceOrValue", "noSec", "priceNoQty"]);
  });

  it("builds the PUT body with the statement total and notes the cash it implies", () => {
    const rows = [existingRow({ key: "a", quantity: "12.75", price: "250" })];
    const r = buildPositionsBody(rows, "2026-10-13", "3,350.09", TODAY);
    expect(r).toEqual({ ok: true, body: { asOfDate: "2026-10-13", positions: [{ security: { kind: "existing", securityId: VTI.id }, quantity: "12.75", price: "250" }], today: TODAY, statementTotalCents: "335009" }, sumCents: 318750n });
    expect(buildPositionsBody(rows, "2026-10-13", "", TODAY)).toMatchObject({ ok: true, body: { asOfDate: "2026-10-13", today: TODAY } });
    expect(buildPositionsBody(rows, "2027-01-01", "", TODAY)).toMatchObject({ ok: false, error: "The statement date cannot be in the future" });
    expect(buildPositionsBody([existingRow({ key: "z" })], "2026-10-13", "", TODAY)).toMatchObject({ ok: false, error: "Enter at least one position" });
    expect(buildPositionsBody(rows, "2026-10-13", "abc", TODAY)).toMatchObject({ ok: false, error: "The statement total is not a dollar amount" });
    expect(statementTotalNote(318750n, "3,350.09")).toBe("Σ positions $3,187.50 · statement total $3,350.09 · $162.59 of cash the positions omit");
    expect(statementTotalNote(318750n, "3187.50")).toBe("Σ positions $3,187.50 · statement total $3,187.50 · equal");
    expect(statementTotalNote(318750n, "3000")).toBe("Σ positions $3,187.50 · statement total $3,000.00 · positions exceed the statement by $187.50");
    expect(statementTotalNote(318750n, "")).toBeNull();
  });
});
