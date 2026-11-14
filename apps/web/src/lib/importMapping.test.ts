import { describe, expect, it } from "vitest";
import type { CsvMappingInput, PositionsCsvMapping, TradesCsvMapping } from "@meridian/shared";
import {
  bankColumnOptions,
  bankFirstRow,
  bankPreviewBody,
  bankResultText,
  columnRef,
  columnValue,
  csvKindFromParam,
  firstRowLooksLikeData,
  groupTradesByDate,
  handBuiltBankMapping,
  handBuiltPositionsMapping,
  handBuiltTradesMapping,
  hasFeeColumn,
  positionsCommitLabel,
  positionsMappingIssues,
  positionsPreviewBody,
  positionsResultText,
  previewWarningText,
  reconciliationLine,
  rowOrderText,
  securityBadge,
  setActionKind,
  setBankAmountMode,
  setBankColumn,
  setBankHasHeader,
  setPositionsAsOf,
  setPositionsColumn,
  setTradesAmount,
  setTradesColumn,
  snapshotBar,
  sortActions,
  toggleFeeColumn,
  tradeRowMarker,
  tradesCommitLabel,
  tradesMappingIssues,
  tradesPreviewBody,
  tradesResultText,
  unknownActionsText,
  unreadableDateText,
} from "./importMapping.js";

const FID_HEADERS = ["Symbol", "Description", "Quantity", "Last Price", "Current Value", "Cost Basis Total"];

describe("kinds and columns", () => {
  it("reads the kind from the URL with bank as the fallback", () => {
    expect(csvKindFromParam("positions")).toBe("positions");
    expect(csvKindFromParam("trades")).toBe("trades");
    expect(csvKindFromParam(null)).toBe("bank");
    expect(csvKindFromParam("ofx")).toBe("bank");
  });

  it("round-trips a column reference through a select value", () => {
    expect(columnValue("Symbol")).toBe("Symbol");
    expect(columnValue(2)).toBe("2");
    expect(columnValue(undefined)).toBe("");
    expect(columnRef("Symbol", true)).toBe("Symbol");
    expect(columnRef("2", false)).toBe(2);
    // A header literally named "2" stays a name while the file has a header row.
    expect(columnRef("2", true)).toBe("2");
  });
});

describe("hand-built mappings", () => {
  it("starts a positions mapping with the first column as symbol, the last as value, the date from the request", () => {
    const m = handBuiltPositionsMapping(FID_HEADERS);
    expect(m).toEqual({ hasHeader: true, skipRows: 0, asOf: { mode: "request" }, symbol: { column: "Symbol" }, value: { column: "Cost Basis Total" } });
    expect(positionsMappingIssues(m, "2026-10-13")).toEqual([]);
  });

  it("falls back to indexes for a header-less file", () => {
    expect(handBuiltPositionsMapping([])).toMatchObject({ symbol: { column: 0 }, value: { column: 1 } });
    expect(handBuiltTradesMapping([])).toMatchObject({ date: { column: 0 }, action: { column: 1 }, symbol: { column: 2 }, amount: { column: 3 } });
  });

  it("starts a trades mapping with every default the contract applies", () => {
    const m = handBuiltTradesMapping(["Run Date", "Action", "Symbol", "Amount ($)"]);
    expect(m).toEqual({
      hasHeader: true,
      skipRows: 0,
      date: { column: "Run Date", format: "MM/DD/YYYY" },
      action: { column: "Action" },
      symbol: { column: "Symbol" },
      amount: { column: "Amount ($)", invert: false },
      amountIncludesFees: true,
      reinvestRows: "separate",
      rowOrder: "auto",
      actionMap: {},
    });
    expect(tradesMappingIssues(m)).toEqual([]);
  });
});

