import { describe, expect, it } from "vitest";
import type { TradesCsvMappingInput } from "./api.js";
import { parseCsv } from "./csv.js";
import { formatFixed8, parseFixed8 } from "./decimal.js";
import {
  actionKey,
  classifyTradeAction,
  CsvImportError,
  guessPositionsMapping,
  guessTradesMapping,
  mapPositionsCsvRows,
  mapTradesCsvRows,
  parseSplitRatio,
  type MappedTrade,
} from "./investmentsCsv.js";

const f = parseFixed8;

// ---------------------------------------------------------------------------
// Positions (imports design §3.6, test 7)
// ---------------------------------------------------------------------------

const FIDELITY_POSITIONS = [
  ["Symbol", "Description", "Quantity", "Last Price", "Current Value", "Cost Basis Total"],
  ["VTI", "VANGUARD TOTAL STOCK MKT ETF", "10.5", "250.00", "$2,625.00", "$2,100.00"],
  ["VTI", "VANGUARD TOTAL STOCK MKT ETF", "2.25", "250.00", "$562.50", "$500.00"],
  ["SPAXX**", "FIDELITY GOVERNMENT MONEY MARKET", "150.25", "1.00", "$150.25", "--"],
  ["Pending Activity", "", "", "", "$12.34", ""],
  ["Account Total", "", "", "", "$3,350.09", ""],
];

const positionsMapping = guessPositionsMapping(FIDELITY_POSITIONS[0]!, FIDELITY_POSITIONS.slice(1, 4))!;

describe("guessPositionsMapping", () => {
  it("guesses the Fidelity-style file with asOf from the request", () => {
    expect(positionsMapping).toEqual({
      hasHeader: true,
      asOf: { mode: "request" },
      symbol: { column: "Symbol" },
      name: { column: "Description" },
      quantity: { column: "Quantity" },
      price: { column: "Last Price" },
      value: { column: "Current Value" },
      costBasis: { column: "Cost Basis Total" },
    });
  });
  it("maps a date column, a cusip and an account column when present", () => {
    const headers = ["Account Number", "As of", "Ticker", "Investment Name", "CUSIP", "Shares", "Market Value"];
    expect(guessPositionsMapping(headers, [["X123", "10/13/2026", "VTI", "Vanguard", "922908769", "1", "250.00"]])).toEqual({
      hasHeader: true,
      asOf: { mode: "column", column: "As of", format: "MM/DD/YYYY" },
      symbol: { column: "Ticker" },
      name: { column: "Investment Name" },
      cusip: { column: "CUSIP" },
      quantity: { column: "Shares" },
      value: { column: "Market Value" },
      accountFilter: { column: "Account Number" },
    });
  });
  it("gives up without an identity column or without any value", () => {
    expect(guessPositionsMapping(["Quantity", "Price"], [])).toBeUndefined();
    expect(guessPositionsMapping(["Symbol", "Quantity"], [])).toBeUndefined();
  });
});

