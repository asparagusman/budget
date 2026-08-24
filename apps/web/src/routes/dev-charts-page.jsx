import { useMemo } from "react";
import { addDaysIso, mustAt } from "@budget/engine";
import { Chart } from "@/components/chart.jsx";
import { PageHeader } from "@/components/page-header.jsx";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function buildLineOption() {
  return {
    xAxis: { type: "category", data: MONTHS, boundaryGap: false },
    yAxis: { type: "value" },
    series: [
      {
        type: "line",
        data: [4200, 4350, 4100, 4600, 4800, 4700, 5000, 5200, 5100, 5400, 5600, 5800],
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 3 },
        areaStyle: { opacity: 0.08 },
      },
    ],
  };
}

function buildBarOption() {
  return {
    xAxis: {
      type: "category",
      data: ["Groceries", "Utilities", "Transport", "Dining", "Subscriptions", "Other"],
    },
    yAxis: { type: "value" },
    series: [
      {
        type: "bar",
        data: [620, 310, 180, 240, 95, 150],
        barMaxWidth: 32,
        // Rounded bar caps are a per-series style — not something the
        // shared <Chart> base option can guess at.
        itemStyle: { borderRadius: [6, 6, 0, 0] },
      },
    ],
  };
}

const SANKEY_NODES = [
  "Income", "Fixed Costs", "Variable Costs", "Savings",
  "Housing", "Insurance", "Groceries", "Fun",
];

/** @param {import("@/components/chart.jsx").ChartTokens} tokens */
function buildSankeyOption(tokens) {
  return {
    series: [
      {
        type: "sankey",
        emphasis: { focus: "adjacency" },
        nodeWidth: 14,
        // Room for the rightmost column's labels — sankey doesn't wrap
        // them, so without this they clip against the card edge.
        left: 8,
        right: 96,
        top: 8,
        bottom: 8,
        label: { color: tokens.text },
        lineStyle: { curveness: 0.5, opacity: 0.25, color: "gradient" },
        data: SANKEY_NODES.map((name, i) => ({
          name,
          // Explicit per-node colour — sankey doesn't reliably pick these
          // up from the global palette the way bar/line series do.
          itemStyle: { color: tokens.series[i % tokens.series.length] },
        })),
        links: [
          { source: "Income", target: "Fixed Costs", value: 2400 },
          { source: "Income", target: "Variable Costs", value: 1100 },
          { source: "Income", target: "Savings", value: 900 },
          { source: "Fixed Costs", target: "Housing", value: 1800 },
          { source: "Fixed Costs", target: "Insurance", value: 600 },
          { source: "Variable Costs", target: "Groceries", value: 700 },
          { source: "Variable Costs", target: "Fun", value: 400 },
        ],
      },
    ],
  };
}

const CALENDAR_START = "2024-01-01";
const CALENDAR_MAX = 22;

/** @param {string} rgb "rgb(r, g, b)" or "rgba(r, g, b, a)" */
function parseRgbChannels(rgb) {
  const match = rgb.match(/rgba?\(([^)]+)\)/);
  const [r, g, b] = (match?.[1] ?? "0,0,0").split(",").map((n) => parseFloat(n));
  return [r ?? 0, g ?? 0, b ?? 0];
}

/**
 * Linear interpolation between two rgb()/rgba() strings. `<Chart>` already
 * normalises tokens to rgb — visualMap's own gradient interpolation doesn't
 * reliably kick in for a calendar heatmap, so this does the same job
 * per-cell instead.
 *
 * @param {string} from
 * @param {string} to
 * @param {number} t 0–1
 */
function mixRgb(from, to, t) {
  const a = parseRgbChannels(from);
  const b = parseRgbChannels(to);
  const [r, g, bch] = a.map((channel, i) =>
    Math.round(channel + (mustAt(b, i, "rgb channel") - channel) * t),
  );
  return `rgb(${r}, ${g}, ${bch})`;
}

/** @param {import("@/components/chart.jsx").ChartTokens} tokens */
function buildCalendarOption(tokens) {
  const data = Array.from({ length: 366 }, (_, i) => {
    const value = (i * 37) % (CALENDAR_MAX + 1);
    return {
      value: [addDaysIso(CALENDAR_START, i), value],
      itemStyle: {
        color: mixRgb(tokens.accentSoft, mustAt(tokens.series, 0, "chart series colour"), value / CALENDAR_MAX),
      },
    };
  });

  return {
    calendar: {
      range: "2024",
      cellSize: ["auto", 14],
      itemStyle: { borderWidth: 3, borderColor: tokens.surface },
      splitLine: { lineStyle: { color: tokens.grid } },
      yearLabel: { show: false },
      dayLabel: { color: tokens.axisLabel },
      monthLabel: { color: tokens.axisLabel },
    },
    // ECharts requires a heatmap series to have a visualMap, full stop, even
    // though per-point itemStyle (above) is what actually paints these
    // cells — visualMap's own gradient never reliably kicked in here.
    visualMap: {
      show: false,
      min: 0,
      max: CALENDAR_MAX,
      dimension: 1,
    },
    series: [{ type: "heatmap", coordinateSystem: "calendar", data }],
  };
}

/**
 * Not in navigation. One working example of each chart type this app uses —
 * sankey, line, bar, calendar heatmap — for feature phases to copy from,
 * per phase 02's chart-foundation task.
 */
export function DevChartsPage() {
  const line = useMemo(buildLineOption, []);
  const bar = useMemo(buildBarOption, []);

  return (
    <>
      <PageHeader
        title="Chart reference"
        description="Hidden dev route — not linked from navigation. A working example of each chart type for feature phases to copy from."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard title="Line">
          <Chart option={line} height={280} />
        </ChartCard>
        <ChartCard title="Bar">
          <Chart option={bar} height={280} />
        </ChartCard>
        <ChartCard title="Sankey">
          <Chart option={buildSankeyOption} height={320} />
        </ChartCard>
        <ChartCard title="Calendar heatmap">
          <Chart option={buildCalendarOption} height={220} />
        </ChartCard>
      </div>
    </>
  );
}

/** @param {{ title: string, children: import("react").ReactNode }} props */
function ChartCard({ title, children }) {
  return (
    <div className="rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
      <p className="mb-3 text-sm font-medium text-text-muted">{title}</p>
      {children}
    </div>
  );
}
