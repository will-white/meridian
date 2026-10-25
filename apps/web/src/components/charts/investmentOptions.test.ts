import { describe, expect, it } from "vitest";
import type { ChartTheme } from "./EChart.js";
import { valueOverTimeOption } from "./investmentOptions.js";

const theme: ChartTheme = { ink: "#000", muted: "#666", line: "#ddd", accent: "#06a", bad: "#b00", warn: "#b50", panel: "#fff", dark: false };

describe("valueOverTimeOption", () => {
  const dates = ["2026-10-12", "2026-10-13", "2026-10-14"];
  const total = { key: "total", name: "Portfolio", points: ["448920000", "452520000", null], bold: true };
  const brokerage = { key: "b", name: "Vanguard Brokerage", points: ["267320000", "270520000", null] };
  const roth = { key: "r", name: "Fidelity Roth IRA", points: [null, "182000000", "182000000"] };

  it("plots the total bold in ink and one line per account with gaps for null points", () => {
    const option = valueOverTimeOption({ dates, series: [total, brokerage, roth], theme });
    const series = option.series as Array<Record<string, unknown>>;
    expect(series).toHaveLength(3);
    expect(series[0]!.data).toEqual([4489200, 4525200, null]);
    expect(series[2]!.data).toEqual([null, 1820000, 1820000]);
    expect(series[0]!.connectNulls).toBe(false);
    expect((series[0]!.lineStyle as { width: number; color: string })).toEqual({ width: 3, color: "#000" });
    expect((series[1]!.lineStyle as { width: number; color: string })).toEqual({ width: 2, color: "#2a78d6" });
    expect((series[2]!.lineStyle as { width: number; color: string })).toEqual({ width: 2, color: "#eb6834" });
    expect((option.xAxis as { data: string[] }).data).toEqual(dates);
  });

  it("honours an explicit colour and keeps palette slots for the rest", () => {
    const option = valueOverTimeOption({ dates, series: [{ ...brokerage, color: "#123456" }, roth], theme });
    const series = option.series as Array<Record<string, unknown>>;
    expect((series[0]!.lineStyle as { color: string }).color).toBe("#123456");
    expect((series[1]!.lineStyle as { color: string }).color).toBe("#2a78d6");
  });

  it("formats the tooltip from the cents strings and shows a dash for a gap", () => {
    const option = valueOverTimeOption({ dates, series: [total, brokerage, roth], theme });
    const tooltip = option.tooltip as { formatter: (p: unknown) => string };
    const html = tooltip.formatter([
      { seriesIndex: 0, dataIndex: 1, seriesName: "Portfolio", marker: "" },
      { seriesIndex: 2, dataIndex: 1, seriesName: "Fidelity Roth IRA", marker: "" },
    ]);
    expect(html).toBe("10/13/26<br/>Portfolio: <strong>$4,525,200.00</strong><br/>Fidelity Roth IRA: <strong>$1,820,000.00</strong>");
    expect(tooltip.formatter([{ seriesIndex: 2, dataIndex: 0, seriesName: "Fidelity Roth IRA", marker: "" }])).toBe("10/12/26<br/>Fidelity Roth IRA: <strong>—</strong>");
    expect(tooltip.formatter([])).toBe("");
  });
});
