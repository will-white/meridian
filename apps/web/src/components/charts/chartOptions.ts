import { money, shortDate } from "../../lib/format.js";
import type { ChartTheme, EChartOption } from "./EChart.js";

/**
 * Pure option builders for the cash-flow line charts (dashboard card and the
 * cash-flow page). Cents stay strings for every label; the only numbers are
 * the plotted y-values, which are a display conversion and never fed back
 * into money math.
 */

/** Categorical palette (validated for CVD separation in both schemes); slot order is fixed, never cycled. */
const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"] as const;
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"] as const;

/** The colour of categorical slot `index`; slots past the palette fold into a neutral grey. */
export function seriesColor(index: number, theme: Pick<ChartTheme, "dark" | "muted">): string {
  const palette = theme.dark ? SERIES_DARK : SERIES_LIGHT;
  return palette[index] ?? theme.muted;
}

/** Plot value for a cents string: whole dollars with cents as the fraction. Display only. */
export function centsToDollars(cents: string): number {
  return Number(cents) / 100;
}

/** Compact axis label: "$1.2k", "-$500", "$3.4M". Operates on the plotted dollar value. */
export function axisMoney(dollars: number): string {
  const sign = dollars < 0 ? "-" : "";
  const abs = Math.abs(dollars);
  const trim = (n: number, suffix: string): string => {
    const s = n.toFixed(1).replace(/\.0$/, "");
    return `${sign}$${s}${suffix}`;
  };
  if (abs >= 1_000_000) return trim(abs / 1_000_000, "M");
  if (abs >= 1_000) return trim(abs / 1_000, "k");
  return `${sign}$${Math.round(abs)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 13" for an axis tick. */
export function axisDate(iso: string): string {
  const name = MONTHS[Number(iso.slice(5, 7)) - 1] ?? iso.slice(5, 7);
  return `${name} ${Number(iso.slice(8, 10))}`;
}

export interface CashFlowChartSeries {
  key: string;
  name: string;
  /** End-of-day balances in cents, one per date. */
  points: string[];
  thresholdCents: string | null;
  minDate: string;
  minCents: string;
  firstBelowThresholdDate: string | null;
  /** The headline (combined) line: drawn heavier and in the ink colour. */
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
 * One line per series over a shared category axis of dates. Each series with
 * a threshold gets a dashed horizontal mark line; each series marks its lowest
 * day; a vertical marker shows the first day below the threshold.
 */
export function cashFlowChartOption(input: { dates: string[]; series: CashFlowChartSeries[]; theme: ChartTheme; height?: number }): EChartOption {
  const { dates, series, theme } = input;
  let slot = 0;
  const seriesOptions = series.map((s) => {
    const color = s.color ?? (s.bold ? theme.ink : seriesColor(slot++, theme));
    const markLineData: Array<Record<string, unknown>> = [];
    if (s.thresholdCents !== null) {
      markLineData.push({ yAxis: centsToDollars(s.thresholdCents), name: "threshold", lineStyle: { color: theme.bad, type: "dashed", width: 1 } });
    }
    if (s.firstBelowThresholdDate !== null) {
      markLineData.push({ xAxis: s.firstBelowThresholdDate, name: "first below", lineStyle: { color: theme.bad, type: "dotted", width: 1 } });
    }
    return {
      name: s.name,
      type: "line" as const,
      data: s.points.map(centsToDollars),
      showSymbol: false,
      symbolSize: 8,
      lineStyle: { width: s.bold ? 3 : 2, color },
      itemStyle: { color },
      emphasis: { focus: "series" as const },
      z: s.bold ? 3 : 2,
      markPoint: {
        symbol: "circle",
        symbolSize: 10,
        itemStyle: { color: s.bold ? theme.bad : color, borderColor: theme.panel, borderWidth: 2 },
        label: { show: s.bold === true, position: "top" as const, color: theme.ink, formatter: () => `low ${money(s.minCents)}` },
        data: [{ name: "low point", coord: [s.minDate, centsToDollars(s.minCents)] }],
      },
      markLine: {
        silent: true,
        symbol: "none",
        label: { show: false },
        data: markLineData,
      },
    };
  });

  return {
    animation: false,
    textStyle: { color: theme.ink },
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
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
          return `${p.marker ?? ""}${p.seriesName ?? ""}: <strong>${cents === undefined ? "—" : money(cents)}</strong>`;
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
