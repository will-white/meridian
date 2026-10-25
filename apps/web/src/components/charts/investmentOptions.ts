import { money, shortDate } from "../../lib/format.js";
import type { ChartTheme, EChartOption } from "./EChart.js";
import { axisDate, axisMoney, centsToDollars, seriesColor } from "./chartOptions.js";

/**
 * Pure option builders for the Investments pages. Like chartOptions.ts, cents
 * stay strings for every label; the plotted y-values are a display conversion
 * only. A null point (no value for an account on that day) is a gap in the
 * line, never a zero.
 */

export interface ValueSeries {
  key: string;
  name: string;
  /** End-of-day values in cents, one per date; null where no value is known. */
  points: Array<string | null>;
  /** The portfolio total: drawn heavier and in the ink colour. */
  bold?: boolean;
  /** Explicit colour; otherwise the next categorical slot. */
  color?: string;
}

interface TooltipParam {
  seriesIndex?: number;
  dataIndex?: number;
  seriesName?: string;
  marker?: string;
}

function isTooltipParam(p: unknown): p is TooltipParam {
  return typeof p === "object" && p !== null;
}

/**
 * The portfolio value over time: the total (bold) plus one line per account
 * over a shared category axis of dates. Gaps where a point is null.
 */
export function valueOverTimeOption(input: { dates: string[]; series: ValueSeries[]; theme: ChartTheme }): EChartOption {
  const { dates, series, theme } = input;
  let slot = 0;
  const seriesOptions = series.map((s) => {
    const color = s.color ?? (s.bold ? theme.ink : seriesColor(slot++, theme));
    return {
      name: s.name,
      type: "line" as const,
      data: s.points.map((p) => (p === null ? null : centsToDollars(p))),
      connectNulls: false,
      showSymbol: false,
      symbolSize: 6,
      lineStyle: { width: s.bold ? 3 : 2, color },
      itemStyle: { color },
      emphasis: { focus: "series" as const },
      z: s.bold ? 3 : 2,
    };
  });

  return {
    animation: false,
    textStyle: { color: theme.ink },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.panel,
      borderColor: theme.line,
      textStyle: { color: theme.ink },
      axisPointer: { type: "line", lineStyle: { color: theme.muted } },
      formatter: (params: unknown): string => {
        const list = (Array.isArray(params) ? params : [params]).filter(isTooltipParam);
        const first = list[0];
        if (!first || first.dataIndex === undefined) return "";
        const date = dates[first.dataIndex] ?? "";
        const rows = list.map((p) => {
          const s = p.seriesIndex === undefined ? undefined : series[p.seriesIndex];
          const cents = s?.points[p.dataIndex ?? 0];
          return `${p.marker ?? ""}${p.seriesName ?? ""}: <strong>${cents === undefined || cents === null ? "—" : money(cents)}</strong>`;
        });
        return [shortDate(date), ...rows].join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: theme.line } },
      axisTick: { show: false },
      axisLabel: { color: theme.muted, formatter: (value: string) => axisDate(value), hideOverlap: true },
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: { color: theme.muted, formatter: (value: number) => axisMoney(value) },
      splitLine: { lineStyle: { color: theme.line } },
    },
    series: seriesOptions,
  };
}