describe("mapPositionsCsvRows", () => {
  it("aggregates sub-lots, normalizes the core-position ticker, skips pending activity and totals (test 7)", () => {
    const result = mapPositionsCsvRows(FIDELITY_POSITIONS, positionsMapping, { asOfDate: "2026-10-13" });
    expect(result.asOf).toBe("2026-10-13");
    expect(result.errors).toEqual([]);
    expect(result.positions).toHaveLength(2);
    expect(result.positions[0]).toEqual({
      rowIndex: 1,
      ticker: "VTI",
      name: "VANGUARD TOTAL STOCK MKT ETF",
      cusip: null,
      quantity: 1_275_000_000n,
      price: 25_000_000_000n,
      valueCents: 318_750n,
      costBasisCents: 260_000n,
      isCash: false,
      warnings: [],
    });
    expect(result.positions[1]).toEqual({
      rowIndex: 3,
      ticker: "SPAXX",
      name: "FIDELITY GOVERNMENT MONEY MARKET",
      cusip: null,
      quantity: 15_025_000_000n,
      price: 100_000_000n,
      valueCents: 15_025n,
      costBasisCents: null,
      isCash: false,
      warnings: ["cost_unreadable"],
    });
    expect(result.skipped).toEqual([
      { rowIndex: 4, reason: "pending_activity" },
      { rowIndex: 5, reason: "totals_row" },
    ]);
    expect(result.pendingActivityCents).toBe(1_234n);
    expect(result.filterValues).toEqual([]);
    expect(result.positions.reduce((acc, p) => acc + p.valueCents, 0n)).toBe(333_775n);
  });

  it("flags a value that disagrees with quantity × price beyond 0.5 % and keeps the file's value", () => {
    const rows = [FIDELITY_POSITIONS[0]!, ["VTI", "VANGUARD TOTAL STOCK MKT ETF", "12.5", "123.456", "$1,600.00", ""]];
    const result = mapPositionsCsvRows(rows, positionsMapping, { asOfDate: "2026-10-13" });
    expect(result.positions[0]).toMatchObject({ valueCents: 160_000n, price: f("123.456"), warnings: ["value_mismatch"] });
  });

  it("reports an unreadable quantity as an error and keeps going", () => {
    const rows = [FIDELITY_POSITIONS[0]!, ["VTI", "x", "abc", "250.00", "$250.00", ""], ["BND", "y", "1", "70.00", "$70.00", ""]];
    const result = mapPositionsCsvRows(rows, positionsMapping, { asOfDate: "2026-10-13" });
    expect(result.errors).toEqual([{ rowIndex: 1, code: "unreadable_quantity", message: 'Unreadable quantity "abc"' }]);
    expect(result.positions.map((p) => p.ticker)).toEqual(["BND"]);
  });

  it("never dates a snapshot by the clock", () => {
    expect(() => mapPositionsCsvRows(FIDELITY_POSITIONS, positionsMapping)).toThrow(CsvImportError);
    try {
      mapPositionsCsvRows(FIDELITY_POSITIONS, positionsMapping);
    } catch (err) {
      expect((err as CsvImportError).code).toBe("as_of_required");
    }
  });

  it("filters a multi-account export and lists the values seen", () => {
    const rows = [
      ["Account Number", "Symbol", "Description", "Quantity", "Last Price", "Current Value"],
      ["X123", "VTI", "Vanguard", "1", "250.00", "$250.00"],
      ["Z999", "BND", "Bond fund", "2", "70.00", "$140.00"],
      ["X123", "Pending Activity", "", "", "", "$1.00"],
      ["Z999", "Pending Activity", "", "", "", "$5.00"],
    ];
    const mapping = guessPositionsMapping(rows[0]!, rows.slice(1))!;
    expect(mapping.accountFilter).toEqual({ column: "Account Number" });
    const result = mapPositionsCsvRows(rows, mapping, { asOfDate: "2026-10-13", accountFilterValue: "X123" });
    expect(result.positions.map((p) => p.ticker)).toEqual(["VTI"]);
    expect(result.skipped).toEqual([
      { rowIndex: 2, reason: "other_account" },
      { rowIndex: 3, reason: "pending_activity" },
      { rowIndex: 4, reason: "other_account" },
    ]);
    expect(result.pendingActivityCents).toBe(100n);
    expect(result.filterValues).toEqual(["X123", "Z999"]);
    // Without a chosen value nothing is filtered, so the UI can offer the values first.
    expect(mapPositionsCsvRows(rows, mapping, { asOfDate: "2026-10-13" }).positions).toHaveLength(2);
  });

  it("reads the as-of date from a column and refuses a file that mixes dates", () => {
    const rows = [
      ["As of", "Symbol", "Quantity", "Price"],
      ["10/13/2026", "VTI", "1", "250.00"],
      ["10/13/2026", "BND", "2", "70.00"],
      ["10/12/2026", "VXUS", "3", "60.00"],
      ["nope", "VEA", "3", "60.00"],
    ];
    const result = mapPositionsCsvRows(rows, { asOf: { mode: "column", column: "As of", format: "MM/DD/YYYY" }, symbol: { column: "Symbol" }, quantity: { column: "Quantity" }, price: { column: "Price" } });
    expect(result.asOf).toBe("2026-10-13");
    expect(result.positions.map((p) => [p.ticker, p.valueCents])).toEqual([
      ["VTI", 25_000n],
      ["BND", 14_000n],
    ]);
    expect(result.errors.map((e) => [e.rowIndex, e.code])).toEqual([
      [3, "asof_mixed"],
      [4, "unreadable_date"],
    ]);
  });

  it("accepts dollar-only rows, name-only identities, cash rows and skips footers", () => {
    const rows = [
      ["Investment Name", "Quantity", "Price", "Market Value", "Cost Basis"],
      ["Vanguard Target Retirement 2045 Trust Plus", "", "", "$12,345.67", "$10,000.00"],
      ["Cash & Cash Investments", "", "", "$150.25", ""],
      ["Some Fund", "10", "", "$1,000.00", "$900.005"],
      ["Closed Fund", "0", "", "$0.00", ""],
      ["The data and information in this spreadsheet is provided to you solely for your use", "", "", "", ""],
      ["", "", "", "", ""],
    ];
    const mapping = guessPositionsMapping(rows[0]!, rows.slice(1))!;
    expect(mapping.name).toEqual({ column: "Investment Name" });
    expect(mapping.symbol).toBeUndefined();
    const result = mapPositionsCsvRows(rows, mapping, { asOfDate: "2026-10-13" });
    expect(result.errors).toEqual([]);
    expect(result.positions).toEqual([
      {
        rowIndex: 1,
        ticker: null,
        name: "Vanguard Target Retirement 2045 Trust Plus",
        cusip: null,
        quantity: null,
        price: null,
        valueCents: 1_234_567n,
        costBasisCents: 1_000_000n,
        isCash: false,
        warnings: ["dollar_only"],
      },
      { rowIndex: 2, ticker: null, name: "Cash & Cash Investments", cusip: null, quantity: 15_025_000_000n, price: 100_000_000n, valueCents: 15_025n, costBasisCents: null, isCash: true, warnings: [] },
      { rowIndex: 3, ticker: null, name: "Some Fund", cusip: null, quantity: f("10"), price: f("100"), valueCents: 100_000n, costBasisCents: 90_001n, isCash: false, warnings: ["cost_rounded"] },
    ]);
    expect(result.skipped).toEqual([
      { rowIndex: 4, reason: "zero_position" },
      { rowIndex: 5, reason: "totals_row" },
    ]);
    expect(result.positions[1]!.quantity).toBe(f("150.25"));
  });

  it("implies the aggregated price when sub-lots carry different prices and sums dollar-only rows to a null quantity", () => {
    const rows = [
      ["Symbol", "Quantity", "Price", "Current Value"],
      ["VTI", "10", "250.00", "$2,500.00"],
      ["VTI", "2", "251.00", "$502.00"],
      ["POOL", "", "", "$100.00"],
      ["POOL", "", "", "$50.00"],
    ];
    const result = mapPositionsCsvRows(rows, { asOf: { mode: "request" }, symbol: { column: "Symbol" }, quantity: { column: "Quantity" }, price: { column: "Price" }, value: { column: "Current Value" } }, { asOfDate: "2026-10-13" });
    expect(result.positions[0]).toMatchObject({ ticker: "VTI", quantity: f("12"), valueCents: 300_200n });
    expect(formatFixed8(result.positions[0]!.price!)).toBe("250.16666667");
    expect(result.positions[1]).toMatchObject({ ticker: "POOL", quantity: null, price: null, valueCents: 15_000n, warnings: ["dollar_only"] });
  });
});

