import { describe, expect, it } from "vitest";
import type { ChartTheme } from "./EChart.js";
import { axisDate, axisMoney, cashFlowChartOption, centsToDollars, seriesColor } from "./chartOptions.js";

const theme: ChartTheme = { ink: "#000", muted: "#666", line: "#ddd", accent: "#06a", bad: "#b00", warn: "#b50", panel: "#fff", dark: false };

describe("axisMoney", () => {
  it("compacts dollar values", () => {
    expect(axisMoney(0)).toBe("$0");
    expect(axisMoney(500)).toBe("$500");
    expect(axisMoney(-500)).toBe("-$500");
    expect(axisMoney(1200)).toBe("$1.2k");
    expect(axisMoney(10000)).toBe("$10k");
    expect(axisMoney(-2500000)).toBe("-$2.5M");
  });
});

describe("centsToDollars / axisDate / seriesColor", () => {
  it("converts for plotting and labels ticks", () => {
    expect(centsToDollars("250000")).toBe(2500);
    expect(centsToDollars("-4500")).toBe(-45);
    expect(axisDate("2026-10-13")).toBe("Oct 13");
    expect(axisDate("2027-01-01")).toBe("Jan 1");
    expect(seriesColor(0, theme)).toBe("#2a78d6");
    expect(seriesColor(0, { ...theme, dark: true })).toBe("#3987e5");
    expect(seriesColor(8, theme)).toBe("#666");
  });
});

describe("cashFlowChartOption", () => {
  const dates = ["2026-10-13", "2026-10-14", "2026-10-15"];
  const combined = { key: "all", name: "All accounts", points: ["250000", "200000", "300000"], thresholdCents: "50000", minDate: "2026-10-14", minCents: "200000", firstBelowThresholdDate: null, bold: true };
  const chk = { key: "chk", name: "Checking", points: ["150000", "100000", "200000"], thresholdCents: null, minDate: "2026-10-14", minCents: "100000", firstBelowThresholdDate: "2026-10-14" };

  it("plots one line per series with marks for thresholds, low points and first-below days", () => {
    const option = cashFlowChartOption({ dates, series: [combined, chk], theme });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series).toHaveLength(2);
    expect(series[0]!.data).toEqual([2500, 2000, 3000]);
    expect((series[0]!.lineStyle as { width: number; color: string }).width).toBe(3);
    expect((series[0]!.lineStyle as { width: number; color: string }).color).toBe("#000");
    expect((series[1]!.lineStyle as { width: number; color: string }).width).toBe(2);
    expect((series[1]!.lineStyle as { width: number; color: string }).color).toBe("#2a78d6");
    const combinedMarks = (series[0]!.markLine as { data: Array<Record<string, unknown>> }).data;
    expect(combinedMarks).toEqual([expect.objectContaining({ yAxis: 500 })]);
    const chkMarks = (series[1]!.markLine as { data: Array<Record<string, unknown>> }).data;
    expect(chkMarks).toEqual([expect.objectContaining({ xAxis: "2026-10-14" })]);
    const low = (series[1]!.markPoint as { data: Array<{ coord: [string, number] }> }).data[0]!;
    expect(low.coord).toEqual(["2026-10-14", 1000]);
  });

  it("formats the tooltip from the cents strings, never from the plotted floats", () => {
    const option = cashFlowChartOption({ dates, series: [combined, chk], theme });
    const tooltip = option.tooltip as { formatter: (p: unknown) => string };
    const html = tooltip.formatter([
      { seriesIndex: 0, dataIndex: 1, seriesName: "All accounts", marker: "" },
      { seriesIndex: 1, dataIndex: 1, seriesName: "Checking", marker: "" },
    ]);
    expect(html).toBe("10/14/26<br/>All accounts: <strong>$2,000.00</strong><br/>Checking: <strong>$1,000.00</strong>");
    expect(tooltip.formatter([])).toBe("");
  });
});
