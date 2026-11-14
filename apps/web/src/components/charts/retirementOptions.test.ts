import { deflateYearTable, FanSeries, type YearTable } from "@meridian/shared";
import { describe, expect, it } from "vitest";
import { money } from "../../lib/format.js";
import { R1_YEAR_TABLE } from "../../lib/retirementFixtures.js";
import type { ChartTheme } from "./EChart.js";
import { fanChartInput, fanChartOption, yearAreaOption, type FanChartInput } from "./retirementOptions.js";

const theme: ChartTheme = { ink: "#000", muted: "#666", line: "#ddd", accent: "#06a", bad: "#b00", warn: "#b50", panel: "#fff", dark: false };

type Series = Array<Record<string, unknown>>;
type Formatter = (p: unknown) => string;

/** CH-2's bands at index 2 (age 67, 2029); the other indices are filler. */
function ch2Input(overrides: Partial<FanChartInput> = {}): FanChartInput {
  return {
    labels: ["65", "66", "67"],
    years: [2027, 2028, 2029],
    bands: {
      p10: ["0", "0", "100000"],
      p25: ["0", "0", "150000"],
      p50: ["0", "0", "225000"],
      p75: ["0", "0", "300000"],
      p90: ["0", "0", "500000"],
    },
    theme,
    ...overrides,
  };
}

const seriesOf = (input: FanChartInput) => fanChartOption(input).series as Series;
const tooltipOf = (input: FanChartInput) => (fanChartOption(input).tooltip as { formatter: Formatter }).formatter;

