import { useId, useMemo, useState } from "react";
import { TableIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Skeleton } from "@/components/ui/skeleton.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { Button } from "@/components/ui/button.jsx";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart.jsx";
import { formatMoney } from "@/lib/format-money.js";
import { getDateFormat } from "@/lib/dates.js";
import { useReducedMotion } from "@/lib/motion.js";
import { useSettings } from "@/lib/settings.jsx";
import { ScrollArea } from "@/components/scroll-area.jsx";

// The app's chart layer. Two files, deliberately:
//
//   - `ui/chart.jsx` is shadcn's generated Recharts wrapper (adapted; see
//     its header). Container, tooltip and legend chrome.
//   - this file adds what every chart in a money app needs and shadcn's
//     does not: a loading skeleton, an empty state, an accessible data-table
//     alternative, and money-aware axis and tooltip formatting.
//
// Import `<Chart>` and the helpers from HERE. Reaching into `ui/chart.jsx`
// directly gets a chart with no text alternative, which is the one thing
// this wrapper exists to make hard to forget.
//
// This replaced an ECharts wrapper. What changed for callers: a chart is now
// composed from Recharts ELEMENTS as children, not from an option object.
// What that buys, beyond looking like the rest of the component layer:
// series colours can be plain CSS variables, because Recharts draws SVG —
// so a theme change needs no JS at all, where the canvas renderer needed
// tokens re-read, converted out of oklch() and pushed back in on every
// toggle. It also ends the failure mode where an unregistered ECharts
// component drew nothing and said so only in the console.

export { ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent };

/**
 * Chart colour rules, the same on every chart (see the vocabulary at the top
 * of styles/tokens.css):
 *
 *   - `TOTAL` (ink) for a household total or a chart with a single series.
 *   - An account / category / variant gets ITS colour from
 *     `entityColors()` in lib/entity-colors.js — never `SERIES[i]` by list
 *     position, which gave one account two colours on two screens.
 *   - Money out (a bill, an outflow) is `var(--negative)`; nothing else is
 *     red or green, so a series never reads as money it isn't.
 *   - Anything projected spreads `PROJECTED`; anything recorded stays solid.
 *
 * All as CSS variables, never resolved strings: passing the variable is what
 * lets a series re-colour itself on a theme change without React knowing the
 * theme changed at all.
 */
export const TOTAL = "var(--chart-total)";

/**
 * The identity palette, for a fixed PAIR of kinds that aren't entities
 * (essential vs non-essential) — index it by meaning, not by loop position.
 */
export const SERIES = /** @type {const} */ ([
  "var(--chart-line-1)",
  "var(--chart-line-2)",
  "var(--chart-line-3)",
  "var(--chart-line-4)",
  "var(--chart-line-5)",
]);

/**
 * Spread onto any `<Area>` or `<Line>` that shows a FORECAST rather than a
 * recorded figure: `<Area {...PROJECTED} … />`. Half the screens here are
 * projections, and a returning household's first question is "what actually
 * happened, and what does the app expect?" — so a modelled line is dashed and
 * lightly filled everywhere, and a solid line always means recorded.
 */
export const PROJECTED = /** @type {const} */ ({
  strokeDasharray: "6 4",
  fillOpacity: 0.06,
});

/**
 * A reference value drawn across a chart — a target, a budget — rather than
 * data: thin, solid and grey, so it never competes with the series it is
 * measured against. `<Line {...REFERENCE} … />`.
 */
export const REFERENCE = /** @type {const} */ ({
  stroke: "var(--text-subtle)",
  strokeWidth: 1.25,
});

/** Shared axis chrome: no spines, no ticks, muted labels set by the container. */
export const AXIS = /** @type {const} */ ({
  tickLine: false,
  axisLine: false,
  tickMargin: 8,
});

/**
 * An x-axis that measures real elapsed time rather than counting points, so
 * a three-day gap and a three-month gap are different widths (adjustment #4,
 * `[Fixed Costs 3]`). Spread onto `<XAxis>` beside `AXIS`, with a
 * `dataKey` naming a millisecond timestamp built by `isoToMs` below.
 */
export const TIME_AXIS = /** @type {const} */ ({
  type: "number",
  scale: "time",
  domain: ["dataMin", "dataMax"],
});

/**
 * A `YYYY-MM-DD` date as milliseconds at LOCAL midnight.
 *
 * `new Date("2026-09-15")` is parsed as UTC midnight, which in any timezone
 * east of Greenwich is the 15th and in any timezone west of it is the 14th —
 * a bill silently plotted on the wrong day. The `T00:00:00` suffix is what
 * makes it local.
 *
 * @param {string} iso
 */
