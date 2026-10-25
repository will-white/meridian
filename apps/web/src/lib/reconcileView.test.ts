import { describe, expect, it } from "vitest";
import type { LineValuationView, ReconcilePreviewResponse, SecurityPriceStatusView } from "@meridian/shared";
import {
  cashInferenceHintText,
  cashInferenceReadings,
  clockIn,
  commitBlockText,
  commitResultText,
  countsLine,
  defaultStatementDate,
  differenceHeadline,
  dollarsInputToCents,
  fetchStatusLabel,
  hourLabel,
  lastRunText,
  parsePastedRows,
  parsePriceInput,
  parseReconcileRows,
  priceHistoryPoints,
  priceRowSeverity,
  recordOutcome,
  refreshResultText,
  rowStatusTone,
  rowsFromLines,
  scheduleText,
  sortPriceRows,
  unexplainedText,
} from "./reconcileView.js";

const VTI = "11111111-1111-4111-8111-111111111111";
const VFIAX = "22222222-2222-4222-8222-222222222222";
const A = "33333333-3333-4333-8333-333333333333";

function line(p: Partial<LineValuationView> & Pick<LineValuationView, "kind" | "name">): LineValuationView {
  return {
    securityId: null,
    ticker: null,
    quantity: null,
    price: null,
    priceDate: null,
    priceSource: null,
    priceStatus: "current",
    tradingDaysBehind: 0,
    valueCents: null,
    valueSource: "priced",
    ...p,
  };
}

// The prices design's S1 worked example: VTI 100 @ 305.25, VFIAX 50.123 @ 505.10, cash 1,234.56 reported + 1,000.00 carried.
const S1_LINES: LineValuationView[] = [
  line({ kind: "position", securityId: VTI, ticker: "VTI", name: "Vanguard Total Stock Market ETF", quantity: "100", price: "305.25", valueCents: "3052500" }),
  line({ kind: "position", securityId: VFIAX, ticker: "VFIAX", name: "Vanguard 500 Index Admiral", quantity: "50.123", price: "505.1", valueCents: "2531713" }),
  line({ kind: "cash", name: "Cash", valueCents: "123456", valueSource: "statement" }),
  line({ kind: "carried_flows", name: "carried transfers", valueCents: "100000", valueSource: "carried" }),
];