describe("fanChartOption (strategies-outputs-web §5.7)", () => {
  it("CH-1 six series without an overlay, seven with; series 0 stacked and invisible; the median unstacked with width 3", () => {
    const plain = seriesOf(ch2Input());
    expect(plain).toHaveLength(6);
    expect(seriesOf(ch2Input({ overlay: { name: "This path", points: ["0", "0", "200000"] } }))).toHaveLength(7);
    expect(plain[0]!.stack).toBe("fan");
    expect(plain[0]!.lineStyle).toEqual({ width: 0, opacity: 0 });
    expect(plain[0]!.areaStyle).toBeUndefined();
    expect(plain[0]!.silent).toBe(true);
    for (const i of [1, 2, 3, 4]) expect(plain[i]!.stack).toBe("fan");
    expect((plain[1]!.areaStyle as { opacity: number }).opacity).toBe(0.15);
    expect((plain[2]!.areaStyle as { opacity: number }).opacity).toBe(0.3);
    expect((plain[3]!.areaStyle as { opacity: number }).opacity).toBe(0.3);
    expect((plain[4]!.areaStyle as { opacity: number }).opacity).toBe(0.15);
    expect(plain[5]!.stack).toBeUndefined();
    expect(plain[5]!.lineStyle).toEqual({ width: 3, color: "#06a" });
    const overlay = seriesOf(ch2Input({ overlay: { name: "This path", points: ["0", "0", "200000"] } }))[6]!;
    expect(overlay.stack).toBeUndefined();
    expect(overlay.lineStyle).toEqual({ width: 1.5, color: "#000", type: "dashed" });
  });

  it("CH-2 band data: p10 1000, then the differences 500, 750, 750, 2000, and the median 2250", () => {
    // 150000 − 100000 = 50000 cents = $500; 225000 − 150000 = $750; 300000 − 225000 = $750; 500000 − 300000 = $2000.
    const series = seriesOf(ch2Input());
    expect(series.map((s) => (s.data as number[])[2])).toEqual([1000, 500, 750, 750, 2000, 2250]);
  });

  it("CH-3 tooltip from the cents strings: 'Age 67 (2029)' then the five percentiles; '' for an empty parameter list", () => {
    const format = tooltipOf(ch2Input());
    expect(format([{ dataIndex: 2 }, { dataIndex: 2 }]).split("<br/>")).toEqual([
      "Age 67 (2029)",
      "90th: $5,000.00",
      "75th: $3,000.00",
      "Median: $2,250.00",
      "25th: $1,500.00",
      "10th: $1,000.00",
    ]);
    expect(format([])).toBe("");
    // The path and the funded share follow when given (strategies §5.5 item 3).
    const withMore = tooltipOf(ch2Input({ overlay: { name: "Path #4,312", points: ["0", "0", "212345"] }, fundedBp: [10000, 9950, 9425] }));
    expect(withMore([{ dataIndex: 2 }]).split("<br/>").slice(6)).toEqual(["Path #4,312: $2,123.45", "94% of futures still funded at this age"]);
  });

  it("CH-4 a marker at index 2 is one markLine entry with xAxis 2 on the median series; the y axis starts at 0", () => {
    const option = fanChartOption(ch2Input({ markers: [{ index: 2, label: "Retirement" }] }));
    const series = option.series as Series;
    const markLine = series[5]!.markLine as { data: Array<Record<string, unknown>> };
    expect(markLine.data).toEqual([{ xAxis: 2, name: "Retirement", label: { formatter: "Retirement" } }]);
    for (const i of [0, 1, 2, 3, 4]) expect(series[i]!.markLine).toBeUndefined();
    expect((option.yAxis as { min: number }).min).toBe(0);
    // A marker outside the categories is dropped rather than drawn off the chart.
    const outside = fanChartOption(ch2Input({ markers: [{ index: 3, label: "Medicare" }] }));
    expect(((outside.series as Series)[5]!.markLine as { data: unknown[] }).data).toEqual([]);
  });

  it("CH-5 p25 below p10 plots that difference as 0; the tooltip still shows the true strings", () => {
    const input = ch2Input();
    input.bands.p25 = ["0", "0", "90000"];
    const series = seriesOf(input);
    expect((series[1]!.data as number[])[2]).toBe(0);
    // 225000 − 90000 = 135000 cents: the next band is still measured from the true p25.
    expect((series[2]!.data as number[])[2]).toBe(1350);
    expect(tooltipOf(input)([{ dataIndex: 2 }]).split("<br/>")[4]).toBe("25th: $900.00");
  });

  it("escapes a path name in the tooltip and neutralizes braces in canvas labels", () => {
    const hostile = "Alex <img src=x onerror=alert(1)> {b}";
    const input = ch2Input({ overlay: { name: hostile, points: ["0", "0", "1"] }, markers: [{ index: 1, label: "{a|Alex} retires" }] });
    const option = fanChartOption(input);
    const html = (option.tooltip as { formatter: Formatter }).formatter([{ dataIndex: 2 }]);
    expect(html).toContain("Alex &lt;img src=x onerror=alert(1)&gt; {b}: $0.01");
    expect(html).not.toContain("<img");
    const series = option.series as Series;
    expect(series[6]!.name).toBe("Alex <img src=x onerror=alert(1)> (b)");
    expect((series[5]!.markLine as { data: Array<{ name: string }> }).data[0]!.name).toBe("(a|Alex) retires");
  });

  it("by year: the header names the year, and the funded line says 'this year'", () => {
    const format = tooltipOf(ch2Input({ labels: ["2027", "2028", "2029"], axis: "year", fundedBp: [10000, 10000, 10000] }));
    const lines = format([{ dataIndex: 2 }]).split("<br/>");
    expect(lines[0]).toBe("2029");
    expect(lines[6]).toBe("100% of futures still funded this year");
  });
});

