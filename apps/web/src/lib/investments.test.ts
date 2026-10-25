import { describe, expect, it } from "vitest";
import {
  ASSET_CLASSES,
  asOfFromParams,
  asOfLine,
  attributionTotals,
  autoSeriesStep,
  barScaleBp,
  barWidth,
  bpToPercentInput,
  bpToPpInput,
  changeSentence,
  changeTone,
  changeWindows,
  chartRange,
  coverageLabel,
  dayChangeSentence,
  dollarsToCents,
  driftTone,
  fidelityLabel,
  fidelityTone,
  formatBp,
  formatPp,
  formatPpm,
  formatQuantity,
  formatRate,
  fromToText,
  groupTrades,
  marketOrUnknownText,
  noValueYetText,
  parseSplitsForm,
  periodChangePartialText,
  parseTargetsForm,
  percentToBp,
  periodFromParams,
  periodQuery,
  ppToBp,
  priceStatusText,
  priceStatusTone,
  signedMoney,
  splitLabel,
  splitRows,
  targetsForm,
  targetsSumBp,
  tradeSentence,
  valuationDescription,
} from "./investments.js";

describe("formatBp / formatPp / formatPpm / formatRate", () => {
  it("renders basis points with one decimal by default (seed allocation: 5970/1907/1745/376)", () => {
    expect(formatBp(5970)).toBe("59.7%");
    expect(formatBp(1907)).toBe("19.1%");
    expect(formatBp(1745)).toBe("17.5%");
    expect(formatBp(376)).toBe("3.8%");
    expect(formatBp(10000)).toBe("100.0%");
    expect(formatBp(0)).toBe("0.0%");
    expect(formatBp(null)).toBe("—");
  });
  it("rounds half away from zero at the shown precision and signs on request", () => {
    expect(formatBp(5)).toBe("0.1%");
    expect(formatBp(4)).toBe("0.0%");
    expect(formatBp(-5, { sign: true })).toBe("-0.1%");
    expect(formatBp(80, { places: 2, sign: true })).toBe("+0.80%");
    expect(formatBp(1574, { places: 2 })).toBe("15.74%");
    expect(formatBp(9998, { places: 0 })).toBe("100%");
    expect(formatBp(-593, { sign: true })).toBe("-5.9%");
    expect(formatBp(0, { sign: true })).toBe("0.0%");
  });
  it("formats drift in percentage points (seed drift +970 / −593 / −255 / −124)", () => {
    expect(formatPp(970)).toBe("+9.7 pp");
    expect(formatPp(-593)).toBe("-5.9 pp");
    expect(formatPp(-255)).toBe("-2.6 pp");
    expect(formatPp(-124)).toBe("-1.2 pp");
    expect(formatPp(0)).toBe("0.0 pp");
    expect(formatPp(null)).toBe("—");
  });
  it("formats ppm as a percentage with two places (326 ppm → 0.03%)", () => {
    expect(formatPpm(326)).toBe("0.03%");
    expect(formatPpm(300)).toBe("0.03%");
    expect(formatPpm(278)).toBe("0.03%");
    expect(formatPpm(800)).toBe("0.08%");
    expect(formatPpm(1250)).toBe("0.13%");
    expect(formatPpm(0)).toBe("0.00%");
    expect(formatPpm(null)).toBe("—");
  });
  it("formats engine rates (fractions) as percentages", () => {
    expect(formatRate(0.0862)).toBe("8.62%");
    expect(formatRate(-0.0125)).toBe("-1.25%");
    expect(formatRate(0.0862, true)).toBe("+8.62%");
    expect(formatRate(0)).toBe("0.00%");
    expect(formatRate(null)).toBe("—");
    expect(formatRate(Number.NaN)).toBe("—");
  });
});

