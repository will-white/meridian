import { describe, expect, it } from "vitest";
import {
  benchmarkFromParams,
  benchmarkNote,
  detailRequestBody,
  excessText,
  feedModeLabel,
  flowKindLabel,
  flowLink,
  flowsSourceLabel,
  growthEndText,
  incomeBars,
  incomeEmptyText,
  internalReasonText,
  linkStatusLabel,
  linkStatusTone,
  mergeIndexSeries,
  methodLabel,
  methodTone,
  monthAxisLabel,
  mwrCell,
  openingValueText,
  subPeriodFlags,
  twrCell,
  yieldText,
} from "./performanceView.js";

describe("return figures", () => {
  it("names the method and its tone", () => {
    expect(methodLabel("true_twr")).toBe("True TWR");
    expect(methodLabel("modified_dietz")).toBe("Modified Dietz (approximate)");
    expect(methodLabel(null)).toBe("—");
    expect(methodTone("true_twr")).toBe("ok");
    expect(methodTone("modified_dietz")).toBe("info");
    expect(methodTone(null)).toBe("neutral");
  });
  it("shows the TWR period rate with the annualized rate only when the engine returned one", () => {
    expect(twrCell({ rate: 0.0862, annualized: null, reason: null, reasonDate: null })).toEqual({ text: "+8.62%", caption: "not annualized (period under a year)", failed: false });
    expect(twrCell({ rate: 0.0862, annualized: 0.091, reason: null, reasonDate: null })).toEqual({ text: "+8.62%", caption: "+9.10% annualized", failed: false });
    expect(twrCell({ rate: -0.0125, annualized: null, reason: null, reasonDate: null }).text).toBe("-1.25%");
    expect(twrCell({ rate: null, annualized: null, reason: "no_valuations", reasonDate: "2026-10-13" })).toEqual({ text: "—", caption: null, failed: true });
  });
  it("shows the MWR period rate under a year and the annualized XIRR from a year on", () => {
    const xirr = { annualized: 0.0923, period: 0.05, investedDays: 200, reason: null, warnings: [], investorFlows: [] };
    const short = mwrCell(xirr, 200);
    expect(short.text).toBe("+5.00%");
    expect(short.caption).toBe("over 200 days, not annualized (XIRR +9.23% would exaggerate a short period)");
    expect(short.failed).toBe(false);
    expect(mwrCell(xirr, 400)).toEqual({ text: "+9.23%", caption: "annualized (XIRR)", failed: false });
    expect(mwrCell({ ...xirr, annualized: null, period: null, reason: "no_sign_change" }, 400)).toEqual({ text: "—", caption: null, failed: true });
  });
  it("formats the excess and the benchmark note", () => {
    expect(excessText(0.012)).toBe("+1.20%");
    expect(excessText(-0.004)).toBe("-0.40%");
    expect(excessText(null)).toBe("—");
    expect(benchmarkNote(true)).toBeNull();
    expect(benchmarkNote(false)).toBe("price return only; a dividend-paying benchmark is understated by its yield");
  });
  it("labels flows, their provenance and the opening value", () => {
    expect(flowsSourceLabel("ledger")).toBe("flows from ledger");
    expect(flowsSourceLabel("investment")).toBe("flows from trade history");
    expect(flowsSourceLabel("mixed")).toBe("flows from ledger and trade history");
    expect(flowsSourceLabel("none")).toBe("no flows seen");
    expect(flowKindLabel("opening_value")).toBe("opening value");
    expect(internalReasonText("counterparty_in_total")).toBe("both sides are in this total");
    expect(internalReasonText(null)).toBeNull();
    expect(openingValueText({ date: "2026-01-31", cents: "100000" })).toBe("entered at $1,000.00 on 01/31/26");
    expect(openingValueText(null)).toBeNull();
  });
  it("links a flow to where it can be inspected", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    expect(flowLink({ source: "ledger", accountId: a, date: "2026-03-02" })).toBe(`/transactions?accountId=${a}&from=2026-03-02&to=2026-03-02&transfers=only`);
    expect(flowLink({ source: "investment_txn", accountId: a, date: "2026-03-02" })).toBe(`/investments/accounts/${a}`);
    expect(flowLink({ source: "engine", accountId: a, date: "2026-03-02" })).toBeNull();
  });
  it("spells out sub-period flags", () => {
    expect(subPeriodFlags({ skipped: false, beginCarried: false, endCarried: false, from: "2026-01-01", to: "2026-03-31" })).toEqual([]);
    expect(subPeriodFlags({ skipped: true, beginCarried: true, endCarried: true, from: "2026-01-01", to: "2026-03-31" })).toEqual([
      "skipped (no capital)",
      "begin carried to 01/01/26",
      "end carried to 03/31/26",
    ]);
  });
});

