import { lazy, Suspense, useId, useState } from "react";
import { TableIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Skeleton } from "@/components/ui/skeleton.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { Button } from "@/components/ui/button.jsx";

// ECharts is by a wide margin the largest dependency in the app, and most
// routes render no chart at all. Pulling it in through `React.lazy` means
// it becomes its own chunk fetched the first time a chart actually paints,
// rather than a tax on every route's initial load
// (phases/11-polish-mobile-import.md, workstream B "Performance").
//
// Import `<Chart>` from here; never import chart-canvas.jsx (or `echarts`)
// directly, or the split quietly stops working.
const ChartCanvas = lazy(() => import("@/components/chart-canvas.jsx"));

/** @typedef {import("@/components/chart-canvas.jsx").ChartTokens} ChartTokens */

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
    <div className="overflow-x-auto rounded-(--radius-control) border border-border" id={id}>
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
    </div>
  );
}

/**
 * A chart, its skeleton, its empty state and its text alternative.
 *
 * `ariaLabel` is not optional in spirit even though it is in the type: a
 * canvas is opaque to a screen reader, so a chart with no label is a chart
 * that does not exist for some of its readers. Pass `dataTable` as well
 * wherever the chart is the only place a figure appears — the operator gets
 * a "Table" toggle and the same numbers as rows.
 *
 * Rounded bar caps aren't in the base option — they're a per-series
 * `itemStyle.borderRadius`, so the caller sets it.
 *
 * @param {{
 *   option: object | ((tokens: ChartTokens) => object),
 *   ariaLabel?: string,
 *   dataTable?: ChartDataTable | null,
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
      // A canvas has no accessible content of its own; the label above is
      // the whole of what a screen reader gets, so the subtree must not
      // also be walked into.
      className={cn("w-full", className)}
    >
      <Suspense fallback={<Skeleton className="w-full" style={{ height }} />}>
        <ChartCanvas option={option} height={height} />
      </Suspense>
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
      {showTable ? <DataTableView table={dataTable} id={tableId} /> : canvas}
    </div>
  );
}
