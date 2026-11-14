import { deflateYearTable, type FanSeries, type PlanBucket, type YearTable } from "@meridian/shared";
import type { LineSeriesOption } from "echarts/charts";
import { escapeHtml, money } from "../../lib/format.js";
import { BUCKETS, ageLabel, agePhrase, bucketLabel, chartText, percentText } from "../../lib/retirementFormat.js";
import { axisMoney, centsToDollars, seriesColor } from "./chartOptions.js";
import type { ChartTheme, EChartOption } from "./EChart.js";

/**
 * Pure option builders for the retirement pages (strategies-outputs-web §5.7), built from what
 * EChart.tsx already registers (line series, grid, tooltip, mark lines): no new ECharts module.
 * Cents stay strings for every label and tooltip; the only numbers are the plotted y values, a
 * display conversion (`centsToDollars`) that is never fed back into money math. Band differences
 * are taken in cents with BigInt before that conversion. Every name in a tooltip goes through
 * `escapeHtml`; every name drawn on the canvas through `chartText`.
 *
 * The design has no gauge and no ending-wealth histogram: the success rate is a large stat
 * (`summaryView` in lib/retirementSummary.ts) and the first failures a bar list. The year table's
 * stacked areas (`yearAreaOption`) show the ending balances or the withdrawals by bucket.
 */

export interface FanBands {
  p10: string[];
  p25: string[];
  p50: string[];
  p75: string[];
  p90: string[];
}

export interface FanChartInput {
  /** x categories: ages ("67" or "67 / 65"), or years with `axis: "year"`. */
  labels: string[];
  years: number[];
  /** Cents, one per x category. */
  bands: FanBands;
  /** The selected path, cents. */
  overlay?: { name: string; points: string[] };
  markers?: Array<{ index: number; label: string }>;
  /** The share of all paths still funded at the end of each year, basis points. */
  fundedBp?: number[];
  /** What `labels` hold; ages by default (§5.5 item 3: "the x axis is the first person's age"). */
  axis?: "age" | "year";
  theme: ChartTheme;
}

interface TooltipParam {
  dataIndex?: number;
}

function isTooltipParam(p: unknown): p is TooltipParam {
  return typeof p === "object" && p !== null;
}

/** `b − a` in cents, never below 0 (a band whose order is broken is drawn flat; the tooltip keeps the true strings). */
function gap(a: string, b: string): number {
  const d = BigInt(b) - BigInt(a);
  return d > 0n ? centsToDollars(d.toString()) : 0;
}

const PERCENTILE_ROWS = [
  ["90th", "p90"],
  ["75th", "p75"],
  ["Median", "p50"],
  ["25th", "p25"],
  ["10th", "p10"],
] as const;

/** The fan's tooltip header: "Age 67 (2029)" by age, "2029 (age 67)" by year. */
function fanHeader(input: FanChartInput, i: number): string {
  const label = input.labels[i] ?? "";
  const year = input.years[i];
  if (input.axis === "year") return year === undefined ? label : `${year}`;
  return year === undefined ? agePhrase(label) : `${agePhrase(label)} (${year})`;
}

/**
 * The fan chart (§5.7): 10th to 90th and 25th to 75th percentile bands as stacked differences over
 * an invisible 10th-percentile base, the median line on top carrying the markers as vertical mark
 * lines, and the selected path as a thin dashed line. Series, in order: 0 base (`p10`, stacked,
 * invisible, silent); 1 `p25 − p10`; 2 `p50 − p25`; 3 `p75 − p50`; 4 `p90 − p75` (stacked areas in
 * the accent colour at 0.15, 0.30, 0.30, 0.15); 5 the median (unstacked, width 3); 6 the overlay.
 */