// Audit b4-import-ui, second round: the bank mapper reads header or index columns (phase 1 plan,
// "CSV import"), and the bank editor could only write header names.
describe("the bank mapping editor, with and without a header row", () => {
  const HEADERLESS = [
    ["11/07/2026", "OAKWOOD APTS RENT", "-1800.00"],
    ["11/08/2026", "ACME PAYROLL", "2500.00"],
    ["11/09/2026", "KING SOOPERS", "-82.13"],
  ];
  const FIRST = HEADERLESS[0]!;
  /** What "Build a mapping by hand" gave such a file before: the first row's cells as header names. */
  const BY_NAME: CsvMappingInput = {
    hasHeader: true,
    date: { column: "11/07/2026", format: "MM/DD/YYYY" },
    description: { column: "OAKWOOD APTS RENT" },
    amount: { mode: "single", column: "-1800.00", invert: false },
  };
  const BY_POSITION: CsvMappingInput = {
    hasHeader: false,
    date: { column: 0, format: "MM/DD/YYYY" },
    description: { column: 1 },
    amount: { mode: "single", column: 2, invert: false },
  };

  it("takes the file's first row from the sample rows, since a header-less preview names its columns Column 1, Column 2…", () => {
    expect(bankFirstRow({ headers: ["Column 1", "Column 2", "Column 3"], sampleRows: HEADERLESS })).toEqual(FIRST);
    expect(bankFirstRow({ headers: ["Date", "Description", "Amount"], sampleRows: [] })).toEqual(["Date", "Description", "Amount"]);
  });

  it("offers the columns by header name, or by position with the first row's cell when the file has no header row", () => {
    expect(bankColumnOptions(["Date", "Description", "Amount"], true)).toEqual([
      { value: "Date", label: "Date" },
      { value: "Description", label: "Description" },
      { value: "Amount", label: "Amount" },
    ]);
    expect(bankColumnOptions([...FIRST, ""], false)).toEqual([
      { value: "0", label: "Column 1 (11/07/2026)" },
      { value: "1", label: "Column 2 (OAKWOOD APTS RENT)" },
      { value: "2", label: "Column 3 (-1800.00)" },
      { value: "3", label: "Column 4" },
    ]);
    // A long cell is cut in the label only.
    expect(bankColumnOptions(["X".repeat(50)], false)[0]!.label).toBe(`Column 1 (${"X".repeat(29)}…)`);
  });

  it("stores a picked column as a position when the file has no header row, and as a name otherwise", () => {
    expect(setBankColumn(BY_POSITION, "description", "0")).toEqual({ ...BY_POSITION, description: { column: 0 } });
    expect(setBankColumn(BY_POSITION, "date", "2")).toEqual({ ...BY_POSITION, date: { column: 2, format: "MM/DD/YYYY" } });
    expect(setBankColumn(BY_POSITION, "amount", "1")).toEqual({ ...BY_POSITION, amount: { mode: "single", column: 1, invert: false } });
    expect(setBankColumn(BY_POSITION, "memo", "1")).toEqual({ ...BY_POSITION, memo: { column: 1 } });
    expect(setBankColumn({ ...BY_POSITION, memo: { column: 1 } }, "memo", "")).toEqual(BY_POSITION);
    expect(setBankColumn(BY_POSITION, "externalId", "2")).toEqual({ ...BY_POSITION, externalId: { column: 2 } });
    const named: CsvMappingInput = { date: { column: "Date", format: "YYYY-MM-DD" }, description: { column: "Description" }, amount: { mode: "split", debitColumn: "Debit", creditColumn: "Credit" } };
    // `hasHeader` left out is the schema's default, true: a header named "2" stays a name.
    expect(setBankColumn(named, "description", "2")).toEqual({ ...named, description: { column: "2" } });
    expect(setBankColumn(named, "debit", "Withdrawals")).toEqual({ ...named, amount: { mode: "split", debitColumn: "Withdrawals", creditColumn: "Credit" } });
    expect(setBankColumn({ ...named, hasHeader: false }, "credit", "3")).toEqual({ ...named, hasHeader: false, amount: { mode: "split", debitColumn: "Debit", creditColumn: 3 } });
    // A column of the other amount layout changes nothing.
    expect(setBankColumn(named, "amount", "Amount")).toBe(named);
    expect(setBankColumn(BY_POSITION, "debit", "1")).toBe(BY_POSITION);
  });

  it("switches the amount layout with the last columns, by position when the file has no header row", () => {
    expect(setBankAmountMode(BY_POSITION, "split", FIRST)).toEqual({ ...BY_POSITION, amount: { mode: "split", debitColumn: 1, creditColumn: 2 } });
    expect(setBankAmountMode({ ...BY_POSITION, amount: { mode: "split", debitColumn: 1, creditColumn: 2 } }, "single", FIRST)).toEqual(BY_POSITION);
    const headers = ["Date", "Description", "Debit", "Credit"];
    expect(setBankAmountMode({ ...BY_NAME, hasHeader: true }, "split", headers).amount).toEqual({ mode: "split", debitColumn: "Debit", creditColumn: "Credit" });
    expect(setBankAmountMode({ ...BY_NAME, hasHeader: true }, "single", headers).amount).toEqual({ mode: "single", column: "Credit", invert: false });
  });

  it("rewrites every column between names and positions when 'first row is a header' changes, so the box alone gives a valid mapping", () => {
    // The reviewer's file: unchecking the box used to send the names with hasHeader false (400 "referenced by name").
    expect(setBankHasHeader(BY_NAME, false, FIRST)).toEqual(BY_POSITION);
    expect(setBankHasHeader(BY_POSITION, true, FIRST)).toEqual(BY_NAME);
    const full: CsvMappingInput = {
      hasHeader: true,
      skipRows: 0,
      date: { column: "posted", format: "YYYY-MM-DD" },
      description: { column: "Payee" },
      memo: { column: "Memo" },
      externalId: { column: "Ref" },
      amount: { mode: "split", debitColumn: "Out", creditColumn: "In" },
    };
    const headers = ["Ref", "Posted", "Payee", "Memo", "Out", "In"];
    // Names are matched as the server matches them (sanitized, any case): "posted" is column 1.
    const positions = setBankHasHeader(full, false, headers);
    expect(positions).toEqual({
      hasHeader: false,
      skipRows: 0,
      date: { column: 1, format: "YYYY-MM-DD" },
      description: { column: 2 },
      memo: { column: 3 },
      externalId: { column: 0 },
      amount: { mode: "split", debitColumn: 4, creditColumn: 5 },
    });
    expect(setBankHasHeader(positions, true, headers)).toEqual({ ...full, date: { column: "Posted", format: "YYYY-MM-DD" } });
  });

  it("keeps a column it cannot translate as it is", () => {
    // A name the first row does not have (a saved mapping from another export): the preview says which.
    expect(setBankHasHeader({ ...BY_NAME, description: { column: "Payee" } }, false, FIRST).description).toEqual({ column: "Payee" });
    // A position past the first row, an empty header and a repeated header stay positions (valid with a header row too):
    // the name "Amount" would find column 1, not 2.
    const repeated: CsvMappingInput = { hasHeader: false, date: { column: 0, format: "YYYY-MM-DD" }, description: { column: 3 }, amount: { mode: "split", debitColumn: 1, creditColumn: 2 } };
    expect(setBankHasHeader(repeated, true, ["Date", "Amount", "Amount", ""])).toEqual({
      hasHeader: true,
      date: { column: "Date", format: "YYYY-MM-DD" },
      description: { column: 3 },
      amount: { mode: "split", debitColumn: "Amount", creditColumn: 2 },
    });
    expect(setBankHasHeader({ ...BY_POSITION, memo: { column: 7 } }, true, FIRST).memo).toEqual({ column: 7 });
  });

  it("tells a first row of data from a header row", () => {
    expect(firstRowLooksLikeData(FIRST)).toBe(true);
    expect(firstRowLooksLikeData(["Date", "Description", "Amount"])).toBe(false);
    expect(firstRowLooksLikeData(["Posted", "Payee", "Amt (USD)"])).toBe(false);
    // Wells Fargo's export has no header row: date, amount, "*", check number, description.
    expect(firstRowLooksLikeData(["11/07/2026", "-1800.00", "*", "", "OAKWOOD APTS RENT"])).toBe(true);
    expect(firstRowLooksLikeData(["2026-11-07", "Coffee", "(4.50)"])).toBe(true);
    // A date without an amount, or an amount without a date, is not enough.
    expect(firstRowLooksLikeData(["11/07/2026", "Statement"])).toBe(false);
    expect(firstRowLooksLikeData(["Total", "-1800.00"])).toBe(false);
    expect(firstRowLooksLikeData([])).toBe(false);
  });

  it("builds a header-less mapping by position when the first row is data, so no row is lost", () => {
    expect(handBuiltBankMapping(HEADERLESS)).toEqual(BY_POSITION);
    expect(handBuiltBankMapping([["11/07/2026", "-1800.00", "*", "", "OAKWOOD APTS RENT"]])).toEqual({
      hasHeader: false,
      date: { column: 0, format: "MM/DD/YYYY" },
      description: { column: 4 },
      amount: { mode: "single", column: 1, invert: false },
    });
    // The date format is one that reads every sample: 13/11 is not a month/day.
    expect(handBuiltBankMapping([["07/11/2026", "RENT", "-1800.00"], ["13/11/2026", "PAYROLL", "2500.00"]]).date).toEqual({ column: 0, format: "DD/MM/YYYY" });
    expect(handBuiltBankMapping([["2026-11-07", "RENT", "-1800.00"]]).date).toEqual({ column: 0, format: "YYYY-MM-DD" });
    // An id that reads as a whole number is not taken for the amount when a cell with cents is there.
    expect(handBuiltBankMapping([["10442", "2026-11-07", "RENT", "-1800.00"]])).toMatchObject({ date: { column: 1 }, description: { column: 2 }, amount: { column: 3 } });
  });

  it("builds a mapping by header name when the first row is a header the guess did not recognise, with a date format that reads the rows under it", () => {
    expect(handBuiltBankMapping([["Posted", "Payee", "Amt (USD)"], ["2026-11-07", "RENT", "-1800.00"]])).toEqual({
      hasHeader: true,
      date: { column: "Posted", format: "YYYY-MM-DD" },
      description: { column: "Payee" },
      amount: { mode: "single", column: "Amt (USD)", invert: false },
    });
    expect(handBuiltBankMapping([["Posted", "Payee", "Amt (USD)"]]).date).toEqual({ column: "Posted", format: "MM/DD/YYYY" });
    expect(handBuiltBankMapping([])).toEqual({ hasHeader: true, date: { column: 0, format: "MM/DD/YYYY" }, description: { column: 1 }, amount: { mode: "single", column: 2, invert: false } });
  });
});