// ---------------------------------------------------------------------------
// Trades: classification (imports design §3.8, test 10)
// ---------------------------------------------------------------------------

const defaults = { actionMap: {}, reinvestRows: "separate" as const };
const qty = { hasQuantity: true, amountSign: -1 as const };
const noQty = { hasQuantity: false, amountSign: 1 as const };

describe("classifyTradeAction", () => {
  it("classifies the design's cases with the default mapping", () => {
    expect(classifyTradeAction("YOU BOUGHT", "", qty, defaults)).toBe("buy");
    expect(classifyTradeAction("Sold", "", qty, defaults)).toBe("sell");
    expect(classifyTradeAction("DIVIDEND RECEIVED", "", noQty, defaults)).toBe("dividend");
    expect(classifyTradeAction("REINVESTMENT", "", qty, defaults)).toBe("reinvest");
    expect(classifyTradeAction("Reinvest Dividend", "", noQty, defaults)).toBe("dividend");
    expect(classifyTradeAction("Reinvest Shares", "", qty, defaults)).toBe("reinvest");
    expect(classifyTradeAction("QUALIFIED DIVIDEND", "", noQty, defaults)).toBe("dividend");
    expect(classifyTradeAction("INTEREST", "FDIC INTEREST", noQty, defaults)).toBe("interest");
    expect(classifyTradeAction("Bank Interest", "", noQty, defaults)).toBe("interest");
    expect(classifyTradeAction("", "ADR FEE", noQty, defaults)).toBe("fee");
    expect(classifyTradeAction("Stock Split", "2 FOR 1", noQty, defaults)).toBe("split");
    expect(classifyTradeAction("Reverse Split", "1:10", noQty, defaults)).toBe("split");
    expect(classifyTradeAction("TRANSFER OF SHARES", "RECEIVED FROM XYZ", qty, defaults)).toBe("transfer_in");
    expect(classifyTradeAction("JOURNAL", "DELIVERED TO 1234", qty, defaults)).toBe("transfer_out");
    expect(classifyTradeAction("JOURNAL", "SHARES RECEIVED INTO ACCOUNT 1234", qty, defaults)).toBe("transfer_in");
    expect(classifyTradeAction("ELECTRONIC FUNDS TRANSFER RECEIVED", "", noQty, defaults)).toBe("cash_in");
    expect(classifyTradeAction("WITHDRAWAL", "", noQty, defaults)).toBe("cash_out");
    expect(classifyTradeAction("Buy to Cover", "", qty, defaults)).toBe("buy");
    expect(classifyTradeAction("Sweep", "CORE FUND PURCHASE", noQty, defaults)).toBe("skip");
    expect(classifyTradeAction("Foo", "Bar", noQty, defaults)).toBeUndefined();
    expect(classifyTradeAction("JOURNALED SPP PURCHASE CREDIT (Cash)", "", { hasQuantity: false, amountSign: 0 }, defaults)).toBeUndefined();
    expect(classifyTradeAction("IRA DISTRIBUTION", "", noQty, defaults)).toBeUndefined();
    expect(classifyTradeAction("LONG-TERM CAP GAIN DISTRIBUTION", "", noQty, defaults)).toBe("dividend");
  });
  it("reads a reinvest-looking share row as both legs only when the institution combines them", () => {
    expect(classifyTradeAction("Dividend Reinvestment", "", { hasQuantity: true, amountSign: 1 }, { ...defaults, reinvestRows: "combined" })).toBe("reinvest_combined");
    expect(classifyTradeAction("Dividend Reinvestment", "", { hasQuantity: true, amountSign: 1 }, defaults)).toBe("reinvest");
  });
  it("consults the action map first: exact key, then the longest prefix", () => {
    expect(classifyTradeAction("JOURNALED SPP PURCHASE CREDIT (Cash)", "", noQty, { ...defaults, actionMap: { journaled: "skip" } })).toBe("skip");
    expect(classifyTradeAction("Foo", "Bar", noQty, { ...defaults, actionMap: { foo: "fee" } })).toBe("fee");
    expect(classifyTradeAction("Journaled Cash Out", "", noQty, { ...defaults, actionMap: { journaled: "skip", "journaled cash": "cash_out" } })).toBe("cash_out");
    expect(classifyTradeAction("YOU BOUGHT", "", qty, { ...defaults, actionMap: { "you bought": "transfer_in" } })).toBe("transfer_in");
  });
  it("does not let a fund's name decide the kind on a Fidelity-style action line", () => {
    const row = { hasQuantity: true, amountSign: -1 as const, securityName: "SCHWAB US DIVIDEND EQUITY ETF", ticker: "SCHD" };
    expect(classifyTradeAction("YOU BOUGHT SCHWAB US DIVIDEND EQUITY ETF (SCHD) (Cash)", "", row, defaults)).toBe("buy");
    expect(classifyTradeAction("DIVIDEND RECEIVED SCHWAB US DIVIDEND EQUITY ETF (SCHD) (Cash)", "", { ...row, hasQuantity: false }, defaults)).toBe("dividend");
    expect(classifyTradeAction("YOU SOLD GLOBAL X SUPERDIVIDEND (DIV) (Cash)", "", { hasQuantity: true, amountSign: 1, securityName: "GLOBAL X SUPERDIVIDEND", ticker: "DIV" }, defaults)).toBe("sell");
  });
  it("normalizes action keys and parses split ratios", () => {
    expect(actionKey("  You   Bought ")).toBe("you bought");
    expect(parseSplitRatio("STOCK SPLIT 2 FOR 1")).toEqual({ num: 2, den: 1 });
    expect(parseSplitRatio("2-for-1 split")).toEqual({ num: 2, den: 1 });
    expect(parseSplitRatio("REVERSE SPLIT 1:10")).toEqual({ num: 1, den: 10 });
    expect(parseSplitRatio("SPLIT 3/2")).toEqual({ num: 3, den: 2 });
    expect(parseSplitRatio("SPLIT EFFECTIVE 10/13/2026")).toBeUndefined();
    expect(parseSplitRatio("SPLIT")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Trades: mapping rows (tests 10–12)
// ---------------------------------------------------------------------------

const HEADER = ["Date", "Action", "Symbol", "Quantity", "Price", "Fees", "Amount"];
const tradesMapping: TradesCsvMappingInput = {
  hasHeader: true,
  date: { column: "Date", format: "YYYY-MM-DD" },
  action: { column: "Action" },
  symbol: { column: "Symbol" },
  quantity: { column: "Quantity" },
  price: { column: "Price" },
  fee: { columns: ["Fees"] },
  amount: { column: "Amount" },
};

function pick(t: MappedTrade) {
  return { date: t.date, type: t.type, kind: t.kind, ticker: t.ticker, quantity: t.quantity, price: t.price, amountCents: t.amountCents, feeCents: t.feeCents, derived: t.derived, warnings: t.warnings };
}

describe("mapTradesCsvRows: row rules (test 10)", () => {
  it("takes |quantity|, forces the sign by type and derives the missing amount or price", async () => {
    const rows = [
      HEADER,
      ["2026-10-01", "YOU BOUGHT", "VTI", "-10", "250.00", "", "-2,500.00"],
      ["2026-10-05", "Sold", "VTI", "4", "249.65", "0", "998.60"],
      ["2026-10-02", "YOU BOUGHT", "ABC", "5", "48.123", "4.95", ""],
      ["2026-10-03", "Sold", "ABC", "5", "", "0", "240.00"],
      ["2026-10-04", "Sold", "ABC", "5", "", "", ""],
      ["2026-10-06", "DIVIDEND RECEIVED", "", "", "", "", "12.34"],
    ];
    const result = await mapTradesCsvRows(rows, { ...tradesMapping, amount: { column: "Amount", invert: true } });
    expect(result.rowOrder).toBe("oldest_first");
    expect(result.trades.map(pick)).toEqual([
      { date: "2026-10-01", type: "buy", kind: "buy", ticker: "VTI", quantity: 1_000_000_000n, price: 25_000_000_000n, amountCents: -250_000n, feeCents: 0n, derived: [], warnings: [] },
      { date: "2026-10-02", type: "buy", kind: "buy", ticker: "ABC", quantity: f("5"), price: f("48.123"), amountCents: -24_557n, feeCents: 495n, derived: ["amount"], warnings: [] },
      { date: "2026-10-03", type: "sell", kind: "sell", ticker: "ABC", quantity: f("5"), price: f("48"), amountCents: 24_000n, feeCents: 0n, derived: ["price"], warnings: [] },
      { date: "2026-10-05", type: "sell", kind: "sell", ticker: "VTI", quantity: f("4"), price: f("249.65"), amountCents: 99_860n, feeCents: 0n, derived: [], warnings: [] },
    ]);
    expect(result.errors).toEqual([
      { rowIndex: 5, code: "amount_or_price_required", message: "An amount or a price is required with a quantity" },
      { rowIndex: 6, code: "security_required", message: "A dividend needs a security (map the action to interest if it is cash interest)" },
    ]);
    expect(result.unknownActions).toBe(0);
  });

  it("sums commission and fee columns and adds them to a principal-only amount", async () => {
    const rows = [
      ["Run Date", "Action", "Symbol", "Quantity", "Price ($)", "Commission ($)", "Fees ($)", "Amount ($)"],
      ["10/02/2026", "YOU BOUGHT", "VTI", "10", "123.45", "4.95", "0.02", "-1234.50"],
    ];
    const includes = await mapTradesCsvRows(rows, {
      date: { column: "Run Date", format: "MM/DD/YYYY" },
      action: { column: "Action" },
      symbol: { column: "Symbol" },
      quantity: { column: "Quantity" },
      price: { column: "Price ($)" },
      fee: { columns: ["Commission ($)", "Fees ($)"] },
      amount: { column: "Amount ($)" },
      amountIncludesFees: false,
    });
    expect(pick(includes.trades[0]!)).toMatchObject({ amountCents: -123_947n, feeCents: 497n, derived: [], warnings: [] });
    const principal = await mapTradesCsvRows(rows, {
      date: { column: "Run Date", format: "MM/DD/YYYY" },
      action: { column: "Action" },
      symbol: { column: "Symbol" },
      quantity: { column: "Quantity" },
      price: { column: "Price ($)" },
      fee: { columns: ["Commission ($)", "Fees ($)"] },
      amount: { column: "Amount ($)" },
    });
    // With the amount already including fees, the file's −1234.50 disagrees with 10 × 123.45 + 4.97 by more than 5 cents.
    expect(pick(principal.trades[0]!)).toMatchObject({ amountCents: -123_450n, feeCents: 497n, warnings: ["amount_mismatch"] });
  });

  it("flags an amount that disagrees with quantity × price ± fee by more than 5 cents", async () => {
    const rows = [HEADER, ["2026-10-09", "YOU SOLD", "VTI", "-4", "130.00", "0.02", "519.98"], ["2026-10-09", "YOU SOLD", "VTI", "-4", "130.00", "0.02", "519.90"]];
    const result = await mapTradesCsvRows(rows, tradesMapping);
    expect(result.trades.map((t) => [t.amountCents, t.feeCents, t.warnings])).toEqual([
      [51_998n, 2n, []],
      [51_990n, 2n, ["amount_mismatch"]],
    ]);
  });

  it("handles income, fees, splits, share transfers and cash transfers", async () => {
    const rows = [
      HEADER,
      ["2026-10-01", "ELECTRONIC FUNDS TRANSFER RECEIVED", "", "", "", "", "5000.00"],
      ["2026-10-02", "WITHDRAWAL", "", "", "", "", "-100.00"],
      ["2026-10-03", "Bank Interest", "", "", "", "", "1.23"],
      ["2026-10-04", "DIVIDEND RECEIVED", "VTI", "", "", "", "-12.34"],
      ["2026-10-04", "DIVIDEND REVERSAL", "VTI", "", "", "", "-12.34"],
      ["2026-10-05", "ADR FEE", "VTI", "", "", "", "-0.50"],
      ["2026-10-05", "FEE CHARGED", "VTI", "", "", "0.75", ""],
      ["2026-10-06", "Stock Split", "VTI", "10", "", "", ""],
      ["2026-10-06", "Stock Split", "BND", "", "", "", ""],
      ["2026-10-07", "TRANSFER OF SHARES RECEIVED", "VTI", "3", "250.00", "", ""],
      ["2026-10-08", "JOURNAL DELIVERED TO 1234", "VTI", "-2", "", "", ""],
      ["2026-10-09", "JOURNALED CASH", "", "", "", "", "0.00"],
    ];
    const result = await mapTradesCsvRows(rows, tradesMapping, { choices: [{ rowIndex: 8, split: { num: 2, den: 1 } }] });
    const byRow = new Map(result.trades.map((t) => [t.rowIndex, t]));
    expect(byRow.get(1)).toMatchObject({ type: "transfer", kind: "cash_in", transferDirection: "in", ticker: null, name: null, quantity: null, amountCents: 500_000n, rawDescription: "ELECTRONIC FUNDS TRANSFER RECEIVED" });
    expect(byRow.get(2)).toMatchObject({ type: "transfer", kind: "cash_out", transferDirection: "out", amountCents: -10_000n });
    expect(byRow.get(3)).toMatchObject({ type: "interest", ticker: null, amountCents: 123n });
    expect(byRow.get(4)).toMatchObject({ type: "dividend", ticker: "VTI", amountCents: 1_234n, warnings: ["sign_forced"] });
    expect(byRow.get(5)).toMatchObject({ type: "dividend", amountCents: -1_234n, warnings: [] });
    expect(byRow.get(6)).toMatchObject({ type: "fee", amountCents: -50n, feeCents: 0n, derived: [] });
    expect(byRow.get(7)).toMatchObject({ type: "fee", amountCents: -75n, feeCents: 75n, derived: ["amount"] });
    expect(byRow.get(8)).toMatchObject({ type: "split", splitNum: 2, splitDen: 1, quantity: f("10"), amountCents: 0n, price: null });
    expect(byRow.get(9)).toBeUndefined();
    expect(byRow.get(10)).toMatchObject({ type: "transfer", kind: "transfer_in", transferDirection: "in", quantity: f("3"), price: f("250"), amountCents: 0n });
    expect(byRow.get(11)).toMatchObject({ type: "transfer", kind: "transfer_out", transferDirection: "out", quantity: f("2"), price: null, amountCents: 0n });
    expect(result.errors).toEqual([{ rowIndex: 9, code: "split_ratio_required", message: "The split ratio (new for old) is not in the text; choose it in the preview" }]);
    expect(result.skipped).toEqual([{ rowIndex: 12, reason: "skip", text: "JOURNALED CASH" }]);
    expect(result.trades.filter((t) => t.date === "2026-10-04").map((t) => t.sequence)).toEqual([0, 1]);
  });

  it("requires a quantity for trades and share transfers", async () => {
    const rows = [HEADER, ["2026-10-01", "YOU BOUGHT", "VTI", "0", "250.00", "", "-2500.00"], ["2026-10-02", "TRANSFER OF SHARES RECEIVED", "VTI", "", "", "", ""]];
    const result = await mapTradesCsvRows(rows, { ...tradesMapping, actionMap: { "you bought": "buy", "transfer of shares received": "transfer_in" } });
    expect(result.errors.map((e) => e.code)).toEqual(["quantity_required", "quantity_required"]);
    expect(result.actionsFound.every((a) => a.fromProfile)).toBe(true);
  });

  it("lists unknown actions by key with a sample and refuses nothing silently", async () => {
    const rows = [HEADER, ["2026-10-01", "Foo", "", "", "", "", "1.00"], ["2026-10-02", "FOO", "", "", "", "", "2.00"], ["2026-10-03", "Bar", "VTI", "1", "", "", "-5.00"]];
    const result = await mapTradesCsvRows(rows, tradesMapping);
    expect(result.trades).toEqual([]);
    expect(result.unknownActions).toBe(2);
    expect(result.actionsFound).toEqual([
      { key: "foo", sample: "Foo", count: 2, kind: null, fromProfile: false, sampleRowIndex: 1 },
      { key: "bar", sample: "Bar", count: 1, kind: null, fromProfile: false, sampleRowIndex: 3 },
    ]);
    const mapped = await mapTradesCsvRows(rows, { ...tradesMapping, actionMap: { foo: "interest", bar: "skip" } });
    expect(mapped.unknownActions).toBe(0);
    expect(mapped.trades.map((t) => t.type)).toEqual(["interest", "interest"]);
    expect(mapped.skipped).toEqual([{ rowIndex: 3, reason: "skip", text: "Bar" }]);
    expect(mapped.actionsFound.map((a) => [a.key, a.kind, a.fromProfile])).toEqual([
      ["foo", "interest", true],
      ["bar", "skip", true],
    ]);
  });

  it("filters other accounts, skips statement footers and reports unreadable dates", async () => {
    const rows = [
      ["Account", ...HEADER],
      ["X123", "2026-10-01", "YOU BOUGHT", "VTI", "1", "250.00", "", "-250.00"],
      ["Z999", "2026-10-01", "YOU BOUGHT", "BND", "1", "70.00", "", "-70.00"],
      ["", "The data and information in this spreadsheet is provided to you solely for your use", "", "", "", "", "", ""],
      ["X123", "bad", "YOU BOUGHT", "VTI", "1", "250.00", "", "-250.00"],
    ];
    const result = await mapTradesCsvRows(rows, { ...tradesMapping, accountFilter: { column: "Account" } }, { accountFilterValue: "X123" });
    expect(result.trades.map((t) => t.ticker)).toEqual(["VTI"]);
    expect(result.filterValues).toEqual(["X123", "Z999"]);
    expect(result.skipped).toEqual([
      { rowIndex: 2, reason: "other_account", text: "YOU BOUGHT" },
      { rowIndex: 3, reason: "footer", text: "The data and information in this spreadsheet is provided to you solely for your use" },
    ]);
    expect(result.errors).toEqual([{ rowIndex: 4, code: "unreadable_date", message: 'Unreadable date "bad"' }]);
  });
});

describe("mapTradesCsvRows: stable ids and the two reinvest conventions (test 11)", () => {
  const BUY = ["2026-10-01", "YOU BOUGHT", "VTI", "10", "250.00", "", "-2500.00"];
  const DIV = ["2026-09-15", "DIVIDEND RECEIVED", "VTI", "", "", "", "12.34"];
  const REINV = ["2026-09-15", "REINVESTMENT", "VTI", "0.0523", "", "", "-12.34"];
  const SELL = ["2026-10-05", "Sold", "VTI", "4", "249.65", "0", "998.60"];
  const ID_BUY = "inv:bf027e8fe6751b5f9f78153eb9203337d9c774ca457f722f5e6856f301fa1cf0";
  const ID_DIV = "inv:1b5dee9faca1b69be9c22b24de4d893acb547d73d083f14dfbb4c5728aa1e294";
  const ID_REINV = "inv:5d65e799012bb0146bb1180d2ca7987ddd9e74db98817d57f22961200c581c2c";
  const ID_SELL = "inv:38638c9dc3e6f19929e61e0fd5a3841ad5aed967fddc90a1a233dbd75687955a";

  it("reproduces the design's SHA-256 ids with an ordinal for identical rows", async () => {
    const result = await mapTradesCsvRows([HEADER, BUY, BUY, DIV, REINV, SELL], tradesMapping);
    expect(result.rowOrder).toBe("oldest_first");
    expect(result.trades.map((t) => [t.date, t.type, t.sequence, t.externalId])).toEqual([
      ["2026-09-15", "dividend", 0, ID_DIV],
      ["2026-09-15", "reinvest", 1, ID_REINV],
      ["2026-10-01", "buy", 0, ID_BUY],
      ["2026-10-01", "buy", 1, `${ID_BUY}:1`],
      ["2026-10-05", "sell", 0, ID_SELL],
    ]);
    const reinvest = result.trades[1]!;
    expect(reinvest).toMatchObject({ amountCents: -1_234n, quantity: 5_230_000n, derived: ["price"], warnings: [] });
    expect(formatFixed8(reinvest.price!)).toBe("235.94646272");
    expect(result.trades[0]).toMatchObject({ amountCents: 1_234n, quantity: null, price: null });
    expect(result.trades[4]).toMatchObject({ amountCents: 99_860n });
  });

  it("yields the same two rows and ids from a single combined DRIP line", async () => {
    const COMBINED = ["2026-09-15", "Dividend Reinvested", "VTI", "0.0523", "", "", "12.34"];
    const combined = await mapTradesCsvRows([HEADER, BUY, BUY, COMBINED, SELL], { ...tradesMapping, reinvestRows: "combined" });
    expect(combined.trades.map((t) => [t.type, t.kind, t.sequence, t.externalId, t.amountCents])).toEqual([
      ["dividend", "reinvest_combined", 0, ID_DIV, 1_234n],
      ["reinvest", "reinvest_combined", 1, ID_REINV, -1_234n],
      ["buy", "buy", 0, ID_BUY, -250_000n],
      ["buy", "buy", 1, `${ID_BUY}:1`, -250_000n],
      ["sell", "sell", 0, ID_SELL, 99_860n],
    ]);
    expect(combined.trades[1]).toMatchObject({ quantity: 5_230_000n, derived: ["price"] });
    expect(formatFixed8(combined.trades[1]!.price!)).toBe("235.94646272");
    expect(combined.trades[0]).toMatchObject({ quantity: null, price: null, feeCents: 0n });

    const separate = await mapTradesCsvRows([HEADER, BUY, BUY, COMBINED, SELL], tradesMapping);
    expect(separate.trades.map((t) => [t.type, t.externalId])).toEqual([
      ["reinvest", ID_REINV],
      ["buy", ID_BUY],
      ["buy", `${ID_BUY}:1`],
      ["sell", ID_SELL],
    ]);
    expect(separate.trades[0]!.warnings).toEqual(["reinvest_without_dividend"]);
  });

  it("uses the file's id when it has one, split into two halves for a combined row", async () => {
    const rows = [[...HEADER, "Id"], [...BUY, "T0"], ["2026-09-15", "Dividend Reinvested", "VTI", "0.0523", "", "", "12.34", "T1"]];
    const result = await mapTradesCsvRows(rows, { ...tradesMapping, reinvestRows: "combined", externalId: { column: "Id" } });
    expect(result.trades.map((t) => t.externalId)).toEqual(["csvid:T1:div", "csvid:T1:buy", "csvid:T0"]);
  });

  it("changes sequences but never ids when the file is reordered", async () => {
    const result = await mapTradesCsvRows([HEADER, SELL, REINV, DIV, BUY, BUY], { ...tradesMapping, rowOrder: "oldest_first" });
    expect(result.trades.map((t) => [t.type, t.sequence])).toEqual([
      ["reinvest", 0],
      ["dividend", 1],
      ["buy", 0],
      ["buy", 1],
      ["sell", 0],
    ]);
    expect(new Set(result.trades.map((t) => t.externalId))).toEqual(new Set([ID_DIV, ID_REINV, ID_BUY, `${ID_BUY}:1`, ID_SELL]));
  });
});

describe("mapTradesCsvRows: row order and same-day sequence (test 12)", () => {
  const mapping: TradesCsvMappingInput = { ...tradesMapping, date: { column: "Date", format: "MM/DD/YYYY" } };
  const SELL = ["10/05/2026", "Sold", "VTI", "4", "249.65", "", "998.60"];
  const BUY4 = ["10/05/2026", "YOU BOUGHT", "VTI", "4", "249.00", "", "-996.00"];
  const BUY10 = ["10/01/2026", "YOU BOUGHT", "VTI", "10", "250.00", "", "-2500.00"];

  it("resolves a newest-first file and replays buy before sell on the same day", async () => {
    const result = await mapTradesCsvRows([HEADER, SELL, BUY4, BUY10], mapping);
    expect(result.rowOrder).toBe("newest_first");
    expect(result.trades.map((t) => [t.date, t.type, t.sequence])).toEqual([
      ["2026-10-01", "buy", 0],
      ["2026-10-05", "buy", 0],
      ["2026-10-05", "sell", 1],
    ]);
  });
  it("gives the same sequences to the same rows in oldest-first order", async () => {
    const result = await mapTradesCsvRows([HEADER, BUY10, BUY4, SELL], mapping);
    expect(result.rowOrder).toBe("oldest_first");
    expect(result.trades.map((t) => [t.date, t.type, t.sequence])).toEqual([
      ["2026-10-01", "buy", 0],
      ["2026-10-05", "buy", 0],
      ["2026-10-05", "sell", 1],
    ]);
  });
  it("honours a forced order", async () => {
    const result = await mapTradesCsvRows([HEADER, SELL, BUY4, BUY10], { ...mapping, rowOrder: "oldest_first" });
    expect(result.rowOrder).toBe("oldest_first");
    expect(result.trades.map((t) => [t.date, t.type, t.sequence])).toEqual([
      ["2026-10-01", "buy", 0],
      ["2026-10-05", "sell", 0],
      ["2026-10-05", "buy", 1],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The Fidelity-shaped worked example (§3.8) through the guesser
// ---------------------------------------------------------------------------

const FIDELITY_HISTORY = `Run Date,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
10/12/2026,JOURNALED SPP PURCHASE CREDIT (Cash),,No Description,Cash,,,,,,0.00,
10/09/2026,YOU SOLD VANGUARD TOTAL STOCK MKT ETF (VTI) (Cash),VTI,VANGUARD TOTAL STOCK MKT ETF,Cash,-4,130.00,,0.02,,519.98,10/13/2026
10/06/2026,REINVESTMENT VANGUARD TOTAL STOCK MKT ETF (VTI) (Cash),VTI,VANGUARD TOTAL STOCK MKT ETF,Cash,0.1,123.40,,,,-12.34,
10/05/2026,DIVIDEND RECEIVED VANGUARD TOTAL STOCK MKT ETF (VTI) (Cash),VTI,VANGUARD TOTAL STOCK MKT ETF,Cash,,,,,,12.34,
10/02/2026,YOU BOUGHT VANGUARD TOTAL STOCK MKT ETF (VTI) (Cash),VTI,VANGUARD TOTAL STOCK MKT ETF,Cash,10,123.45,,,,-1234.50,10/06/2026
10/01/2026,ELECTRONIC FUNDS TRANSFER RECEIVED (Cash),,No Description,Cash,,,,,,5000.00,

"The data and information in this spreadsheet is provided to you solely for your use and is not for distribution."
`;

describe("guessTradesMapping and the Fidelity-shaped file", () => {
  const rows = parseCsv(FIDELITY_HISTORY);
  const guessed = guessTradesMapping(rows[0]!, rows.slice(1, 6))!;

  it("guesses the Fidelity headers, summing both fee columns", () => {
    expect(guessed).toEqual({
      hasHeader: true,
      date: { column: "Run Date", format: "MM/DD/YYYY" },
      action: { column: "Action" },
      symbol: { column: "Symbol" },
      name: { column: "Description" },
      quantity: { column: "Quantity" },
      price: { column: "Price ($)" },
      amount: { column: "Amount ($)", invert: false },
      amountIncludesFees: true,
      fee: { columns: ["Commission ($)", "Fees ($)"] },
    });
  });
  it("reads a principal-amount file as fees-separate and finds an id column", () => {
    expect(guessTradesMapping(["Trade Date", "Transaction Type", "Ticker", "Shares", "Unit Price", "Principal Amount", "Commission", "Confirmation"], [["2026-10-01"]])).toEqual({
      hasHeader: true,
      date: { column: "Trade Date", format: "YYYY-MM-DD" },
      action: { column: "Transaction Type" },
      symbol: { column: "Ticker" },
      quantity: { column: "Shares" },
      price: { column: "Unit Price" },
      amount: { column: "Principal Amount", invert: false },
      amountIncludesFees: false,
      fee: { columns: ["Commission"] },
      externalId: { column: "Confirmation" },
    });
    expect(guessTradesMapping(["Date", "Description", "Amount"], [])).toBeUndefined();
    expect(guessTradesMapping(["Action", "Symbol"], [])).toBeUndefined();
  });
  it("maps the worked example: newest-first, signs forced, the journal line left for the owner", async () => {
    const result = await mapTradesCsvRows(rows, guessed);
    expect(result.rowOrder).toBe("newest_first");
    expect(result.trades.map(pick)).toEqual([
      { date: "2026-10-01", type: "transfer", kind: "cash_in", ticker: null, quantity: null, price: null, amountCents: 500_000n, feeCents: 0n, derived: [], warnings: [] },
      { date: "2026-10-02", type: "buy", kind: "buy", ticker: "VTI", quantity: f("10"), price: f("123.45"), amountCents: -123_450n, feeCents: 0n, derived: [], warnings: [] },
      { date: "2026-10-05", type: "dividend", kind: "dividend", ticker: "VTI", quantity: null, price: null, amountCents: 1_234n, feeCents: 0n, derived: [], warnings: [] },
      { date: "2026-10-06", type: "reinvest", kind: "reinvest", ticker: "VTI", quantity: f("0.1"), price: f("123.4"), amountCents: -1_234n, feeCents: 0n, derived: [], warnings: [] },
      { date: "2026-10-09", type: "sell", kind: "sell", ticker: "VTI", quantity: f("4"), price: f("130"), amountCents: 51_998n, feeCents: 2n, derived: [], warnings: [] },
    ]);
    expect(result.trades.every((t) => t.sequence === 0)).toBe(true);
    expect(result.trades[0]!.transferDirection).toBe("in");
    expect(result.trades[1]!.name).toBe("VANGUARD TOTAL STOCK MKT ETF");
    expect(result.unknownActions).toBe(1);
    expect(result.actionsFound.find((a) => a.kind === null)).toEqual({ key: "journaled spp purchase credit (cash)", sample: "JOURNALED SPP PURCHASE CREDIT (Cash)", count: 1, kind: null, fromProfile: false, sampleRowIndex: 1 });
    expect(result.skipped).toEqual([{ rowIndex: 7, reason: "footer", text: "The data and information in this spreadsheet is provided to you solely for your use and is not for distribution." }]);
    expect(result.errors).toEqual([]);
  });
  it("adds a commission to the buy when the amount is the principal, and the owner's action map skips the journal", async () => {
    const withCommission = rows.map((r, i) => (i === 5 ? r.map((c, j) => (j === 7 ? "4.95" : c)) : r));
    const result = await mapTradesCsvRows(withCommission, { ...guessed, amountIncludesFees: false, actionMap: { journaled: "skip" } });
    const buy = result.trades.find((t) => t.type === "buy")!;
    expect(buy).toMatchObject({ amountCents: -123_945n, feeCents: 495n, warnings: [] });
    expect(result.unknownActions).toBe(0);
    expect(result.skipped[0]).toEqual({ rowIndex: 1, reason: "skip", text: "JOURNALED SPP PURCHASE CREDIT (Cash)" });
    expect(result.actionsFound.find((a) => a.key.startsWith("journaled"))).toMatchObject({ kind: "skip", fromProfile: true });
  });
});