describe("benchmark URL state and the detail request", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  it("reads ?benchmark= as an id, none, or the household default", () => {
    expect(benchmarkFromParams(new URLSearchParams(`benchmark=${id}`))).toBe(id);
    expect(benchmarkFromParams(new URLSearchParams("benchmark=none"))).toBeNull();
    expect(benchmarkFromParams(new URLSearchParams(""))).toBeUndefined();
    expect(benchmarkFromParams(new URLSearchParams("benchmark=junk"))).toBeUndefined();
  });
  it("builds the engine's full-detail body for the view's window", () => {
    const period = { kind: "1y" as const, from: "2025-10-13", to: "2026-10-13", days: 365, partial: false, note: null };
    expect(detailRequestBody({ period, asOf: "2026-10-13", today: "2026-10-14", accountIds: [id], benchmarkSecurityId: undefined })).toEqual({
      today: "2026-10-14",
      from: "2025-10-13",
      to: "2026-10-13",
      asOf: "2026-10-13",
      accountIds: [id],
      detail: "full",
    });
    const all = { ...period, kind: "all" as const };
    expect(detailRequestBody({ period: all, asOf: "2026-10-13", today: "2026-10-14", benchmarkSecurityId: null })).toEqual({
      today: "2026-10-14",
      to: "2026-10-13",
      asOf: "2026-10-13",
      benchmarkSecurityId: null,
      detail: "full",
    });
    expect(detailRequestBody({ period: null, asOf: "2026-10-13", today: "2026-10-14", accountIds: [], benchmarkSecurityId: id })).toEqual({
      today: "2026-10-14",
      to: "2026-10-13",
      asOf: "2026-10-13",
      benchmarkSecurityId: id,
      detail: "full",
    });
  });
});

describe("growth of $10,000", () => {
  it("merges index series onto one axis as carried-forward steps", () => {
    const merged = mergeIndexSeries([
      {
        key: "total",
        name: "Portfolio",
        points: [
          { date: "2026-01-01", indexBp: 10000 },
          { date: "2026-03-31", indexBp: 10300 },
          { date: "2026-06-30", indexBp: 10609 },
        ],
      },
      {
        key: "bench",
        name: "VTI",
        points: [
          { date: "2026-06-30", indexBp: 10500 },
          { date: "2026-01-01", indexBp: 10000 },
          { date: "2026-02-15", indexBp: 10100 },
        ],
      },
      { key: "late", name: "Roth", points: [{ date: "2026-03-31", indexBp: 10000 }] },
    ]);
    expect(merged.dates).toEqual(["2026-01-01", "2026-02-15", "2026-03-31", "2026-06-30"]);
    expect(merged.lines[0]!.values).toEqual([10000, 10000, 10300, 10609]);
    expect(merged.lines[1]!.values).toEqual([10000, 10100, 10100, 10500]);
    expect(merged.lines[2]!.values).toEqual([null, null, 10000, 10000]);
  });
  it("states where $10,000 ended", () => {
    expect(growthEndText([{ date: "2026-01-01", indexBp: 10000 }, { date: "2026-06-30", indexBp: 10609 }])).toBe("$10,000 → $10,609.00");
    expect(growthEndText([])).toBeNull();
  });
});

describe("income", () => {
  it("stacks cash dividends, reinvested dividends and interest scaled to the tallest month", () => {
    const { maxCents, bars } = incomeBars([
      { month: "2026-10", dividendsCents: "32435", interestCents: "1000", reinvestedCents: "20000", totalCents: "33435" },
      { month: "2026-11", dividendsCents: "0", interestCents: "500", reinvestedCents: "0", totalCents: "500" },
    ]);
    expect(maxCents).toBe("33435");
    expect(bars[0]).toEqual({
      month: "2026-10",
      cashDividendsCents: "12435",
      reinvestedCents: "20000",
      interestCents: "1000",
      totalCents: "33435",
      pct: { cashDividends: 37.19, reinvested: 59.81, interest: 2.99 },
    });
    expect(bars[1]!.pct).toEqual({ cashDividends: 0, reinvested: 0, interest: 1.49 });
  });
  it("draws nothing for empty months", () => {
    const { maxCents, bars } = incomeBars([{ month: "2026-10", dividendsCents: "0", interestCents: "0", reinvestedCents: "0", totalCents: "0" }]);
    expect(maxCents).toBe("0");
    expect(bars[0]!.pct).toEqual({ cashDividends: 0, reinvested: 0, interest: 0 });
  });
  it("labels months on the axis with the year at a boundary", () => {
    expect(monthAxisLabel("2026-10", null)).toBe("Oct 26");
    expect(monthAxisLabel("2026-11", "2026-10")).toBe("Nov");
    expect(monthAxisLabel("2027-01", "2026-12")).toBe("Jan 27");
  });
  it("labels yield, kinds, link statuses and feed modes", () => {
    expect(yieldText(71)).toBe("0.71% of current value");
    expect(yieldText(null)).toBeNull();
    expect(linkStatusLabel("awaiting")).toBe("awaiting bank row");
    expect(linkStatusLabel("ledger_only")).toBe("ledger only");
    expect(linkStatusTone("linked")).toBe("ok");
    expect(linkStatusTone("awaiting")).toBe("warn");
    expect(linkStatusTone("not_fed")).toBe("neutral");
    expect(feedModeLabel("create")).toBe("Create rows");
    expect(incomeEmptyText("Investment income")).toBe("No dividends or interest recorded. Dividends come from trade-history imports, manual trades, or bank rows categorized as Investment income.");
    expect(incomeEmptyText(null)).toContain("set one in Settings");
  });
});