describe("positions mapping edits and validation", () => {
  const base = handBuiltPositionsMapping(FID_HEADERS);

  it("sets and clears optional columns without touching the rest", () => {
    const withQty = setPositionsColumn(base, "quantity", "Quantity");
    expect(withQty.quantity).toEqual({ column: "Quantity" });
    expect(withQty.symbol).toEqual({ column: "Symbol" });
    const cleared = setPositionsColumn(withQty, "quantity", "");
    expect("quantity" in cleared).toBe(false);
    expect(setPositionsColumn(base, "symbol", "").symbol).toBeUndefined();
  });

  it("switches the as-of date between a column and the request", () => {
    const col = setPositionsAsOf(base, "As of", "YYYY-MM-DD");
    expect(col.asOf).toEqual({ mode: "column", column: "As of", format: "YYYY-MM-DD" });
    expect(setPositionsAsOf(col, "", "YYYY-MM-DD").asOf).toEqual({ mode: "request" });
  });

  it("mirrors the contract's refinements", () => {
    const noIdentity = setPositionsColumn(base, "symbol", "");
    expect(positionsMappingIssues(noIdentity, "2026-10-13")).toEqual(["Pick a symbol or a name column."]);
    const noValue = setPositionsColumn(base, "value", "");
    expect(positionsMappingIssues(noValue, "2026-10-13")).toEqual(["Pick a value column, or both a quantity and a price column."]);
    const qtyPrice = setPositionsColumn(setPositionsColumn(noValue, "quantity", "Quantity"), "price", "Last Price");
    expect(positionsMappingIssues(qtyPrice, "2026-10-13")).toEqual([]);
    expect(positionsMappingIssues(base, "")).toEqual(["The file has no date column: enter the statement date (a snapshot is never dated by the clock)."]);
    const dated = setPositionsAsOf(base, "As of", "MM/DD/YYYY");
    expect(positionsMappingIssues(dated, "")).toEqual([]);
  });
});

