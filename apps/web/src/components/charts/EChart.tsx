import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { LineChart, type LineSeriesOption } from "echarts/charts";
import { GridComponent, MarkLineComponent, MarkPointComponent, TooltipComponent, type GridComponentOption, type TooltipComponentOption } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { ComposeOption } from "echarts/core";

/**
 * Thin React wrapper over a tree-shaken ECharts bundle: line series, grid,
 * tooltip, mark lines and mark points on the canvas renderer. The page builds
 * the option (see chartOptions.ts); this component owns the instance, resizes
 * with its container and re-applies the option when it changes.
 */

echarts.use([LineChart, GridComponent, TooltipComponent, MarkLineComponent, MarkPointComponent, CanvasRenderer]);

export type EChartOption = ComposeOption<LineSeriesOption | GridComponentOption | TooltipComponentOption>;

type Instance = ReturnType<typeof echarts.init>;

export function EChart({ option, height = 260, className, label }: { option: EChartOption; height?: number; className?: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<Instance | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const instance = echarts.init(el, undefined, { renderer: "canvas" });
    chart.current = instance;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => instance.resize());
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={ref} className={className} style={{ height, width: "100%" }} role="img" aria-label={label} />;
}

export interface ChartTheme {
  ink: string;
  muted: string;
  line: string;
  accent: string;
  bad: string;
  warn: string;
  panel: string;
  dark: boolean;
}

const FALLBACK_LIGHT: ChartTheme = { ink: "#0f172a", muted: "#64748b", line: "#e2e8f0", accent: "#0369a1", bad: "#b91c1c", warn: "#b45309", panel: "#ffffff", dark: false };
const FALLBACK_DARK: ChartTheme = { ink: "#e2e8f0", muted: "#94a3b8", line: "#1e293b", accent: "#38bdf8", bad: "#f87171", warn: "#fbbf24", panel: "#111a2e", dark: true };

/** Read the app's colour tokens off `:root` so canvas text and grids match the stylesheet in both schemes. */
export function readChartTheme(): ChartTheme {
  if (typeof window === "undefined" || typeof document === "undefined") return FALLBACK_LIGHT;
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const fallback = dark ? FALLBACK_DARK : FALLBACK_LIGHT;
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fb: string): string => style.getPropertyValue(name).trim() || fb;
  return {
    ink: token("--ink", fallback.ink),
    muted: token("--muted", fallback.muted),
    line: token("--line", fallback.line),
    accent: token("--accent", fallback.accent),
    bad: token("--bad", fallback.bad),
    warn: token("--warn", fallback.warn),
    panel: token("--panel", fallback.panel),
    dark,
  };
}

/** The current theme, refreshed when the OS colour scheme flips. */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState<ChartTheme>(readChartTheme);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const onChange = () => setTheme(readChartTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return theme;
}
