import { useMemo } from "react";
import { money, shortDate } from "../../lib/format.js";
import { mergeIndexSeries, type IndexLine } from "../../lib/performanceView.js";
import { EChart, type ChartTheme, type EChartOption } from "../charts/EChart.js";
import { axisDate, axisMoney } from "../charts/chartOptions.js";

export interface GrowthLine extends IndexLine {
  color: string;
  /** The household total: heavier. */
  bold?: boolean;
  /** The benchmark: dashed. */
  dashed?: boolean;
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
 * The option for the growth-of-$10,000 chart: every index series merged
 * onto one date axis (the engine's sub-period boundaries), 10 000 bp =
 * $10,000, straight segments between boundaries and gaps before a line's
 * first point. Pure; the component below owns the theme and the canvas.
 */
export function growthOf10kOption(input: { lines: readonly GrowthLine[]; theme: ChartTheme }): EChartOption {
  const { lines, theme } = input;
  const merged = mergeIndexSeries(lines);
  const series = merged.lines.map((l, i) => {
    const style = lines[i]!;
    return {
      name: l.name,
      type: "line" as const,
      data: l.values,
      connectNulls: false,
      showSymbol: merged.dates.length <= 2,
      symbolSize: 6,
      lineStyle: { width: style.bold ? 3 : 2, color: style.color, type: style.dashed ? ("dashed" as const) : ("solid" as const) },
      itemStyle: { color: style.color },
      emphasis: { focus: "series" as const },
      z: style.bold ? 3 : 2,
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
        const date = merged.dates[first.dataIndex] ?? "";
        const rows = list.map((p) => {
          const l = p.seriesIndex === undefined ? undefined : merged.lines[p.seriesIndex];
          const v = l?.values[p.dataIndex ?? 0];
          return `${p.marker ?? ""}${p.seriesName ?? ""}: <strong>${v === undefined || v === null ? "—" : money(String(v * 100))}</strong>`;
        });
        return [shortDate(date), ...rows].join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: merged.dates,
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
    series,
  };
}

/** $10,000 at the period start, grown along each index series (the total bold, the benchmark dashed, accounts in the palette). */
export function GrowthChart({ lines, theme, label }: { lines: readonly GrowthLine[]; theme: ChartTheme; label: string }) {
  const option = useMemo(() => growthOf10kOption({ lines, theme }), [lines, theme]);
  if (lines.every((l) => l.points.length === 0)) return <p className="muted small">No return series to plot yet.</p>;
  return <EChart option={option} height={280} label={label} />;
}