describe("trades mapping edits and validation", () => {
  const base: TradesCsvMapping = handBuiltTradesMapping(["Run Date", "Action", "Symbol", "Description", "Quantity", "Price ($)", "Commission ($)", "Fees ($)", "Amount ($)"]);

  it("edits optional columns, the amount column and the fee columns", () => {
    const named = setTradesColumn(base, "name", "Description");
    expect(named.name).toEqual({ column: "Description" });
    expect(setTradesColumn(named, "name", "").name).toBeUndefined();
    const inverted: TradesCsvMapping = { ...base, amount: { column: "Amount ($)", invert: true } };
    expect(setTradesAmount(inverted, "Net").amount).toEqual({ column: "Net", invert: true });
    expect(setTradesAmount(inverted, "").amount).toBeUndefined();
    const oneFee = toggleFeeColumn(base, "Commission ($)");
    expect(oneFee.fee).toEqual({ columns: ["Commission ($)"] });
    const twoFees = toggleFeeColumn(oneFee, "Fees ($)");
    expect(twoFees.fee).toEqual({ columns: ["Commission ($)", "Fees ($)"] });
    expect(hasFeeColumn(twoFees, "Fees ($)")).toBe(true);
    expect(hasFeeColumn(twoFees, "Amount ($)")).toBe(false);
    const none = toggleFeeColumn(toggleFeeColumn(twoFees, "Commission ($)"), "Fees ($)");
    expect(none.fee).toBeUndefined();
  });

  it("maps and forgets action keys", () => {
    const mapped = setActionKind(base, "journaled spp purchase credit (cash)", "skip");
    expect(mapped.actionMap).toEqual({ "journaled spp purchase credit (cash)": "skip" });
    const two = setActionKind(mapped, "you bought", "buy");
    expect(Object.keys(two.actionMap)).toHaveLength(2);
    expect(setActionKind(two, "you bought", null).actionMap).toEqual({ "journaled spp purchase credit (cash)": "skip" });
  });

  it("mirrors the contract's refinements and the derivation rule", () => {
    expect(tradesMappingIssues(setTradesColumn(base, "symbol", ""))).toEqual(["Pick a symbol or a name column."]);
    const sameColumn: TradesCsvMapping = { ...base, action: { column: "Run Date" } };
    expect(tradesMappingIssues(sameColumn)).toEqual(["The date and action columns must differ."]);
    const noAmount = setTradesAmount(base, "");
    expect(tradesMappingIssues(noAmount)).toEqual(["Without an amount column, quantity and price are needed to derive it."]);
    const derivable = setTradesColumn(setTradesColumn(noAmount, "quantity", "Quantity"), "price", "Price ($)");
    expect(tradesMappingIssues(derivable)).toEqual([]);
  });
});