export function isoToMs(iso) {
  return new Date(`${iso}T00:00:00`).getTime();
}

/**
 * Tick formatter for a `TIME_AXIS`: month names, with the year appended each
 * January so a multi-year range says which year it is without repeating it
 * on every tick.
 */
/**
 * Everything an `<XAxis>` on a `TIME_AXIS` needs: where the gridlines go and
 * what they say. Both depend on how much time is actually on screen, which
 * is why they are one helper rather than two —
 *
 *   - a range of weeks gets whatever ticks Recharts picks, labelled by day,
 *     because month names on a seven-day range put "Aug" under all four
 *     gridlines and say nothing;
 *   - a range of months or years gets ticks pinned to month starts, thinned
 *     to roughly eight, labelled by month with the year on each January.
 *
 * That second case is what adjustment #4 (`[Fixed Costs 3]`) is about: left
 * to itself an axis labels individual days on a short window and years on a
 * long one, so the gridlines mean something different at every horizon.
 *
 * @param {number} fromMs earliest timestamp plotted
 * @param {number} toMs latest timestamp plotted
 * @param {number} [target] roughly how many gridlines to aim for
 */
export function useTimeAxis(fromMs, toMs, target = 8) {
  const { locale } = useSettings();

  return useMemo(() => {
    const dayFmt = getDateFormat(locale, { day: "numeric", month: "short" });
    const monthFmt = getDateFormat(locale, { month: "short" });
    const monthYearFmt = getDateFormat(locale, { month: "short", year: "numeric" });

    const valid = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs;
    const from = new Date(fromMs);
    const to = new Date(toMs);
    const months = valid
      ? (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth())
      : 0;

    // Under two whole months there are not enough month boundaries to label
    // — `ticks: undefined` hands the choice back to Recharts.
    if (!valid || months < 2) {
      return {
        ticks: /** @type {number[] | undefined} */ (undefined),
        tickFormatter: (/** @type {number} */ ms) => dayFmt.format(new Date(ms)),
      };
    }

    const step = Math.max(1, Math.ceil((months + 1) / target));
    /** @type {number[]} */
    const ticks = [];
    // Starts at the first WHOLE month at or after `from`: a tick on the 17th
    // labelled "Oct" is a lie about where October begins.
    const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
    if (cursor.getTime() < fromMs) cursor.setMonth(cursor.getMonth() + 1);
    while (cursor.getTime() <= toMs) {
      ticks.push(cursor.getTime());
      cursor.setMonth(cursor.getMonth() + step);
    }

    return {
      ticks,
      tickFormatter: (/** @type {number} */ ms) => {
        const date = new Date(ms);
        return date.getMonth() === 0 ? monthYearFmt.format(date) : monthFmt.format(date);
      },
    };
  }, [fromMs, toMs, target, locale]);
}

/**
 * Series entrance and update animation. A chart's entrance is the one
 * deliberate exception to the app's 300ms ceiling (see lib/motion.js), and
 * the first thing reduced motion turns off — the animation carries nothing
 * the settled chart doesn't.
 *
 * Spread onto each series: `<Line {...motion} />`.
 */
export function useChartMotion() {
  const reduced = useReducedMotion();
  return useMemo(
    () =>
      /** @type {const} */ ({
        isAnimationActive: !reduced,
        animationDuration: 500,
        animationEasing: "ease-out",
      }),
    [reduced],
  );
}

/**
 * A tick formatter for an axis carrying money, in the operator's configured
 * currency and locale, compacted ("$1.2K") so the labels fit.
 *
 * Chart data is plotted in DOLLARS, not cents — an axis domain in cents
 * produces unreadable ticks and Recharts has no notion of a scale factor.
 * The conversion back for display is `* 100` and rounded, which round-trips
 * exactly for any figure this app holds.
 */
export function useMoneyTick() {
  const { currency, locale } = useSettings();
  return useMemo(
    () =>
      /** @param {number} dollars */
      (dollars) => formatMoney(Math.round(dollars * 100), { currency, locale, compact: true }),
    [currency, locale],
  );
}

/**
 * `<ChartTooltipContent>` with its values spelled as money. Pass it the same
 * way: `<ChartTooltip content={<MoneyTooltip />} />`.
 *
 * @param {Omit<import("react").ComponentProps<typeof ChartTooltipContent>, 'valueFormatter'>} props
 */