describe("formatQuantity / signedMoney / changeTone / splitLabel", () => {
  it("trims quantities to the requested places, rounding half away from zero", () => {
    expect(formatQuantity("14.0544")).toBe("14.0544");
    expect(formatQuantity("14.0544", 2)).toBe("14.05");
    expect(formatQuantity("37.65449438", 2)).toBe("37.65");
    expect(formatQuantity("15.37967914", 2)).toBe("15.38");
    expect(formatQuantity("0.005", 2)).toBe("0.01");
    expect(formatQuantity("40")).toBe("40");
    expect(formatQuantity("1250.5")).toBe("1,250.5");
    expect(formatQuantity("0.00000001")).toBe("0.00000001");
    expect(formatQuantity("-2.5", 0)).toBe("-3");
    expect(formatQuantity(null)).toBe("—");
  });
  it("signs money and derives a tone", () => {
    expect(signedMoney("36000")).toBe("+$360.00");
    expect(signedMoney("-1200")).toBe("-$12.00");
    expect(signedMoney("0")).toBe("$0.00");
    expect(signedMoney(null)).toBe("—");
    expect(changeTone("36000")).toBe("pos");
    expect(changeTone("-1")).toBe("neg");
    expect(changeTone("0")).toBe("");
    expect(changeTone(-12)).toBe("neg");
    expect(changeTone(null)).toBe("");
  });
  it("labels a blended fund's splits (TR2050 54/36/10)", () => {
    expect(
      splitLabel([
        { assetClass: "us_stock", weightBp: 5400 },
        { assetClass: "intl_stock", weightBp: 3600 },
        { assetClass: "bonds", weightBp: 1000 },
      ]),
    ).toBe("54/36/10");
    expect(splitLabel([])).toBeNull();
  });
});

describe("fidelity, price status and tones", () => {
  it("labels fidelity with the positions date", () => {
    expect(fidelityLabel("balance_only")).toBe("Balance only");
    expect(fidelityLabel("positions", "2026-10-09")).toBe("Positions as of 10/09/26");
    expect(fidelityLabel("positions")).toBe("Positions");
    expect(fidelityLabel("full_history")).toBe("Full history");
    expect(fidelityTone("balance_only")).toBe("neutral");
    expect(fidelityTone("positions")).toBe("info");
    expect(fidelityTone("full_history")).toBe("ok");
  });
  it("describes a price's status", () => {
    expect(priceStatusText({ priceStatus: "current", priceDate: "2026-10-13", tradingDaysBehind: 0, priceSource: "provider" })).toBe("as of 10/13/26 · feed");
    expect(priceStatusText({ priceStatus: "stale", priceDate: "2026-10-08", tradingDaysBehind: 3 })).toBe("stale 3 trading days (10/08/26)");
    expect(priceStatusText({ priceStatus: "stale", priceDate: null, tradingDaysBehind: 1 })).toBe("stale 1 trading day");
    expect(priceStatusText({ priceStatus: "stale", priceDate: "2026-10-08", tradingDaysBehind: null })).toBe("stale (10/08/26)");
    expect(priceStatusText({ priceStatus: "implied", priceDate: "2026-09-30", tradingDaysBehind: 0 })).toBe("implied as of 09/30/26");
    expect(priceStatusText({ priceStatus: "statement", priceDate: "2026-10-09", tradingDaysBehind: 0 })).toBe("statement · 10/09/26");
    expect(priceStatusText({ priceStatus: "carried", priceDate: null, tradingDaysBehind: 0 })).toBe("carried from statement");
    expect(priceStatusText({ priceStatus: "cash", priceDate: null, tradingDaysBehind: 0 })).toBe("cash");
    expect(priceStatusText({ priceStatus: "missing", priceDate: null, tradingDaysBehind: 0 })).toBe("no price");
    expect(priceStatusTone("current")).toBe("ok");
    expect(priceStatusTone("stale")).toBe("warn");
    expect(priceStatusTone("missing")).toBe("bad");
    expect(priceStatusTone("implied")).toBe("info");
  });
  it("tones drift and labels cost coverage", () => {
    expect(driftTone({ driftBp: 970, outOfBand: true })).toBe("warn");
    expect(driftTone({ driftBp: -124, outOfBand: false })).toBe("ok");
    expect(driftTone({ driftBp: null, outOfBand: false })).toBe("neutral");
    expect(coverageLabel("partial", "lots")).toBe("partial");
    expect(coverageLabel("full", "statement")).toBe("from statement");
    expect(coverageLabel("partial", "statement")).toBe("partial · from statement");
    expect(coverageLabel("full", "lots")).toBeNull();
    expect(coverageLabel("none", null)).toBeNull();
  });
});