describe("preview requests", () => {
  const CSV = "Date,Description,Amount\n11/01/2026,RENT,-1800.00\n";
  const ACCT = "7f0e1c7e-3a53-4b0e-9a4c-0d6a4f3a1b11";
  const PROFILE = "5b0c2f4e-9d1a-4a8e-8c57-2e1f6f0a9c22";

  it("asks for a bank preview as soon as there is a file; the account and the saved profile are added when chosen", () => {
    expect(bankPreviewBody({ csvText: "", accountId: ACCT, profileId: "", mapping: null })).toBeNull();
    expect(bankPreviewBody({ csvText: CSV, accountId: "", profileId: "", mapping: null })).toEqual({ csvText: CSV });
    expect(bankPreviewBody({ csvText: CSV, accountId: ACCT, profileId: PROFILE, mapping: null })).toEqual({ csvText: CSV, accountId: ACCT, profileId: PROFILE });
  });

  it("names the page's mapping instead of the profile it came from, and nothing else changes", () => {
    const mapping = { hasHeader: true, date: { column: "Date", format: "MM/DD/YYYY" as const }, description: { column: "Description" }, amount: { mode: "single" as const, column: "Amount", invert: false } };
    expect(bankPreviewBody({ csvText: CSV, accountId: ACCT, profileId: PROFILE, mapping })).toEqual({ csvText: CSV, accountId: ACCT, mapping });
  });

  const positions = handBuiltPositionsMapping(FID_HEADERS);
  const pState = { csvText: CSV, accountId: ACCT, profileId: "", mapping: null, asOfDate: "", accountFilterValue: "", choices: [] };

  it("waits for a positions file and its account, then lets the server guess", () => {
    expect(positionsPreviewBody({ ...pState, csvText: "" })).toBeNull();
    expect(positionsPreviewBody({ ...pState, accountId: "" })).toBeNull();
    // No mapping yet and no date yet: the request still goes, so the server can answer with its guess and ask for the date.
    expect(positionsPreviewBody(pState)).toEqual({ csvText: CSV, accountId: ACCT, choices: [] });
    expect(positionsPreviewBody({ ...pState, profileId: PROFILE, asOfDate: "2026-10-30" })).toEqual({ csvText: CSV, accountId: ACCT, choices: [], profileId: PROFILE, asOfDate: "2026-10-30" });
  });

  it("sends no positions preview while the page's mapping is incomplete or still needs the statement date", () => {
    expect(positionsPreviewBody({ ...pState, mapping: positions })).toBeNull();
    expect(positionsPreviewBody({ ...pState, mapping: setPositionsColumn(positions, "symbol", ""), asOfDate: "2026-10-30" })).toBeNull();
    const choices = [{ rowIndex: 3, security: { kind: "existing" as const, securityId: PROFILE } }];
    expect(positionsPreviewBody({ ...pState, profileId: PROFILE, mapping: positions, asOfDate: "2026-10-30", accountFilterValue: "Z123", choices })).toEqual({
      csvText: CSV,
      accountId: ACCT,
      choices,
      mapping: positions,
      asOfDate: "2026-10-30",
      accountFilterValue: "Z123",
    });
    // A file with a date column needs no typed date.
    const dated = setPositionsAsOf(positions, "As of", "MM/DD/YYYY");
    expect(positionsPreviewBody({ ...pState, mapping: dated })).toEqual({ csvText: CSV, accountId: ACCT, choices: [], mapping: dated });
  });

  it("builds the trades request the same way", () => {
    const tState = { csvText: CSV, accountId: ACCT, profileId: PROFILE, mapping: null, accountFilterValue: "", choices: [] };
    expect(tradesPreviewBody({ ...tState, accountId: "" })).toBeNull();
    expect(tradesPreviewBody(tState)).toEqual({ csvText: CSV, accountId: ACCT, choices: [], profileId: PROFILE });
    const trades = handBuiltTradesMapping(["Run Date", "Action", "Symbol", "Amount ($)"]);
    expect(tradesPreviewBody({ ...tState, mapping: trades, accountFilterValue: "Z123" })).toEqual({ csvText: CSV, accountId: ACCT, choices: [], mapping: trades, accountFilterValue: "Z123" });
    // Date and action on one column cannot be previewed.
    expect(tradesPreviewBody({ ...tState, mapping: { ...trades, action: { column: "Run Date" } } })).toBeNull();
  });

  it("says what to do when the chosen date column gives no date, and nothing when the preview is dated or the date is typed", () => {
    const dated = setPositionsAsOf(positions, "As of", "MM/DD/YYYY");
    expect(unreadableDateText({ asOfRequired: true }, dated)).toBe('No row has a readable date in the statement date column. Pick another column or date format, or set the column to "none" and enter the statement date.');
    expect(unreadableDateText({ asOfRequired: false }, dated)).toBeNull();
    // Without a date column the editor's own date field and its message ask for the date.
    expect(unreadableDateText({ asOfRequired: true }, positions)).toBeNull();
    expect(unreadableDateText({ asOfRequired: true }, null)).toBeNull();
  });
});