export function MoneyTooltip(props) {
  const { currency, locale } = useSettings();
  return (
    <ChartTooltipContent
      // A numeric x-axis (a timestamp) leaves the tooltip with no heading at
      // all: it only uses the axis value directly when that value is a
      // string. Every row this app plots carries a `label` field spelling
      // its own x, so read that. Placed BEFORE the spread, so a caller with
      // a better heading still wins.
      labelFormatter={(value, payload) => {
        const row = payload?.[0]?.payload;
        const rowLabel = row && typeof row.label === "string" ? row.label : null;
        return rowLabel ?? value;
      }}
      {...props}
      valueFormatter={(value) =>
        typeof value === "number"
          ? formatMoney(Math.round(value * 100), { currency, locale })
          : String(value ?? "")
      }
    />
  );
}

/**
 * The accessible alternative to a chart: the same figures as a real table.
 * "A chart is not the only way a figure is available"
 * (phases/11-polish-mobile-import.md, workstream B "Accessibility").
 *
 * @typedef {{
 *   columns: string[],
 *   rows: (string | number)[][],
 *   caption?: string,
 * }} ChartDataTable
 */

/** @param {{ table: ChartDataTable, id: string }} props */
function DataTableView({ table, id }) {
  return (
    <ScrollArea axis="x" className="rounded-(--radius-control) border border-border" id={id}>
      <table className="w-full text-sm">
        {table.caption ? <caption className="sr-only">{table.caption}</caption> : null}
        <thead>
          <tr className="border-b border-border">
            {table.columns.map((column, i) => (
              <th
                key={column}
                scope="col"
                className={cn(
                  "px-3 py-2 text-xs font-medium tracking-wide text-text-subtle uppercase",
                  i === 0 ? "text-left" : "text-right",
                )}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={String(row[0])} className="border-b border-border last:border-b-0">
              {row.map((cell, i) => (
                <td
                  key={table.columns[i] ?? i}
                  className={cn(
                    "px-3 py-2 tabular-nums",
                    i === 0 ? "text-left text-text" : "text-right text-text-muted",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

/**
 * A chart, its skeleton, its empty state and its text alternative.
 *
 * `children` is a single Recharts chart element (`<LineChart>`, `<BarChart>`,
 * `<PieChart>`, …) — it is rendered inside a `ResponsiveContainer`, so give
 * it no width or height of its own. `config` names each series for the
 * tooltip and legend and carries its colour.
 *
 * `ariaLabel` is not optional in spirit even though it is in the type: the
 * chart is one graphic to a screen reader, so a chart with no label is a
 * chart that does not exist for some of its readers. Pass `dataTable` as
 * well wherever the chart is the only place a figure appears — the operator
 * gets a "Table" toggle and the same numbers as rows.
 *
 * `dataTable` is a FUNCTION returning the table, called only once the table
 * is opened. Built eagerly, every row's money and date formatting ran on
 * every render of every chart's parent — for a table almost nobody opens
 * (.claude/plans/perf-inp-plan.md, P1.5).
 *
 * @param {{
 *   children: import("react").ComponentProps<typeof ChartContainer>["children"],
 *   config: import("@/components/ui/chart.jsx").ChartConfig,
 *   ariaLabel?: string,
 *   dataTable?: (() => ChartDataTable) | null,
 *   loading?: boolean,
 *   empty?: boolean,
 *   emptyTitle?: string,
 *   emptyDescription?: string,
 *   height?: number | string,
 *   className?: string,
 * }} props
 */
export function Chart({
  children,
  config,
  ariaLabel,
  dataTable = null,
  loading = false,
  empty = false,
  emptyTitle = "Nothing to show yet",
  emptyDescription,
  height = 320,
  className,
}) {
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();

  if (loading) {
    return <Skeleton className={cn("w-full", className)} style={{ height }} />;
  }

  if (empty) {
    return <EmptyState title={emptyTitle} description={emptyDescription} className={className} />;
  }

  const canvas = (
    <div
      role="img"
      aria-label={ariaLabel}
      // The SVG's own subtree is a mass of unlabelled paths and tick text;
      // the label above is the whole of what a screen reader should get, so
      // the subtree must not also be walked into.
      className={cn("w-full", className)}
      style={{ height }}
    >
      <ChartContainer config={config}>{children}</ChartContainer>
    </div>
  );

  if (!dataTable) return canvas;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowTable((open) => !open)}
          aria-expanded={showTable}
          aria-controls={tableId}
        >
          {showTable ? <XIcon aria-hidden="true" /> : <TableIcon aria-hidden="true" />}
          {showTable ? "Hide table" : "Table"}
        </Button>
      </div>
      {showTable ? <DataTableView table={dataTable()} id={tableId} /> : canvas}
    </div>
  );
}