describe("sentences", () => {
  it("writes the day change", () => {
    expect(dayChangeSentence({ cents: "36000", bp: 80, prior: "2026-10-12", reason: null })).toBe("+$360.00 (+0.80%) since 10/12/26");
    expect(dayChangeSentence({ cents: "-500", bp: null, prior: null, reason: null })).toBe("-$5.00");
    expect(dayChangeSentence({ cents: null, prior: null, reason: "balance_only" })).toBe("— (balance only: no holdings to price)");
    expect(dayChangeSentence({ cents: null, prior: null, reason: null })).toBe("—");
  });
  it("writes the period change (design: +$10,252.00: $5,000.00 added, $5,252.00 growth (incl. $324.35 income))", () => {
    expect(changeSentence({ from: "2025-10-13", changeCents: "1025200", netFlowsCents: "500000", growthCents: "525200", growthReason: null, incomeCents: "32435" })).toBe(
      "+$10,252.00: $5,000.00 added, $5,252.00 growth (incl. $324.35 income)",
    );
    expect(changeSentence({ from: "2025-10-13", changeCents: "-20000", netFlowsCents: "-100000", growthCents: "80000", growthReason: null, incomeCents: "0" })).toBe(
      "-$200.00: $1,000.00 withdrawn, $800.00 growth",
    );
    expect(changeSentence({ from: "2025-10-13", changeCents: "3200", netFlowsCents: "0", growthCents: "3200", growthReason: null, incomeCents: "0" })).toBe("+$32.00: $32.00 growth");
    expect(changeSentence({ from: "2025-10-13", changeCents: "100000", netFlowsCents: "0", growthCents: null, growthReason: "flows_not_in_value", incomeCents: "0" })).toBe(
      "+$1,000.00: growth unknown (transfers since the last statement are not in the value (cash inference is off, or shares arrived in kind))",
    );
    expect(changeSentence({ from: "2025-10-13", changeCents: null, netFlowsCents: "0", growthCents: null, growthReason: null, incomeCents: "0" })).toBe("no value at 10/13/25");
  });
  it("captions a partial period change with the accounts left out, and says nothing when complete", () => {
    const names = new Map([
      ["r", "Fidelity Roth IRA"],
      ["b", "Vanguard Brokerage"],
    ]);
    const nameOf = (id: string) => names.get(id);
    expect(periodChangePartialText({ partial: true, missingAccountIds: ["r"] }, nameOf)).toBe("partial: Fidelity Roth IRA had a value at the start but none at the end and was left out");
    expect(periodChangePartialText({ partial: true, missingAccountIds: ["r", "b"] }, nameOf)).toBe(
      "partial: 2 accounts (Fidelity Roth IRA, Vanguard Brokerage) had a value at the start but none at the end and were left out",
    );
    expect(periodChangePartialText({ partial: true, missingAccountIds: ["x"] }, nameOf)).toBe("partial: an account had a value at the start but none at the end and was left out");
    expect(periodChangePartialText({ partial: false, missingAccountIds: [] }, nameOf)).toBeNull();
    // A `partial` flag without names is not a caption (the contract ties the two together).
    expect(periodChangePartialText({ partial: true, missingAccountIds: [] }, nameOf)).toBeNull();
  });
  it("explains an account the chain cannot value yet (the Portfolio's 'No values yet' rows)", () => {
    expect(noValueYetText({ accountName: "Schwab", positionsDate: null })).toBe("Schwab has no positions, statement balance or prices on file yet.");
    expect(noValueYetText({ accountName: "Schwab", positionsDate: "2026-10-09" })).toBe("Schwab has positions as of 10/09/26 but no price to value them with yet.");
  });
  it("writes rebalance trades as sentences (views design §3.7 worked example)", () => {
    expect(tradeSentence({ action: "sell", assetClass: "us_stock", ticker: "VTI", inAccount: true, amountCents: "439200", approxQuantity: "14.0544" })).toBe("sell $4,392.00 of VTI (~14.05 sh)");
    expect(tradeSentence({ action: "buy", assetClass: "intl_stock", ticker: "VXUS", inAccount: false, amountCents: "268100", approxQuantity: "37.65449438" })).toBe(
      "buy $2,681.00 of VXUS or the plan's equivalent international stock fund (~37.65 sh)",
    );
    expect(tradeSentence({ action: "buy", assetClass: "bonds", ticker: "BND", inAccount: true, amountCents: "115040", approxQuantity: "15.37967914" })).toBe("buy $1,150.40 of BND (~15.38 sh)");
    expect(tradeSentence({ action: "hold_cash", assetClass: "cash", ticker: null, inAccount: true, amountCents: "56060", approxQuantity: null })).toBe("keep $560.60 in cash");
    expect(tradeSentence({ action: "use_cash", assetClass: "cash", ticker: null, inAccount: true, amountCents: "27000", approxQuantity: null })).toBe("use $270.00 of cash");
    expect(tradeSentence({ action: "buy", assetClass: "real_estate", ticker: null, inAccount: false, amountCents: "10000", approxQuantity: null })).toBe("buy $100.00 of a real estate fund (new position)");
  });
  it("groups trades by account in generation order", () => {
    const t = (accountId: string, accountName: string, action: "sell" | "buy") => ({ accountId, accountName, taxTreatment: "roth" as const, action });
    const groups = groupTrades([t("r", "Roth", "sell"), t("r", "Roth", "buy"), t("b", "Brokerage", "sell"), t("r", "Roth", "buy")]);
    expect(groups.map((g) => [g.accountName, g.trades.length])).toEqual([
      ["Roth", 2],
      ["Brokerage", 1],
      ["Roth", 1],
    ]);
  });
  it("describes how each account was valued", () => {
    expect(valuationDescription({ basis: "snapshot", valuationSource: "simplefin", positionsDate: "2026-10-13" })).toBe("from SimpleFIN");
    expect(valuationDescription({ basis: "positions", valuationSource: "computed", positionsDate: "2026-10-09" })).toBe("computed from prices (positions as of 10/09/26)");
    expect(valuationDescription({ basis: "lots", valuationSource: null, positionsDate: null })).toBe("from trade history");
    expect(valuationDescription({ basis: "balance", valuationSource: "manual", positionsDate: null })).toBe("balance from a statement");
    expect(valuationDescription({ basis: "none", valuationSource: null, positionsDate: null })).toBe("no value yet");
    expect(
      asOfLine([
        { accountName: "Vanguard Brokerage", basis: "snapshot", valuationSource: "simplefin", positionsDate: "2026-10-13" },
        { accountName: "Fidelity Roth IRA", basis: "positions", valuationSource: "computed", positionsDate: "2026-10-09" },
      ]),
    ).toBe("Vanguard Brokerage from SimpleFIN, Fidelity Roth IRA computed from prices (positions as of 10/09/26)");
  });
});