/** Strategies §3.10's fan of four years, with two people and a spending fan from plan year 2. */
function exampleFan(): FanSeries {
  const band = (values: string[]) => ({ p10: values, p25: values, p50: values, p75: values, p90: values });
  return FanSeries.parse({
    schemaVersion: 1,
    years: [2026, 2027, 2028, 2029],
    ages: [
      [64, 65, 66, 67],
      [61, 62, 63, 64],
    ],
    aliveCount: [4, 4, 4, 4],
    fundedBp: [10000, 10000, 10000, 7500],
    truncated: true,
    real: { p10: ["90", "180", "270", "360"], p25: ["95", "190", "285", "380"], p50: ["100", "200", "300", "400"], p75: ["105", "210", "315", "420"], p90: ["110", "220", "330", "440"] },
    nominal: band(["100", "205", "315", "430"]),
    spendingFromIndex: 2,
    spendingReal: band(["10", "11"]),
  });
}

describe("fanChartInput: a stored FanSeries by age and by year", () => {
  it("portfolio in today's dollars, x by both people's ages, the funded share, markers by year, the truncation note", () => {
    const view = fanChartInput(exampleFan(), {
      view: "portfolio",
      dollars: "today",
      theme,
      markers: [
        { year: 2027, label: "Alex retires" },
        { year: 2027, label: "Medicare" },
        { year: 2040, label: "outside the fan" },
        { year: 2029, label: "First RMD" },
      ],
    });
    expect(view.unit).toBe("today");
    expect(view.chart.labels).toEqual(["64 / 61", "65 / 62", "66 / 63", "67 / 64"]);
    expect(view.chart.years).toEqual([2026, 2027, 2028, 2029]);
    expect(view.chart.bands.p50).toEqual(["100", "200", "300", "400"]);
    expect(view.chart.fundedBp).toEqual([10000, 10000, 10000, 7500]);
    expect(view.chart.markers).toEqual([
      { index: 1, label: "Alex retires · Medicare" },
      { index: 3, label: "First RMD" },
    ]);
    expect(view.truncatedNote).toBe("Later ages are omitted: too few simulated lifetimes reach them.");
    const header = (fanChartOption(view.chart).tooltip as { formatter: Formatter }).formatter([{ dataIndex: 3 }]).split("<br/>")[0];
    expect(header).toBe("Ages 67 / 64 (2029)");
  });

  it("nominal dollars by year", () => {
    const view = fanChartInput(exampleFan(), { view: "portfolio", dollars: "nominal", axis: "year", theme });
    expect(view.unit).toBe("nominal");
    expect(view.chart.labels).toEqual(["2026", "2027", "2028", "2029"]);
    expect(view.chart.bands.p90).toEqual(["100", "205", "315", "430"]);
  });

  it("the spending view starts at the first drawdown year and is in today's dollars whatever the toggle says", () => {
    const view = fanChartInput(exampleFan(), { view: "spending", dollars: "nominal", theme, markers: [{ year: 2027, label: "before drawdown" }, { year: 2028, label: "Retirement" }] });
    expect(view.unit).toBe("today");
    expect(view.chart.years).toEqual([2028, 2029]);
    expect(view.chart.labels).toEqual(["66 / 63", "67 / 64"]);
    expect(view.chart.bands.p10).toEqual(["10", "11"]);
    expect(view.chart.fundedBp).toEqual([10000, 7500]);
    expect(view.chart.markers).toEqual([{ index: 0, label: "Retirement" }]);
  });

  it("the overlay is the path's ending totals by year, in the fan's unit, cut where the fan or the path ends", () => {
    const table = R1_YEAR_TABLE;
    const fan = FanSeries.parse({
      schemaVersion: 1,
      years: [2027, 2028, 2029],
      ages: [
        [65, 66, 67],
        [65, 66, 67],
      ],
      aliveCount: [1, 1, 1],
      fundedBp: [10000, 10000, 10000],
      truncated: false,
      real: { p10: ["0", "0", "0"], p25: ["0", "0", "0"], p50: ["0", "0", "0"], p75: ["0", "0", "0"], p90: ["0", "0", "0"] },
      nominal: { p10: ["0", "0", "0"], p25: ["0", "0", "0"], p50: ["0", "0", "0"], p75: ["0", "0", "0"], p90: ["0", "0", "0"] },
      spendingFromIndex: 0,
      spendingReal: { p10: ["0", "0", "0"], p25: ["0", "0", "0"], p50: ["0", "0", "0"], p75: ["0", "0", "0"], p90: ["0", "0", "0"] },
    });
    const real = fanChartInput(fan, { view: "portfolio", dollars: "today", theme, overlay: { name: "This path", table } });
    expect(real.chart.overlay).toEqual({ name: "This path", points: table.rows.slice(0, 3).map((r) => r.ending.totalReal) });
    const nominal = fanChartInput(fan, { view: "portfolio", dollars: "nominal", theme, overlay: { name: "This path", table } });
    expect(nominal.chart.overlay!.points).toEqual(table.rows.slice(0, 3).map((r) => r.ending.total));
    const spending = fanChartInput(fan, { view: "spending", dollars: "today", theme, overlay: { name: "This path", table } });
    expect(spending.chart.overlay!.points).toEqual(deflateYearTable(table).rows.slice(0, 3).map((r) => r.spending.funded));
    // A path that ends before the fan: points stop with its last row.
    const short: YearTable = { ...table, rows: table.rows.slice(0, 2) };
    expect(fanChartInput(fan, { view: "portfolio", dollars: "today", theme, overlay: { name: "p", table: short } }).chart.overlay!.points).toHaveLength(2);
  });
});

