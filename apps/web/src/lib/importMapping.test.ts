import { describe, expect, it } from "vitest";
import type { PositionsCsvMapping, TradesCsvMapping } from "@meridian/shared";
import {
  columnRef,
  columnValue,
  csvKindFromParam,
  groupTradesByDate,
  handBuiltPositionsMapping,
  handBuiltTradesMapping,
  hasFeeColumn,
  positionsCommitLabel,
  positionsMappingIssues,
  positionsResultText,
  reconciliationLine,
  rowOrderText,
  securityBadge,
  setActionKind,
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
  tradesResultText,
  unknownActionsText,
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