describe("URL parameters and the chart range", () => {
  const today = "2026-10-13";
  it("reads the period, falling back for a bad custom range", () => {
    expect(periodFromParams(new URLSearchParams("period=3m"), today)).toEqual({ period: "3m" });
    expect(periodFromParams(new URLSearchParams(""), today)).toEqual({ period: "1y" });
    expect(periodFromParams(new URLSearchParams("period=weird"), today, "ytd")).toEqual({ period: "ytd" });
    expect(periodFromParams(new URLSearchParams("period=custom&from=2026-01-01&to=2026-06-30"), today)).toEqual({ period: "custom", from: "2026-01-01", to: "2026-06-30" });
    expect(periodFromParams(new URLSearchParams("period=custom&from=2026-06-30&to=2026-01-01"), today)).toEqual({ period: "1y" });
    expect(periodFromParams(new URLSearchParams("period=custom&from=2026-01-01&to=2026-12-31"), today)).toEqual({ period: "1y" });
    expect(periodFromParams(new URLSearchParams("period=custom&from=2026-01-01"), today)).toEqual({ period: "1y" });
    expect(periodQuery({ period: "custom", from: "2026-01-01", to: "2026-06-30" })).toEqual({ period: "custom", from: "2026-01-01", to: "2026-06-30" });
    expect(periodQuery({ period: "1y" })).toEqual({ period: "1y" });
  });
  it("reads asOf only when it is a date on or before today", () => {
    expect(asOfFromParams(new URLSearchParams("asOf=2026-10-01"), today)).toBe("2026-10-01");
    expect(asOfFromParams(new URLSearchParams("asOf=2026-10-14"), today)).toBeNull();
    expect(asOfFromParams(new URLSearchParams("asOf=yesterday"), today)).toBeNull();
    expect(asOfFromParams(new URLSearchParams(""), today)).toBeNull();
  });
  it("picks the series step from the range and the chart range from the period", () => {
    expect(autoSeriesStep("2026-09-13", "2026-10-13")).toBe("day");
    expect(autoSeriesStep("2025-09-08", "2026-10-13")).toBe("day");
    expect(autoSeriesStep("2025-09-07", "2026-10-13")).toBe("week");
    expect(autoSeriesStep("2021-10-13", "2026-10-13")).toBe("month");
    expect(chartRange("2026-10-13", { from: "2025-10-13" })).toEqual({ from: "2025-10-13", to: "2026-10-13" });
    expect(chartRange("2026-10-13", null)).toEqual({ from: "2026-09-13", to: "2026-10-13" });
    expect(chartRange("2026-03-01", null)).toEqual({ from: "2026-01-30", to: "2026-03-01" });
    expect(chartRange("2026-10-13", { from: "2026-10-13" })).toEqual({ from: "2026-10-12", to: "2026-10-13" });
  });
});