describe("prefill and paste", () => {
  it("turns the app's lines into statement rows with the cash-kind lines summed into one cash row", () => {
    const rows = rowsFromLines(S1_LINES);
    expect(rows.map((r) => [r.ticker, r.isCash, r.quantity, r.price, r.value])).toEqual([
      ["VTI", false, "100", "305.25", "30525.00"],
      ["VFIAX", false, "50.123", "505.1", "25317.13"],
      ["Cash", true, "2234.56", "", ""],
    ]);
    expect(rows[0]!.securityId).toBe(VTI);
    expect(rows[2]!.securityId).toBeNull();
  });
  it("keeps a dollar-only position as a zero-quantity row with its value and skips the cash row without cash lines", () => {
    const rows = rowsFromLines([line({ kind: "position", securityId: VTI, ticker: null, name: "Stable Value Fund", quantity: null, valueCents: "50000", valueSource: "statement" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ticker).toBe("Stable Value Fund");
    expect(rows[0]!.quantity).toBe("0");
    expect(rows[0]!.value).toBe("500.00");
  });
  it("parses a pasted four-column statement, skipping a header and recognising the cash row", () => {
    const rows = parsePastedRows("Symbol,Quantity,Price,Value\nVTI,100,305.25,30525.00\nVFIAX,50.123,505.10,\"25,317.13\"\nCash,,,2234.56\n");
    expect(rows.map((r) => [r.ticker, r.isCash, r.quantity, r.price, r.value])).toEqual([
      ["VTI", false, "100", "305.25", "30525.00"],
      ["VFIAX", false, "50.123", "505.10", "25,317.13"],
      ["Cash", true, "2234.56", "", ""],
    ]);
  });
  it("accepts tab-separated and shorter rows", () => {
    const rows = parsePastedRows("VTI\t100\t305.25\nBND\t20\n");
    expect(rows.map((r) => [r.ticker, r.quantity, r.price, r.value])).toEqual([
      ["VTI", "100", "305.25", ""],
      ["BND", "20", "", ""],
    ]);
  });
  it("splits a spreadsheet paste on tabs even when its numbers carry thousands separators", () => {
    const rows = parsePastedRows("Symbol\tQuantity\tPrice\tValue\r\nVTI\t100\t305.25\t30,525.00\r\nCash\t\t\t2,234.56\r\n");
    expect(rows.map((r) => [r.ticker, r.isCash, r.quantity, r.price, r.value])).toEqual([
      ["VTI", false, "100", "305.25", "30,525.00"],
      ["Cash", true, "2,234.56", "", ""],
    ]);
    // The separators are stripped when the rows become the preview body: 30,525.00 + 2,234.56 = 32,759.56.
    const parsed = parseReconcileRows(rows);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.sumCents).toBe(3275956n);
  });
});

describe("row validation", () => {
  const base = { key: "k", securityId: null, isCash: false, price: "", value: "" };
  it("builds the preview body and sums the statement from values, or price × quantity when no value was typed", () => {
    const r = parseReconcileRows([
      { ...base, key: "a", securityId: VTI, ticker: "VTI", quantity: "100", price: "305.25" },
      { ...base, key: "b", ticker: "vfiax", quantity: "50.123", price: "505.10", value: "25,317.13" },
      { ...base, key: "c", ticker: "Cash", isCash: true, quantity: "2,234.56" },
      { ...base, key: "blank", ticker: "", quantity: "" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toEqual([
      { isCash: false, quantity: "100", securityId: VTI, price: "305.25" },
      { isCash: false, quantity: "50.123", ticker: "vfiax", price: "505.1", valueCents: "2531713" },
      { isCash: true, quantity: "2234.56", valueCents: "223456" },
    ]);
    // 100 × 305.25 = 30,525.00; + 25,317.13 + 2,234.56 = 58,076.69
    expect(r.sumCents).toBe(5807669n);
    expect(r.count).toBe(3);
  });
  it("names what each bad row is missing", () => {
    const r = parseReconcileRows([
      { ...base, key: "noval", ticker: "VTI", quantity: "100" },
      { ...base, key: "noqty", ticker: "VTI", quantity: "", value: "10" },
      { ...base, key: "notick", ticker: "", quantity: "1", value: "10" },
      { ...base, key: "badcash", ticker: "Cash", isCash: true, quantity: "lots" },
      { ...base, key: "badprice", ticker: "VTI", quantity: "1", price: "x" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual({
      noval: "give a value or a price",
      noqty: "enter the share quantity",
      notick: "enter a ticker",
      badcash: "enter the cash balance in dollars",
      badprice: "the price is not a number",
    });
  });
  it("blocks Accept and Record only until rows or a total are entered, and while either is unreadable", () => {
    const none = parseReconcileRows([]);
    // Nothing entered: the server would take Σ[] = $0.00 as the statement and accept it as an empty manual snapshot.
    expect(commitBlockText(none, "")).toBe("Enter the statement's rows or its total before accepting or recording.");
    expect(commitBlockText(none, "   ")).toBe("Enter the statement's rows or its total before accepting or recording.");
    // A typed total alone is a statement (the total-only path), even $0.00.
    expect(commitBlockText(none, "58,076.69")).toBeNull();
    expect(commitBlockText(none, "0")).toBeNull();
    expect(commitBlockText(none, "lots")).toBe("The statement total is not a dollar amount.");
    const rows = parseReconcileRows([{ ...base, key: "a", securityId: VTI, ticker: "VTI", quantity: "100", price: "305.25" }]);
    expect(commitBlockText(rows, "")).toBeNull();
    const bad = parseReconcileRows([{ ...base, key: "noval", ticker: "VTI", quantity: "100" }]);
    expect(commitBlockText(bad, "")).toBe("Fix the rows above before accepting or recording.");
    expect(commitBlockText(bad, "100")).toBe("Fix the rows above before accepting or recording.");
  });
  it("parses dollars to cents with at most two places", () => {
    expect(dollarsInputToCents("$1,234.56")).toBe(123456n);
    expect(dollarsInputToCents("12")).toBe(1200n);
    expect(dollarsInputToCents("(5.00)")).toBe(-500n);
    expect(dollarsInputToCents("12.345")).toBeNull();
    expect(dollarsInputToCents("abc")).toBeNull();
  });
  it("defaults the statement date to the last day of the previous month", () => {
    expect(defaultStatementDate("2026-10-25")).toBe("2026-09-30");
    expect(defaultStatementDate("2026-03-01")).toBe("2026-02-28");
    expect(defaultStatementDate("2026-01-15")).toBe("2025-12-31");
  });
});

function preview(p: Omit<Partial<ReconcilePreviewResponse>, "app"> & { app?: Partial<ReconcilePreviewResponse["app"]> }): Pick<ReconcilePreviewResponse, "app" | "statementTotalCents" | "differenceCents" | "matchesToDollar" | "toleranceCents" | "cashInferenceHint"> {
  const { app, ...rest } = p;
  return {
    app: {
      accountId: A,
      name: "Vanguard Brokerage",
      type: "brokerage",
      taxTreatment: "taxable",
      fidelity: "positions",
      cashInference: "auto",
      date: "2026-10-13",
      basis: "positions",
      asOf: "2026-09-30",
      valueCents: "5807669",
      priceStatus: "current",
      stalest: null,
      missing: [],
      balanceDiffCents: null,
      cashAnchor: "2026-09-30",
      lines: S1_LINES,
      dayChange: { cents: null, asOf: null, prior: null, reason: null },
      lastReconciliation: null,
      warnings: [],
      ...app,
    },
    statementTotalCents: "5807669",
    differenceCents: "0",
    matchesToDollar: true,
    toleranceCents: "100",
    cashInferenceHint: null,
    ...rest,
  };
}

describe("the preview", () => {
  it("headlines exact, to the dollar and off by", () => {
    expect(differenceHeadline(null, false)).toEqual({ text: "No app value on this date", tone: "neutral" });
    expect(differenceHeadline("0", true)).toEqual({ text: "Matches the statement exactly", tone: "ok" });
    expect(differenceHeadline("-31", true)).toEqual({ text: "Matches to the dollar ($0.31 app below the statement)", tone: "ok" });
    expect(differenceHeadline("-100", false)).toEqual({ text: "Off by $1.00 (app below the statement)", tone: "warn" });
    expect(differenceHeadline("30525", false)).toEqual({ text: "Off by $305.25 (app above the statement)", tone: "warn" });
  });
  it("tones the row statuses", () => {
    expect(rowStatusTone("match")).toBe("ok");
    expect(rowStatusTone("price")).toBe("warn");
    expect(rowStatusTone("cash")).toBe("warn");
    expect(rowStatusTone("missing_in_app")).toBe("bad");
    expect(rowStatusTone("unknown_ticker")).toBe("bad");
  });
  it("reads an auto account both ways: the current value, and what off would drop", () => {
    const r = cashInferenceReadings(preview({}));
    expect(r.current).toEqual({ setting: "auto", valueCents: "5807669", differenceCents: "0", reconciles: true, note: "cash inferred from the balance (current setting)" });
    // off drops the 1,000.00 carried transfer (no plug line here): 57,076.69 − 58,076.69 = −1,000.00
    expect(r.alternative).toEqual({
      setting: "off",
      valueCents: "5707669",
      differenceCents: "-100000",
      reconciles: false,
      note: "would drop the $0.00 balance plug and $1,000.00 of carried transfers",
    });
  });
  it("reads an off account both ways from the server's hint (worked example S1 with cash inference off)", () => {
    const r = cashInferenceReadings(
      preview({
        app: { cashInference: "off", valueCents: "5707669", lines: S1_LINES.slice(0, 3) },
        differenceCents: "-100000",
        matchesToDollar: false,
        cashInferenceHint: { flowsSinceSnapshotCents: "100000", plugCents: "0", wouldReconcile: true },
      }),
    );
    expect(r.current.setting).toBe("off");
    expect(r.current.reconciles).toBe(false);
    expect(r.alternative).toEqual({
      setting: "auto",
      valueCents: "5807669",
      differenceCents: "0",
      reconciles: true,
      note: "would add $1,000.00 of transfers since the last statement and a $0.00 balance plug",
    });
  });
  it("has no alternative when the other setting would not change the value", () => {
    expect(cashInferenceReadings(preview({ app: { lines: S1_LINES.slice(0, 3) } })).alternative).toBeNull();
    expect(cashInferenceReadings(preview({ app: { cashInference: "off" } })).alternative).toBeNull();
  });
  it("words the hint callout", () => {
    expect(cashInferenceHintText({ flowsSinceSnapshotCents: "100000", plugCents: "0", wouldReconcile: true }, "2026-09-30")).toBe(
      "Transfers into this account since the 09/30/26 statement total $1,000.00; turning on Infer cash from balance would reconcile.",
    );
    expect(cashInferenceHintText({ flowsSinceSnapshotCents: "0", plugCents: "12345", wouldReconcile: false }, null)).toBe(
      "The balance implies $123.45 of cash the positions list omits; turning on Infer cash from balance would not reconcile.",
    );
  });
  it("words the commit result and a stored record's outcome", () => {
    const app = preview({}).app;
    expect(commitResultText({ accepted: true, preCommitDifferenceCents: "0", matchesToDollar: true, app }, "2026-10-13")).toBe("Reconciled 10/13/26: app value now $58,076.69; pre-commit difference $0.00.");
    expect(commitResultText({ accepted: false, preCommitDifferenceCents: "-100", matchesToDollar: false, app }, "2026-10-13")).toBe(
      "Recorded 10/13/26 without accepting the statement: app value now $58,076.69; pre-commit difference -$1.00 (not to the dollar).",
    );
    expect(recordOutcome({ differenceCents: "0", reconciled: true })).toEqual({ text: "exact", tone: "ok" });
    expect(recordOutcome({ differenceCents: "-31", reconciled: true })).toEqual({ text: "to the dollar", tone: "ok" });
    expect(recordOutcome({ differenceCents: "-100", reconciled: false })).toEqual({ text: "off by $1.00", tone: "warn" });
    expect(recordOutcome({ differenceCents: null, reconciled: false })).toEqual({ text: "no app value", tone: "neutral" });
    expect(unexplainedText("0")).toBeNull();
    expect(unexplainedText(null)).toBeNull();
    expect(unexplainedText("-31")).toContain("-$0.31 of the difference");
  });
});

function priceRow(p: Partial<SecurityPriceStatusView> & Pick<SecurityPriceStatusView, "name">): SecurityPriceStatusView {
  return {
    securityId: VTI,
    ticker: null,
    priceMode: "provider",
    providerSymbol: null,
    alwaysPrice: false,
    held: true,
    latestPriceDate: null,
    latestClose: null,
    latestSource: null,
    priceStatus: "current",
    tradingDaysBehind: 0,
    fetchStatus: "ok",
    fetchMessage: null,
    fetchedAt: null,
    failures: 0,
    nextAttemptAt: null,
    backfilledFrom: null,
    ...p,
  };
}

describe("the price status table", () => {
  it("sorts fetch failures first, then by status severity, then by ticker", () => {
    const rows = [
      priceRow({ name: "Cash", ticker: null, priceStatus: "cash", priceMode: "implied", fetchStatus: null }),
      priceRow({ name: "b", ticker: "VTI", priceStatus: "current" }),
      priceRow({ name: "c", ticker: "BND", priceStatus: "stale", tradingDaysBehind: 3 }),
      priceRow({ name: "d", ticker: "VXUS", priceStatus: "current" }),
      priceRow({ name: "e", ticker: "ZZZ", priceStatus: "missing", fetchStatus: "not_found" }),
      priceRow({ name: "f", ticker: "VFIAX", priceStatus: "implied", priceMode: "implied", fetchStatus: null }),
      priceRow({ name: "g", ticker: "OLD", priceStatus: "missing", fetchStatus: null }),
    ];
    expect(sortPriceRows(rows).map((r) => r.ticker ?? r.name)).toEqual(["ZZZ", "OLD", "BND", "VFIAX", "VTI", "VXUS", "Cash"]);
    expect(priceRowSeverity(priceRow({ name: "x", priceMode: "implied", priceStatus: "implied", fetchStatus: "error" }))).toBe(4);
  });
  it("labels fetch statuses, hours, the schedule and the counts", () => {
    expect(fetchStatusLabel(null)).toBe("never fetched");
    expect(fetchStatusLabel("rate_limited")).toBe("rate limited");
    expect(hourLabel(18)).toBe("6 pm");
    expect(hourLabel(6)).toBe("6 am");
    expect(hourLabel(0)).toBe("12 am");
    expect(hourLabel(12)).toBe("12 pm");
    expect(scheduleText(18, 6, "America/New_York")).toBe("nightly at 6 pm household time (America/New_York), catch-up at 6 am");
    expect(scheduleText(18, null, "UTC")).toBe("nightly at 6 pm household time (UTC)");
    expect(countsLine({ current: 12, stale: 1, notFound: 1, error: 0, implied: 2, manual: 1 })).toBe("12 current · 1 stale · 1 not found · 2 implied · 1 manual");
    expect(countsLine({ current: 0, stale: 0, notFound: 0, error: 0, implied: 0, manual: 0 })).toBe("no priced securities");
  });
  it("describes the last run in household time", () => {
    expect(clockIn("2026-10-13T22:03:00Z", "America/New_York")).toBe("6:03 pm");
    const run = { importLogId: VTI, startedAt: "2026-10-13T22:03:00Z", finishedAt: "2026-10-13T22:04:00Z", status: "ok" as const, message: null, stats: { requests: 31, securities: 4, rowsInserted: 62, rowsUpdated: 0, notFound: 1, errors: 0 } };
    expect(lastRunText(run, "America/New_York")).toBe("6:03 pm · 31 requests, 4 securities, 62 new rows, 1 not found");
    expect(lastRunText({ ...run, status: "running", finishedAt: null }, "America/New_York")).toBe("running since 6:03 pm");
    expect(lastRunText({ ...run, status: "error", stats: null, message: "tiingo: 503" }, "America/New_York")).toBe("6:03 pm · tiingo: 503 · failed");
    expect(lastRunText(null, "UTC")).toBeNull();
  });
  it("words the refresh result and parses manual prices", () => {
    expect(refreshResultText({ created: true, movedUp: false })).toBe("queued");
    expect(refreshResultText({ created: false, movedUp: true })).toBe("moved up");
    expect(refreshResultText({ created: false, movedUp: false })).toBe("already running");
    expect(parsePriceInput("$1,234.50")).toBe("1234.5");
    expect(parsePriceInput("312.5")).toBe("312.5");
    expect(parsePriceInput("-1")).toBeNull();
    expect(parsePriceInput("abc")).toBeNull();
  });
  it("orders the history ascending for the chart", () => {
    const items = [
      { securityId: VTI, date: "2026-10-13", close: "305.25", adjClose: null, source: "provider" as const, provider: "tiingo" as const, suspect: false, updatedAt: "" },
      { securityId: VTI, date: "2026-10-10", close: "299.1", adjClose: null, source: "manual" as const, provider: null, suspect: false, updatedAt: "" },
      { securityId: VTI, date: "2026-10-12", close: "30.52", adjClose: null, source: "provider" as const, provider: "tiingo" as const, suspect: true, updatedAt: "" },
    ];
    expect(priceHistoryPoints(items)).toEqual({ dates: ["2026-10-10", "2026-10-12", "2026-10-13"], closes: [299.1, 30.52, 305.25], suspect: [false, true, false], manual: [true, false, false] });
  });
});