export function fanChartOption(input: FanChartInput): EChartOption {
  const { bands, theme } = input;
  const n = input.labels.length;
  const at = (series: readonly string[], i: number) => series[i] ?? "0";
  const diff = (lo: readonly string[], hi: readonly string[]) => Array.from({ length: n }, (_, i) => gap(at(lo, i), at(hi, i)));
  const band = (name: string, data: number[], opacity: number) => ({
    name,
    type: "line" as const,
    stack: "fan",
    data,
    showSymbol: false,
    silent: true,
    lineStyle: { width: 0, opacity: 0 },
    areaStyle: { color: theme.accent, opacity },
    emphasis: { disabled: true },
    z: 1,
  });
  const markers = (input.markers ?? []).filter((m) => Number.isInteger(m.index) && m.index >= 0 && m.index < n);
  const series: LineSeriesOption[] = [
    {
      name: "10th percentile",
      type: "line" as const,
      stack: "fan",
      data: Array.from({ length: n }, (_, i) => centsToDollars(at(bands.p10, i))),
      showSymbol: false,
      silent: true,
      lineStyle: { width: 0, opacity: 0 },
      emphasis: { disabled: true },
      z: 1,
    },
    band("10th to 25th", diff(bands.p10, bands.p25), 0.15),
    band("25th to median", diff(bands.p25, bands.p50), 0.3),
    band("median to 75th", diff(bands.p50, bands.p75), 0.3),
    band("75th to 90th", diff(bands.p75, bands.p90), 0.15),
    {
      name: "Median",
      type: "line" as const,
      data: Array.from({ length: n }, (_, i) => centsToDollars(at(bands.p50, i))),
      showSymbol: false,
      lineStyle: { width: 3, color: theme.accent },
      itemStyle: { color: theme.accent },
      z: 3,
      markLine: {
        silent: true,
        symbol: "none",
        lineStyle: { color: theme.muted, type: "dashed" as const, width: 1 },
        label: { show: true, position: "end" as const, color: theme.muted },
        data: markers.map((m) => ({ xAxis: m.index, name: chartText(m.label), label: { formatter: chartText(m.label) } })),
      },
    },
  ];
  const overlay = input.overlay;
  if (overlay !== undefined) {
    series.push({
      name: chartText(overlay.name),
      type: "line" as const,
      data: overlay.points.slice(0, n).map(centsToDollars),
      showSymbol: false,
      lineStyle: { width: 1.5, color: theme.ink, type: "dashed" as const },
      itemStyle: { color: theme.ink },
      z: 4,
    });
  }

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
        const i = list[0]?.dataIndex;
        if (i === undefined || i < 0 || i >= n) return "";
        const lines = [escapeHtml(fanHeader(input, i))];
        for (const [label, key] of PERCENTILE_ROWS) lines.push(`${label}: ${money(bands[key][i] ?? null)}`);
        const point = overlay?.points[i];
        if (overlay !== undefined && point !== undefined) lines.push(`${escapeHtml(overlay.name)}: ${money(point)}`);
        const funded = input.fundedBp?.[i];
        if (funded !== undefined) lines.push(`${percentText(funded, 0)} of futures still funded ${input.axis === "year" ? "this year" : "at this age"}`);
        return lines.join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: input.labels.map(chartText),
      boundaryGap: false,
      axisLine: { lineStyle: { color: theme.line } },
      axisTick: { show: false },
      axisLabel: { color: theme.muted, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      min: 0,
      axisLabel: { color: theme.muted, formatter: (value: number) => axisMoney(value) },
      splitLine: { lineStyle: { color: theme.line } },
    },
    series,
  };
}

/** A marker of the fan by calendar year (`fanMarkers` in lib/retirement.ts). */
export interface YearMarker {
  year: number;
  label: string;
}

export interface FanChartRequest {
  view: "portfolio" | "spending";
  dollars: "today" | "nominal";
  axis?: "age" | "year";
  theme: ChartTheme;
  /** The selected path's stored or re-simulated table, drawn over the fan. */
  overlay?: { name: string; table: YearTable };
  markers?: readonly YearMarker[];
}

export interface FanChartView {
  chart: FanChartInput;
  /** The unit the bands are in: the spending fan is stored in today's dollars only. */
  unit: "today" | "nominal";
  /** Set when later years were cut (`FanSeries.truncated`). */
  truncatedNote?: string;
}

/**
 * The chart input for a stored fan (§5.5 item 3): the portfolio bands in today's or nominal
 * dollars, or the funded-spending bands from the first drawdown year (today's dollars only); x by
 * the people's ages ("67 / 65") or by year; the funded share per year; markers placed by year
 * (several in one year are joined with " · "); and the selected path's ending totals (or its
 * funded spending, deflated with the shared bigint `deflateYearTable`) for the years both show.
 */
