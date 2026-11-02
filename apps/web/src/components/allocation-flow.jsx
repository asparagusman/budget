import { useMemo } from "react";
import { Cell, Pie, PieChart } from "recharts";
import {
  Chart,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  MoneyTooltip,
  useChartMotion,
} from "@/components/chart.jsx";
import { AllocationProportionBar, accountName } from "@/components/allocation-proportion-bar.jsx";
import { colorFor, entityColors } from "@/lib/entity-colors.js";
import { formatMoney } from "@/lib/format-money.js";
import { LG, useMediaQuery } from "@/lib/use-media-query.js";
import { useSettings } from "@/lib/settings.jsx";

/** @import { AllocationResult } from "@budget/engine" */

/** @typedef {import("@/components/allocation-proportion-bar.jsx").FlowAccount} FlowAccount */

/**
 * Only the three fields the diagram reads. Both callers satisfy it — the
 * editor's own `DraftLine` and the dashboard's stored `allocation_lines` rows
 * — without either having to know the other's shape.
 *
 * @typedef {{ id: string, stage: number, accountId: string }} FlowLine
 */

/**
 * The division of income, as one slice per destination.
 *
 * This replaced a sankey of income → stages → destinations. Stages are an
 * evaluation ORDER — they are how `pct_of_remaining` and `sweep` resolve
 * against what is left at each step (packages/engine/src/allocation.js) —
 * not a category anybody budgets by, so a diagram whose whole middle column
 * was stages spent most of its ink on a fact nobody was asking it for. The
 * question this panel answers is where the money ends up, and a pie answers
 * exactly that and nothing else.
 *
 * Negative and zero flows are dropped: a slice cannot have negative area,
 * and a line that resolved negative is already called out by the invariant
 * indicator. Dropping it keeps the chart honest rather than blank.
 *
 * @param {{
 *   result: AllocationResult,
 *   accounts: FlowAccount[],
 *   height?: number,
 *   heading?: import("react").ReactNode,
 * }} props
 */
export function AllocationPie({ result, accounts, height = 300, heading = "Where the money goes" }) {
  const { currency, locale } = useSettings();
  const motion = useChartMotion();
  // Every account the caller knows, not just the ones with a slice, so each
  // wears the colour it wears on /projections.
  const colors = useMemo(() => entityColors(accounts.map((a) => a.id)), [accounts]);

  const { slices, config } = useMemo(() => {
    /** @type {{ name: string, value: number, fill: string }[]} */
    const rows = [];

    for (const transfer of result.transfers) {
      if (transfer.perMonthCents <= 0) continue;
      rows.push({
        name: accountName(accounts, transfer.accountId),
        value: transfer.perMonthCents / 100,
        fill: colorFor(colors, transfer.accountId),
      });
    }

    // Amber, like the indicator: money nobody has given a job is a "needs a
    // look", not a destination.
    if (result.unallocatedPerMonthCents > 0) {
      rows.push({
        name: "Unallocated",
        value: result.unallocatedPerMonthCents / 100,
        fill: "var(--warning)",
      });
    }

    // Keyed by the displayed name, which is what the tooltip and legend look
    // a slice up by. Deliberately carries no `color`: a custom property
    // named after an account would have to be a valid CSS identifier, and
    // account names are free text. The colour is on the <Cell> instead.
    /** @type {import("@/components/ui/chart.jsx").ChartConfig} */
    const byName = {};
    for (const row of rows) byName[row.name] = { label: row.name };

    return { slices: rows, config: byName };
  }, [result, accounts, colors]);

  return (
    <div className="flex flex-col gap-3">
      {heading ? <h3 className="text-sm font-semibold text-text">{heading}</h3> : null}
      {/* The table view is the pie's whole content as rows: every
          destination and what reaches it. It is also what a screen reader
          gets instead of a graphic that says nothing at all. */}
      <Chart
        height={height}
        ariaLabel={`Income divided across ${slices.length} destinations, per month.`}
        dataTable={() => ({
          caption: "What reaches each destination, per month",
          columns: ["Destination", "Per month"],
          rows: [
            ...result.transfers.map((transfer) => [
              accountName(accounts, transfer.accountId) + (transfer.isNoOp ? " (no move required)" : ""),
              formatMoney(transfer.perMonthCents, { currency, locale }),
            ]),
            ...(result.unallocatedPerMonthCents !== 0
              ? [["Unallocated", formatMoney(result.unallocatedPerMonthCents, { currency, locale })]]
              : []),
          ],
        })}
        empty={slices.length === 0}
        emptyTitle="Nothing allocated yet"
        emptyDescription="Add an allocation line and its share of income appears here."
        config={config}
      >
        <PieChart>
          <ChartTooltip content={<MoneyTooltip nameKey="name" hideLabel />} />
          {/* A donut, not a full pie: the hole is what lets the slice labels
              breathe at this size, and nothing is being read off the centre. */}
          <Pie data={slices} dataKey="value" nameKey="name" innerRadius="45%" outerRadius="75%" {...motion}>
            {slices.map((slice) => (
              <Cell key={slice.name} fill={slice.fill} stroke="var(--surface)" strokeWidth={2} />
            ))}
          </Pie>
          <ChartLegend content={<ChartLegendContent nameKey="name" />} />
        </PieChart>
      </Chart>
    </div>
  );
}

/**
 * Whichever of the two the viewport calls for, with only that one in the DOM.
 * `hidden lg:block` on the pie would be simpler and is wrong: a chart
 * measures its container, and inside `display: none` that container is 0x0 —
 * so it mounts and draws nothing. `useMediaQuery` reads `matches`
 * synchronously on the first render, so this still costs no layout shift
 * (phases/10-dashboard.md "no layout shift on load").
 *
 * Both halves now say the same thing — the division of income by
 * destination — where the desktop half used to say something else entirely.
 *
 * `height` sizes the desktop pie only; the narrow bar is as tall as its list.
 *
 * @param {{ result: AllocationResult, accounts: FlowAccount[], heading?: import("react").ReactNode, height?: number }} props
 */
export function AllocationFlow({ result, accounts, heading, height }) {
  const isDesktop = useMediaQuery(LG);

  return isDesktop ? (
    <AllocationPie result={result} accounts={accounts} heading={heading} height={height} />
  ) : (
    <AllocationProportionBar result={result} accounts={accounts} heading={heading} />
  );
}

export { AllocationProportionBar, accountName };
