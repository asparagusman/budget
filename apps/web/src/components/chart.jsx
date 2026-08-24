import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart, SankeyChart } from "echarts/charts";
import {
  CalendarComponent,
  DatasetComponent,
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useResolvedTheme } from "@/lib/theme.jsx";
import { cn } from "@/lib/utils.js";
import { Skeleton } from "@/components/ui/skeleton.jsx";
import { EmptyState } from "@/components/empty-state.jsx";

// Only the chart types this phase's demo route (and the phases that follow
// it) actually use. Add to this list rather than importing all of echarts.
echarts.use([
  LineChart,
  BarChart,
  SankeyChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  CalendarComponent,
  VisualMapComponent,
  DatasetComponent,
  CanvasRenderer,
]);

/** @type {CanvasRenderingContext2D | undefined} */
let colorCtx;

// ECharts' canvas renderer (zrender) parses colours through its own utility,
// which only understands hex/rgb/hsl — not oklch(), which is what our
// tokens are authored in. Anything that needs colour-space MATH (a
// visualMap gradient, a sankey link fade) silently breaks — renders black —
// even though a plain fillStyle string (a bar, a line stroke) works fine
// via the browser's own canvas support for oklch.
//
// Neither getComputedStyle() nor reading fillStyle back helps: modern
// Chromium preserves oklch() as oklch() through both of those rather than
// downconverting it. Actually painting a pixel and reading its bytes back
// via getImageData() can't preserve the color space — it's forced to
// concrete sRGB numbers — so that's what this does instead of any string
// round-trip.
/** @param {string} cssColor */
function toCanvasColor(cssColor) {
  if (!cssColor) return cssColor;
  if (!colorCtx) {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!ctx) return cssColor;
    ctx.canvas.width = 1;
    ctx.canvas.height = 1;
    colorCtx = ctx;
  }
  colorCtx.clearRect(0, 0, 1, 1);
  colorCtx.fillStyle = cssColor;
  colorCtx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a ?? 255) / 255})`;
}

/** @param {string} name */
function readToken(name) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return toCanvasColor(raw);
}

function readChartTokens() {
  return {
    axisLabel: readToken("--chart-axis-label"),
    grid: readToken("--chart-grid"),
    series: [1, 2, 3, 4, 5].map((n) => readToken(`--chart-line-${n}`)),
    surface: readToken("--surface"),
    text: readToken("--text"),
    border: readToken("--border"),
    accentSoft: readToken("--accent-soft"),
  };
}

/** @typedef {ReturnType<typeof readChartTokens>} ChartTokens */

/** @param {ReturnType<typeof readChartTokens>} tokens */
function baseOption(tokens) {
  return {
    color: tokens.series,
    textStyle: { fontFamily: "inherit", color: tokens.axisLabel },
    grid: { left: 8, right: 8, top: 28, bottom: 8, containLabel: true },
    tooltip: {
      backgroundColor: tokens.surface,
      borderColor: tokens.border,
      borderWidth: 1,
      textStyle: { color: tokens.text },
      extraCssText: "border-radius: 0.625rem; box-shadow: var(--shadow-raised); padding: 8px 12px;",
    },
    xAxis: {
      axisLine: { lineStyle: { color: tokens.border } },
      axisTick: { show: false },
      axisLabel: { color: tokens.axisLabel },
      splitLine: { show: false },
    },
    yAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: tokens.axisLabel },
      splitLine: { lineStyle: { color: tokens.grid } },
    },
  };
}

/**
 * The one place `echarts` gets imported. Reads colour tokens live and
 * re-reads them on theme change with no reload, applies a shared minimal
 * base option (no gridlines but a faint horizontal set, sparse muted axis
 * labels, a token-styled tooltip card), is responsive to its container
 * rather than the window, and renders its own skeleton/empty state.
 * Rounded bar caps aren't in the base option — they're a per-series
 * `itemStyle.borderRadius`, so the caller sets it (see the bar demo).
 *
 * @param {{
 *   option: object | ((tokens: ChartTokens) => object),
 *   loading?: boolean,
 *   empty?: boolean,
 *   emptyTitle?: string,
 *   emptyDescription?: string,
 *   height?: number | string,
 *   className?: string,
 * }} props
 */
export function Chart({
  option,
  loading = false,
  empty = false,
  emptyTitle = "Nothing to show yet",
  emptyDescription,
  height = 320,
  className,
}) {
  const containerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const chartRef = useRef(/** @type {echarts.ECharts | null} */ (null));
  const resolved = useResolvedTheme();
  const [tokens, setTokens] = useState(readChartTokens);

  // Deferred to the next frame: an explicit light/dark toggle sets the
  // data-theme attribute in a *sibling* effect (ThemeProvider's), and effect
  // order across components isn't something to depend on. By the next
  // frame the attribute (or the OS media query, for "system") has already
  // taken effect either way.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setTokens(readChartTokens()));
    return () => cancelAnimationFrame(raf);
  }, [resolved]);

  useEffect(() => {
    if (!containerRef.current || loading || empty) return undefined;

    const instance = echarts.init(containerRef.current);
    chartRef.current = instance;

    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      instance.dispose();
      chartRef.current = null;
    };
  }, [loading, empty]);

  useEffect(() => {
    const instance = chartRef.current;
    if (!instance) return;
    // ECharts deep-merges each setOption call onto its internal state, so
    // re-applying the base every time tokens change and the caller's option
    // every time it changes composes correctly without us hand-rolling a
    // merge for nested keys like xAxis/tooltip.
    instance.setOption(baseOption(tokens), false);
    instance.setOption(typeof option === "function" ? option(tokens) : option, false);
  }, [option, tokens]);

  if (loading) {
    return (
      <Skeleton className={cn("w-full", className)} style={{ height }} />
    );
  }

  if (empty) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        className={className}
      />
    );
  }

  return (
    <div ref={containerRef} className={cn("w-full", className)} style={{ height }} />
  );
}