export function fanChartInput(fan: FanSeries, request: FanChartRequest): FanChartView {
  const from = request.view === "spending" ? fan.spendingFromIndex : 0;
  const years = fan.years.slice(from);
  const unit = request.view === "spending" ? "today" : request.dollars;
  const source = request.view === "spending" ? fan.spendingReal : unit === "today" ? fan.real : fan.nominal;
  const bands: FanBands = {
    p10: source.p10.slice(0, years.length),
    p25: source.p25.slice(0, years.length),
    p50: source.p50.slice(0, years.length),
    p75: source.p75.slice(0, years.length),
    p90: source.p90.slice(0, years.length),
  };
  const ages = years.map((_, i) => ageLabel(fan.ages.map((person) => person[from + i] ?? 0)));
  const axis = request.axis ?? "age";
  const chart: FanChartInput = {
    labels: axis === "year" ? years.map(String) : ages,
    years,
    bands,
    fundedBp: fan.fundedBp.slice(from, from + years.length),
    axis,
    theme: request.theme,
  };
  if (request.markers !== undefined) {
    const byIndex = new Map<number, string[]>();
    for (const m of request.markers) {
      const index = years.indexOf(m.year);
      if (index < 0) continue;
      const list = byIndex.get(index) ?? [];
      if (!list.includes(m.label)) list.push(m.label);
      byIndex.set(index, list);
    }
    chart.markers = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, labels]) => ({ index, label: labels.join(" · ") }));
  }
  if (request.overlay !== undefined) {
    const table = request.view === "spending" || unit === "today" ? deflateYearTable(request.overlay.table) : request.overlay.table;
    const byYear = new Map(table.rows.map((r) => [r.year, r]));
    const points: string[] = [];
    for (const year of years) {
      const row = byYear.get(year);
      if (row === undefined) break;
      points.push(request.view === "spending" ? row.spending.funded : unit === "today" ? row.ending.totalReal : row.ending.total);
    }
    chart.overlay = { name: request.overlay.name, points };
  }
  const view: FanChartView = { chart, unit };
  if (fan.truncated) view.truncatedNote = "Later ages are omitted: too few simulated lifetimes reach them.";
  return view;
}

export interface YearAreaRequest {
  table: YearTable;
  /** Ending balances by bucket, or the year's withdrawals by bucket. */
  measure: "balances" | "withdrawals";
  dollars: "today" | "nominal";
  theme: ChartTheme;
}

/**
 * The year table's stacked areas: one area per planner bucket (in `PlanBucket` order, a bucket that
 * is 0 in every year left out) over the table's calendar years, ending balances at each year's end
 * or the year's gross withdrawals (RMDs included), nominal or in today's dollars through the shared
 * bigint `deflateYearTable`. The tooltip lists each bucket and the total from the cents strings.
 */
export function yearAreaOption(request: YearAreaRequest): EChartOption {
  const { theme } = request;
  const table = request.dollars === "today" ? deflateYearTable(request.table) : request.table;
  const rows = table.rows;
  const years = rows.map((r) => r.year);
  const valueOf = (i: number, b: PlanBucket): string => {
    const row = rows[i]!;
    return request.measure === "balances" ? row.ending.byBucket[b] : row.withdrawals.byBucket[b];
  };
  const totalOf = (i: number): string => {
    const row = rows[i]!;
    if (request.measure === "withdrawals") return row.withdrawals.total;
    return request.dollars === "today" ? row.ending.totalReal : row.ending.total;
  };
  const shown = BUCKETS.filter((b) => rows.some((_, i) => BigInt(valueOf(i, b)) !== 0n));
  const series = shown.map((b, slot) => {
    const color = seriesColor(slot, theme);
    return {
      name: bucketLabel(b),
      type: "line" as const,
      stack: request.measure,
      data: rows.map((_, i) => centsToDollars(valueOf(i, b))),
      showSymbol: false,
      lineStyle: { width: 1, color },
      itemStyle: { color },
      areaStyle: { color, opacity: 0.55 },
      emphasis: { focus: "series" as const },
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
        const i = list[0]?.dataIndex;
        if (i === undefined || i < 0 || i >= rows.length) return "";
        const row = rows[i]!;
        const head = `${row.year} (${agePhrase(ageLabel(row.ages, row.alive)).toLowerCase()})`;
        const lines = [escapeHtml(head)];
        for (const b of [...shown].reverse()) lines.push(`${escapeHtml(bucketLabel(b))}: ${money(valueOf(i, b))}`);
        lines.push(`${request.measure === "balances" ? "Total" : "Withdrawn"}: ${money(totalOf(i))}`);
        return lines.join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: years.map(String),
      boundaryGap: false,
      axisLine: { lineStyle: { color: theme.line } },
      axisTick: { show: false },
      axisLabel: { color: theme.muted, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      min: 0,
      axisLabel: { color: theme.muted, formatter: (value: number) => axisMoney(value) },
      splitLine: { lineStyle: { color: theme.line } },
    },
    series,
  };
}
