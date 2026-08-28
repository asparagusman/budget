import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart, SankeyChart } from "echarts/charts";
import {
  CalendarComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useResolvedTheme } from "@/lib/theme.jsx";
import { useReducedMotion } from "@/lib/motion.js";
import { cn } from "@/lib/utils.js";

// The ONLY module in the app that imports echarts, and it is reached only
// through `React.lazy` from chart.jsx — which is what keeps the ~700kB
// charting library out of every route's chunk. Import it directly from
// anywhere else and that split silently stops working.
//
// Only the chart types the app actually uses are registered. Add to this
// list rather than importing all of echarts — and note that an unregistered
// feature fails SILENTLY at runtime (a missing legend, a markLine that never
// draws), never at build or typecheck time.
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
  LegendComponent,
  MarkLineComponent,
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

/**
 * @param {ChartTokens} tokens
 * @param {boolean} animate
 */
function baseOption(tokens, animate) {
  return {
    color: tokens.series,
    // Series animate in on mount and morph on data change, so a changed
    // forecast reads as a change rather than as a different picture. The
    // one deliberate exception to the 300ms ceiling — and the first thing
    // reduced motion turns off, since a chart's entrance carries no
    // information the static chart doesn't.
    animation: animate,
    animationDuration: 500,
    animationDurationUpdate: 300,
    // Annotated rather than left to inference: echarts types
    // `animationEasing` as a union of easing names, and a bare object
    // literal widens the string to `string` — one of the handful of places
    // in this repo where a type annotation is load-bearing rather than
    // decorative (phases/README.md, "JavaScript + JSDoc").
    animationEasing: /** @type {const} */ ("cubicOut"),
    animationEasingUpdate: /** @type {const} */ ("cubicOut"),
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
 * Reads colour tokens live and re-reads them on theme change with no reload,
 * applies a shared minimal base option (no gridlines but a faint horizontal
 * set, sparse muted axis labels, a token-styled tooltip card), and is
 * responsive to its container rather than the window. Loading, empty and
 * accessible-alternative states live one level up, in `<Chart>` — this
 * component only ever draws.
 *
 * @param {{
 *   option: object | ((tokens: ChartTokens) => object),
 *   height?: number | string,
 *   className?: string,
 * }} props
 */
export function ChartCanvas({ option, height = 320, className }) {
  const containerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const chartRef = useRef(/** @type {echarts.ECharts | null} */ (null));
  const resolved = useResolvedTheme();
  const reducedMotion = useReducedMotion();
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
    if (!containerRef.current) return undefined;

    const instance = echarts.init(containerRef.current);
    chartRef.current = instance;

    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      instance.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = chartRef.current;
    if (!instance) return;
    // ECharts deep-merges each setOption call onto its internal state, so
    // re-applying the base every time tokens change and the caller's option
    // every time it changes composes correctly without us hand-rolling a
    // merge for nested keys like xAxis/tooltip.
    instance.setOption(baseOption(tokens, !reducedMotion), false);
    instance.setOption(typeof option === "function" ? option(tokens) : option, false);
  }, [option, tokens, reducedMotion]);

  return <div ref={containerRef} className={cn("w-full", className)} style={{ height }} />;
}

export default ChartCanvas;