describe("yearAreaOption: the year table's stacked areas by bucket", () => {
  it("R1 balances: one stacked area per bucket that ever holds money, in bucket order, with the total in the tooltip", () => {
    const option = yearAreaOption({ table: R1_YEAR_TABLE, measure: "balances", dollars: "nominal", theme });
    const series = option.series as Series;
    // R1's accounts: cash, taxable, two pre-tax and one Roth. The HSA bucket is empty, and the cash
    // account is spent in 2027 (OUT-11: "depletion lists cash (2027)"), so it ends every year at 0:
    // both are left out of the balances.
    expect(series.map((s) => s.name)).toEqual(["Taxable", "Pre-tax", "Roth"]);
    expect(R1_YEAR_TABLE.rows.every((r) => r.ending.byBucket.cash === "0" && r.ending.byBucket.hsa === "0")).toBe(true);
    for (const s of series) expect(s.stack).toBe("balances");
    expect((option.xAxis as { data: string[] }).data).toHaveLength(21);
    const first = R1_YEAR_TABLE.rows[0]!;
    expect((series[1]!.data as number[])[0]).toBe(Number(first.ending.byBucket.pre_tax) / 100);
    const lines = (option.tooltip as { formatter: Formatter }).formatter([{ dataIndex: 0 }]).split("<br/>");
    expect(lines[0]).toBe("2027 (ages 65 / 65)");
    expect(lines.at(-1)).toBe(`Total: ${money(first.ending.total)}`);
    expect((option.yAxis as { min: number }).min).toBe(0);
  });

  it("withdrawals in today's dollars come from the deflated table", () => {
    const option = yearAreaOption({ table: R1_YEAR_TABLE, measure: "withdrawals", dollars: "today", theme });
    const real = deflateYearTable(R1_YEAR_TABLE);
    const series = option.series as Series;
    // The withdrawals include the 2027 draw on the cash account; the Roth account, last in the
    // order, is never drawn in R1 (the plan stays funded), so it has no area here.
    expect(series.map((s) => s.name)).toEqual(["Taxable", "Pre-tax", "Cash"]);
    expect(R1_YEAR_TABLE.rows.every((r) => r.withdrawals.byBucket.roth === "0")).toBe(true);
    const taxable = series.find((s) => s.name === "Taxable")!;
    expect((taxable.data as number[])[0]).toBe(Number(real.rows[0]!.withdrawals.byBucket.taxable) / 100);
    const lines = (option.tooltip as { formatter: Formatter }).formatter([{ dataIndex: 0 }]).split("<br/>");
    expect(lines.at(-1)).toMatch(/^Withdrawn: \$/);
  });
});
