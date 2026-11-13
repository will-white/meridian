import { describe, expect, it } from "vitest";
import type { ChartTheme } from "../charts/EChart.js";
import { growthOf10kOption } from "./GrowthChart.js";

const theme: ChartTheme = { ink: "#000", muted: "#666", line: "#ddd", accent: "#06a", bad: "#b00", warn: "#b50", panel: "#fff", dark: false };

describe("growth-of-$10,000 tooltip and feed text (a6-text-rules-accounts-01)", () => {
  it("escapes account and benchmark names instead of inserting them as markup", () => {
    const hostile = "Brokerage <meta http-equiv=refresh content=0;url=/api/health?";
    const option = growthOf10kOption({
      lines: [
        { key: "a", name: hostile, color: "#123456", points: [{ date: "2026-10-12", indexBp: 10000 }, { date: "2026-10-13", indexBp: 10100 }] },
        { key: "b", name: "Index <b>fund</b>", color: "#654321", dashed: true, points: [{ date: "2026-10-12", indexBp: 10000 }, { date: "2026-10-13", indexBp: 10050 }] },
      ],
      theme,
    });
    const tooltip = option.tooltip as { formatter: (p: unknown) => string };
    const html = tooltip.formatter([
      { seriesIndex: 0, dataIndex: 1, seriesName: hostile, marker: "" },
      { seriesIndex: 1, dataIndex: 1, seriesName: "Index <b>fund</b>", marker: "" },
    ]);
    expect(html).toBe("10/13/26<br/>Brokerage &lt;meta http-equiv=refresh content=0;url=/api/health?: <strong>$10,100.00</strong><br/>Index &lt;b&gt;fund&lt;/b&gt;: <strong>$10,050.00</strong>");
  });
});