describe("actions and rows", () => {
  it("lists unknown actions first, then by count", () => {
    const sorted = sortActions([
      { key: "you bought", sample: "YOU BOUGHT", count: 10, kind: "buy", fromProfile: false, sampleRowIndex: 1 },
      { key: "journaled", sample: "JOURNALED", count: 1, kind: null, fromProfile: false, sampleRowIndex: 5 },
      { key: "dividend received", sample: "DIVIDEND RECEIVED", count: 12, kind: "dividend", fromProfile: true, sampleRowIndex: 2 },
    ]);
    expect(sorted.map((a) => a.key)).toEqual(["journaled", "dividend received", "you bought"]);
  });

  it("spells the unknown-actions and row-order notes", () => {
    expect(unknownActionsText(0)).toBeNull();
    expect(unknownActionsText(1)).toBe("1 row was not recognised; map it or skip it.");
    expect(unknownActionsText(3)).toBe("3 rows were not recognised; map them or skip them.");
    expect(rowOrderText("newest_first")).toBe("file is newest-first; imported oldest-first");
    expect(rowOrderText("oldest_first")).toBe("file is oldest-first");
    expect(rowOrderText(null)).toBeNull();
  });

  it("badges new, guessed and cash securities", () => {
    const ref = { id: null, ticker: "ABC", name: "ABC Corp", matchedBy: "new" as const, isNew: true, needsReview: true, isCash: false, suggestion: null };
    expect(securityBadge(ref)).toEqual({ text: "new", tone: "info" });
    expect(securityBadge({ ...ref, isNew: false })).toEqual({ text: "guessed", tone: "warn" });
    expect(securityBadge({ ...ref, isNew: false, needsReview: false })).toBeNull();
    expect(securityBadge({ ...ref, isCash: true })).toEqual({ text: "cash", tone: "neutral" });
  });

  it("spells every preview warning the server emits, including a cash transfer whose direction came from the sign", () => {
    expect(previewWarningText("direction_from_sign")).toBe("the text names both directions (in and out); the amount's sign decided");
    expect(previewWarningText("amount_mismatch")).toBe("the amount differs from quantity × price (± fee) by more than 5 cents");
    expect(previewWarningText("dollar_only")).toBe("value only: the row reports no share count");
    expect(previewWarningText("value_mismatch")).toBe("the value differs from quantity × price by more than 0.5 %: the value was kept and the unit price derived from it");
    // An unlabelled code still reads as words, never as a slug.
    expect(previewWarningText("some_new_code")).toBe("some new code");
  });

  it("marks duplicate, changed and hand-edited rows", () => {
    expect(tradeRowMarker({ duplicate: false, changed: false, userEdited: false })).toBeNull();
    expect(tradeRowMarker({ duplicate: true, changed: false, userEdited: false })).toEqual({ text: "already imported", tone: "neutral" });
    expect(tradeRowMarker({ duplicate: true, changed: true, userEdited: false })).toEqual({ text: "changed", tone: "warn" });
    expect(tradeRowMarker({ duplicate: true, changed: false, userEdited: true })).toEqual({ text: "edited by hand, kept", tone: "neutral" });
  });

  it("groups rows by date in the order given", () => {
    const groups = groupTradesByDate([{ date: "2026-10-01" }, { date: "2026-10-01" }, { date: "2026-10-02" }, { date: "2026-10-01" }]);
    expect(groups.map((g) => [g.date, g.rows.length])).toEqual([
      ["2026-10-01", 2],
      ["2026-10-02", 1],
      ["2026-10-01", 1],
    ]);
  });
});