describe("targets editor", () => {
  it("converts percent inputs to basis points and back", () => {
    expect(percentToBp("50")).toBe(5000);
    expect(percentToBp("33.33")).toBe(3333);
    expect(percentToBp("0.5")).toBe(50);
    expect(percentToBp("100")).toBe(10000);
    expect(percentToBp("100.01")).toBeNull();
    expect(percentToBp("12.345")).toBeNull();
    expect(percentToBp("-5")).toBeNull();
    expect(percentToBp("abc")).toBeNull();
    expect(bpToPercentInput(5000)).toBe("50");
    expect(bpToPercentInput(3333)).toBe("33.33");
    expect(bpToPercentInput(50)).toBe("0.5");
    expect(bpToPercentInput(0)).toBe("0");
    expect(bpToPercentInput(null)).toBe("");
  });
  it("prefills from the targets, or from the current percentages when none are set", () => {
    const classes = [
      { assetClass: "us_stock" as const, targetBp: 5000, currentBp: 5970 },
      { assetClass: "intl_stock" as const, targetBp: 2500, currentBp: 1907 },
      { assetClass: "bonds" as const, targetBp: 2000, currentBp: 1745 },
      { assetClass: "cash" as const, targetBp: 500, currentBp: 376 },
      { assetClass: "real_estate" as const, targetBp: 0, currentBp: 0 },
      { assetClass: "other" as const, targetBp: 0, currentBp: null },
    ];
    expect(targetsForm(classes, true)).toEqual({ us_stock: "50", intl_stock: "25", bonds: "20", cash: "5", real_estate: "", other: "" });
    expect(targetsForm(classes, false)).toEqual({ us_stock: "59.7", intl_stock: "19.07", bonds: "17.45", cash: "3.76", real_estate: "", other: "" });
    expect(ASSET_CLASSES).toEqual(["us_stock", "intl_stock", "bonds", "cash", "real_estate", "other"]);
  });
  it("sums and validates the form", () => {
    const ok = { us_stock: "50", intl_stock: "25", bonds: "20", cash: "5", real_estate: "", other: "" };
    expect(targetsSumBp(ok)).toBe(10000);
    expect(parseTargetsForm(ok)).toEqual({
      ok: true,
      targets: [
        { assetClass: "us_stock", targetBp: 5000 },
        { assetClass: "intl_stock", targetBp: 2500 },
        { assetClass: "bonds", targetBp: 2000 },
        { assetClass: "cash", targetBp: 500 },
      ],
    });
    const short = { ...ok, cash: "4.5" };
    expect(targetsSumBp(short)).toBe(9950);
    expect(parseTargetsForm(short)).toEqual({ ok: false, error: "Targets must add up to 100.00% (now 99.50%)" });
    const bad = { ...ok, cash: "five" };
    expect(targetsSumBp(bad)).toBeNull();
    expect(parseTargetsForm(bad)).toEqual({ ok: false, error: "Cash: enter a percentage from 0 to 100 with at most two decimals" });
    const blank = { us_stock: "", intl_stock: "", bonds: "", cash: "", real_estate: "", other: "" };
    expect(targetsSumBp(blank)).toBe(0);
    expect(parseTargetsForm(blank)).toEqual({ ok: true, targets: [] });
    expect(parseTargetsForm({ ...blank, us_stock: "0" })).toEqual({ ok: true, targets: [] });
  });
  it("converts the band and the minimum trade", () => {
    expect(bpToPpInput(500)).toBe("5.0");
    expect(bpToPpInput(250)).toBe("2.5");
    expect(bpToPpInput(0)).toBe("0.0");
    expect(ppToBp("5")).toBe(500);
    expect(ppToBp("2.5")).toBe(250);
    expect(ppToBp("50.0")).toBe(5000);
    expect(ppToBp("50.1")).toBeNull();
    expect(ppToBp("1.25")).toBeNull();
    expect(dollarsToCents("100")).toBe("10000");
    expect(dollarsToCents("$1,234.50")).toBe("123450");
    expect(dollarsToCents("-1")).toBeNull();
    expect(dollarsToCents("")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
  });
});

describe("security split editor", () => {
  it("builds the PUT body from the rows (TR2050 54/36/10, primary us_stock)", () => {
    const rows = [
      { assetClass: "us_stock" as const, percent: "54" },
      { assetClass: "intl_stock" as const, percent: "36" },
      { assetClass: "bonds" as const, percent: "10" },
    ];
    expect(parseSplitsForm("us_stock", rows)).toEqual({
      ok: true,
      body: {
        assetClass: "us_stock",
        splits: [
          { assetClass: "us_stock", weightBp: 5400 },
          { assetClass: "intl_stock", weightBp: 3600 },
          { assetClass: "bonds", weightBp: 1000 },
        ],
      },
    });
    expect(parseSplitsForm("cash", rows)).toEqual({ ok: false, error: "The primary class (Cash) must be one of the split classes" });
    expect(parseSplitsForm("us_stock", [...rows, { assetClass: "bonds", percent: "1" }])).toEqual({ ok: false, error: "Bonds appears twice" });
    expect(parseSplitsForm("us_stock", rows.slice(0, 2))).toEqual({ ok: false, error: "Splits must add up to 100.00% (now 90.00%)" });
    expect(parseSplitsForm("us_stock", [{ assetClass: "us_stock", percent: "x" }])).toEqual({ ok: false, error: "US stock: enter a percentage from 0 to 100 with at most two decimals" });
    expect(parseSplitsForm("bonds", [])).toEqual({ ok: true, body: { assetClass: "bonds", splits: null } });
    expect(parseSplitsForm("bonds", [{ assetClass: "bonds", percent: "" }, { assetClass: "cash", percent: "0" }])).toEqual({ ok: true, body: { assetClass: "bonds", splits: null } });
    expect(splitRows([{ assetClass: "us_stock", weightBp: 5400 }])).toEqual([{ assetClass: "us_stock", percent: "54" }]);
    expect(splitRows([])).toEqual([]);
  });
});

describe("allocation bars", () => {
  it("scales the bars to the widest share", () => {
    const classes = [
      { currentBp: 5970, targetBp: 5000 },
      { currentBp: 1907, targetBp: 2500 },
      { currentBp: 0, targetBp: null },
    ];
    expect(barScaleBp(classes)).toBe(5970);
    expect(barWidth(5970, 5970)).toBe(100);
    expect(barWidth(2985, 5970)).toBe(50);
    expect(barWidth(null, 5970)).toBe(0);
    expect(barWidth(0, 5970)).toBe(0);
    expect(barScaleBp([{ currentBp: null, targetBp: null }])).toBe(10000);
  });
});

describe("why did it change", () => {
  const summary = { from: "2026-10-12", to: "2026-10-13", startCents: "2673200", endCents: "2705200", changeCents: "32000", changeBp: 119, netFlowsCents: "0", growthCents: "32000", growthReason: null, incomeCents: "0", uncategorizedRows: 0, partial: false, missingAccountIds: [] };
  const holding = (ticker: string, priceEffectCents: string, quantityEffectCents: string) => ({
    securityId: null,
    ticker,
    name: ticker,
    kind: "position" as const,
    quantityFrom: "40",
    quantityTo: "40",
    priceFrom: "310",
    priceTo: "312.5",
    valueFromCents: "0",
    valueToCents: "0",
    deltaCents: (BigInt(priceEffectCents) + BigInt(quantityEffectCents)).toString(),
    priceEffectCents,
    quantityEffectCents,
  });
  it("sums the worked example B (10/12 → 10/13): VTI +10,000, VXUS +12,000, AAPL +10,000, residual 0 = +32,000 exactly", () => {
    const t = attributionTotals({ summary, holdings: [holding("VTI", "10000", "0"), holding("VXUS", "12000", "0"), holding("AAPL", "10000", "0")], residualEffectCents: "0" });
    expect(t).toEqual({ priceEffectCents: 32000n, quantityEffectCents: 0n, residualEffectCents: 0n, totalCents: 32000n, balanced: true });
  });
  it("flags rows that do not add up to the change, and accepts a change without a start value", () => {
    expect(attributionTotals({ summary, holdings: [holding("VTI", "10000", "0")], residualEffectCents: "0" }).balanced).toBe(false);
    // R (10/12 → 10/13): VTI +5,000, BND −1,000, TR2050 0, cash 0 → +4,000
    const r = attributionTotals({ summary: { ...summary, changeCents: "4000" }, holdings: [holding("VTI", "5000", "0"), holding("BND", "-1000", "0"), holding("TR2050", "0", "0")], residualEffectCents: "0" });
    expect(r.totalCents).toBe(4000n);
    expect(r.balanced).toBe(true);
    expect(attributionTotals({ summary: { ...summary, changeCents: null }, holdings: [], residualEffectCents: "310000" }).balanced).toBe(true);
  });
  it("offers the day and the period windows only when each is a real span", () => {
    const portfolio = { asOf: "2026-10-13", dayChange: { cents: "32000", bp: 119, asOf: "2026-10-13", prior: "2026-10-12", reason: null, partial: false, excluded: [] } };
    expect(changeWindows(portfolio, { period: { ...summary, from: "2025-10-13" } })).toEqual({ day: { from: "2026-10-12", to: "2026-10-13" }, period: { from: "2025-10-13", to: "2026-10-13" } });
    expect(changeWindows({ ...portfolio, dayChange: { ...portfolio.dayChange, prior: null } }, { period: null })).toEqual({ day: null, period: null });
    expect(changeWindows(portfolio, { period: { ...summary, from: "2026-10-13" } }).period).toBeNull();
    expect(changeWindows({ ...portfolio, asOf: null }, { period: null }).day).toBeNull();
  });
  it("words the balance-only line and the from → to cells", () => {
    expect(marketOrUnknownText({ growthCents: "310000" })).toBe("market or unknown: +$3,100.00");
    expect(marketOrUnknownText({ growthCents: null })).toBe("market or unknown: —");
    expect(fromToText("40", "40", (v) => formatQuantity(v, 4))).toBe("40");
    expect(fromToText("310", "312.5", (v) => formatQuantity(v, 4))).toBe("310 → 312.5");
    expect(fromToText(null, "40", (v) => v)).toBe("— → 40");
    expect(fromToText(null, null, (v) => v)).toBe("—");
  });
});