describe("the reconciliation line and the snapshot bar", () => {
  it("is hidden without a known balance and green within a dollar", () => {
    expect(reconciliationLine({ totalValueCents: "333775", knownBalanceCents: null, differenceCents: null })).toBeNull();
    expect(reconciliationLine({ totalValueCents: "333775", knownBalanceCents: "335009", differenceCents: "-1234", matchesToDollar: false })).toEqual({
      text: "Positions total $3,337.75 · Bridge balance $3,350.09 · difference -$12.34",
      tone: "warn",
    });
    expect(reconciliationLine({ totalValueCents: "333775", knownBalanceCents: "333800", differenceCents: "-25", matchesToDollar: true })).toEqual({
      text: "Positions total $3,337.75 · Bridge balance $3,338.00 · difference -$0.25 · matches to the dollar",
      tone: "ok",
    });
    // Without the server's flag the shared rule applies (|diff| < 100 cents); 0 is "exact".
    expect(reconciliationLine({ totalValueCents: "100", knownBalanceCents: "199", differenceCents: "-99" })?.tone).toBe("ok");
    expect(reconciliationLine({ totalValueCents: "100", knownBalanceCents: "200", differenceCents: "-100" })?.tone).toBe("warn");
    expect(reconciliationLine({ totalValueCents: "100", knownBalanceCents: "100", differenceCents: "0" })?.text).toContain("exact");
  });

  it("warns when a csv snapshot will be replaced and blocks when a manual one exists", () => {
    expect(snapshotBar({ snapshotExists: false, existingSource: null, willReplace: true, asOf: "2026-10-13" })).toBeNull();
    expect(snapshotBar({ snapshotExists: true, existingSource: "csv", willReplace: true, asOf: "2026-10-13" })).toEqual({
      text: "A csv snapshot for 2026-10-13 exists and will be replaced.",
      tone: "warn",
      blocks: false,
    });
    expect(snapshotBar({ snapshotExists: true, existingSource: "manual", willReplace: false, asOf: "2026-10-13" })).toMatchObject({ tone: "bad", blocks: true });
    expect(snapshotBar({ snapshotExists: true, existingSource: "simplefin", willReplace: true, asOf: "2026-10-13" })?.text).toBe("A simplefin snapshot for 2026-10-13 exists and will be replaced.");
  });
});

describe("buttons and results", () => {
  it("labels the commit buttons", () => {
    expect(positionsCommitLabel(3, "2026-10-13")).toBe("Import 3 positions as of 2026-10-13");
    expect(positionsCommitLabel(1, null)).toBe("Import 1 position");
    expect(tradesCommitLabel(10, 6)).toBe("Import 4 trades (6 already imported)");
    expect(tradesCommitLabel(1, 0)).toBe("Import 1 trade");
    expect(tradesCommitLabel(2, 5)).toBe("Import 0 trades (5 already imported)");
  });

  it("summarises a bank import with the duplicates counted when it was committed", () => {
    const result = { created: 11, updated: 0, replacedPending: 0, removedPending: 0, skipped: 0, transfersPaired: 1, errors: [] };
    expect(bankResultText(result, 0)).toBe("Imported 11 new, skipped 0 duplicates, paired 1 transfer.");
    // 3 rows were already imported before the commit and the file repeats 1 row: 4 duplicates.
    expect(bankResultText({ ...result, created: 7, skipped: 1, transfersPaired: 0, errors: [{ rowIndex: 4, message: "Unreadable date" }] }, 3)).toBe(
      "Imported 7 new, skipped 4 duplicates, paired 0 transfers. 1 row could not be read.",
    );
    expect(bankResultText({ ...result, created: 0, transfersPaired: 2, errors: [{ message: "a" }, { message: "b" }] }, 1)).toBe("Imported 0 new, skipped 1 duplicate, paired 2 transfers. 2 rows could not be read.");
  });

  it("summarises a positions import", () => {
    const text = positionsResultText({
      importLogId: "x",
      asOf: "2026-10-13",
      positions: 3,
      inserted: 2,
      updated: 1,
      unchanged: 0,
      deleted: 0,
      securitiesCreated: 2,
      impliedPrices: 3,
      totalValueCents: "333775",
      knownBalanceCents: "335009",
      differenceCents: "-1234",
      matchesToDollar: false,
      balanceWritten: true,
      errors: [],
    });
    expect(text).toBe(
      "Snapshot 2026-10-13: 3 positions (2 new, 1 updated, 0 unchanged), $3,337.75; 2 securities created; 3 implied prices; account balance set; positions total $3,337.75 · bridge balance $3,350.09 · difference -$12.34.",
    );
  });

  it("summarises a trades import", () => {
    const text = tradesResultText({
      importLogId: "x",
      created: 4,
      updated: 0,
      unchanged: 2,
      skippedEdited: 1,
      linked: 3,
      ledgerCreated: 2,
      ledgerSkipped: 0,
      transfersPaired: 1,
      securitiesCreated: 0,
      lotsRebuilt: 1,
      warnings: [{ message: "w" }],
      errors: [],
    });
    expect(text).toBe("Imported 4 trades, 2 unchanged, 1 kept as edited; 3 linked to ledger rows, 2 ledger rows created; 1 transfer paired; lots rebuilt for 1 account; 1 warning.");
  });
});

// Type-level check that the positions mapping type the editors hold is the parsed contract.
const _typed: PositionsCsvMapping = handBuiltPositionsMapping(FID_HEADERS);
void _typed;
