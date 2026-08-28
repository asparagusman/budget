import { useCallback } from "react";
import { Chart } from "@/components/chart.jsx";
import { Money } from "@/components/money.jsx";
import { formatMoney } from "@/lib/format-money.js";
import { LG, useMediaQuery } from "@/lib/use-media-query.js";
import { useSettings } from "@/lib/settings.jsx";

/** @import { AllocationResult } from "@budget/engine" */

/** @typedef {{ id: string, name: string }} FlowAccount */

/**
 * Only the three fields the diagram reads. Both callers satisfy it — the
 * editor's own `DraftLine` and the dashboard's stored `allocation_lines` rows
 * — without either having to know the other's shape.
 *
 * @typedef {{ id: string, stage: number, accountId: string }} FlowLine
 */

/**
 * @param {FlowAccount[]} accounts
 * @param {string} accountId
 */
export function accountName(accounts, accountId) {
  return accounts.find((a) => a.id === accountId)?.name ?? "Unknown account";
}

/**
 * Income -> stages -> destinations. Desktop only: a sankey at 375px is
 * illegible, so mobile gets <AllocationProportionBar> instead.
 *
 * @param {{ result: AllocationResult, accounts: FlowAccount[], lines: FlowLine[], height?: number, heading?: import("react").ReactNode }} props
 */
export function AllocationSankey({ result, accounts, lines, height = 300, heading = "Where the money goes" }) {
  const { currency, locale } = useSettings();

  const option = useCallback(
    /** @param {import("@/components/chart.jsx").ChartTokens} tokens */
    (tokens) => {
      /** @type {Map<string, string>} */
      const labels = new Map();
      /** @type {{ name: string, itemStyle: { color: string | undefined } }[]} */
      const nodes = [];
      /** @type {{ source: string, target: string, value: number }[]} */
      const links = [];

      const push = (/** @type {string} */ name, /** @type {string} */ label, /** @type {string | undefined} */ color) => {
        if (labels.has(name)) return;
        labels.set(name, label);
        nodes.push({ name, itemStyle: { color } });
      };

      push("income", "Income", tokens.series[0]);

      const resolvedById = new Map(result.lines.map((l) => [l.lineId, l]));
      for (const [index, stage] of result.stages.entries()) {
        const stageNode = `stage-${stage.stage}`;
        push(stageNode, `Stage ${stage.stage}`, tokens.series[(index + 1) % tokens.series.length]);
        if (stage.subtotalPerMonthCents > 0) {
          links.push({ source: "income", target: stageNode, value: stage.subtotalPerMonthCents / 100 });
        }

        /** @type {Map<string, number>} */
        const perAccount = new Map();
        for (const line of lines.filter((l) => l.stage === stage.stage)) {
          const resolved = resolvedById.get(line.id);
          if (!resolved) continue;
          perAccount.set(line.accountId, (perAccount.get(line.accountId) ?? 0) + resolved.perMonthCents);
        }
        for (const [accountId, cents] of perAccount) {
          const accountNode = `account-${accountId}`;
          push(accountNode, accountName(accounts, accountId), tokens.series[3 % tokens.series.length]);
          // Sankey cannot draw a negative flow. A line that resolved negative
          // is already called out by the invariant indicator; dropping it here
          // keeps the diagram honest rather than blank.
          if (cents > 0) links.push({ source: stageNode, target: accountNode, value: cents / 100 });
        }
      }

      if (result.unallocatedPerMonthCents > 0) {
        push("unallocated", "Unallocated", tokens.series[4 % tokens.series.length]);
        links.push({ source: "income", target: "unallocated", value: result.unallocatedPerMonthCents / 100 });
      }

      /** @param {string} name */
      const labelOf = (name) => labels.get(name) ?? name;

      // A stage whose lines all resolved negative has no drawable flow; the
      // invariant indicator has already said so, and leaving the node in
      // just stacks an orphan label over the destination column.
      const connected = new Set(links.flatMap((l) => [l.source, l.target]));
      const drawnNodes = nodes.filter((n) => connected.has(n.name));

      return {
        tooltip: {
          trigger: "item",
          /** @param {{ dataType?: string, name: string, value: number, data: { source?: string, target?: string } }} params */
          formatter: (params) => {
            const money = formatMoney(Math.round(params.value * 100), { currency, locale });
            if (params.dataType === "edge") {
              return `${labelOf(params.data.source ?? "")} → ${labelOf(params.data.target ?? "")}<br/>${money}/month`;
            }
            return `${labelOf(params.name)}<br/>${money}/month`;
          },
        },
        series: [
          {
            type: "sankey",
            emphasis: { focus: "adjacency" },
            nodeWidth: 12,
            left: 8,
            right: 110,
            top: 8,
            bottom: 8,
            label: {
              color: tokens.text,
              /** @param {{ name: string }} params */
              formatter: (params) => labelOf(params.name),
            },
            lineStyle: { curveness: 0.5, opacity: 0.25, color: "gradient" },
            data: drawnNodes,
            links,
          },
        ],
      };
    },
    [result, accounts, lines, currency, locale],
  );

  return (
    <div className="flex flex-col gap-3">
      {heading ? <h3 className="text-sm font-semibold text-text">{heading}</h3> : null}
      {/* The table view is the sankey's whole content as rows: every
          destination and what reaches it. It is also what a screen reader
          gets instead of a canvas that says nothing at all. */}
      <Chart
        option={option}
        height={height}
        ariaLabel={`Flow diagram: income divided across ${result.stages.length} stages into ${result.transfers.length} destinations.`}
        dataTable={{
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
        }}
        empty={result.stages.length === 0}
        emptyTitle="No stages yet"
      />
    </div>
  );
}

/**
 * The mobile answer to the sankey: one proportion bar plus the list. Widths
 * are the engine's own monthly cents used as flex weights — no percentage
 * maths of this screen's own.
 *
 * @param {{ result: AllocationResult, accounts: FlowAccount[], heading?: import("react").ReactNode }} props
 */
export function AllocationProportionBar({ result, accounts, heading = "Where the money goes" }) {
  const positive = result.transfers.filter((t) => t.perMonthCents > 0);

  return (
    <div className="flex flex-col gap-3">
      {heading ? <h3 className="text-sm font-semibold text-text">{heading}</h3> : null}
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-muted">
        {positive.map((transfer, index) => (
          <div
            key={transfer.accountId}
            className="h-full"
            style={{
              flexGrow: transfer.perMonthCents,
              backgroundColor: `var(--chart-line-${(index % 5) + 1})`,
            }}
            title={accountName(accounts, transfer.accountId)}
          />
        ))}
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {positive.map((transfer, index) => (
          <li key={transfer.accountId} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: `var(--chart-line-${(index % 5) + 1})` }}
                aria-hidden="true"
              />
              <span className="truncate text-text">{accountName(accounts, transfer.accountId)}</span>
            </span>
            <span className="shrink-0 text-text-muted">
              <Money value={transfer.perMonthCents} />
              <span className="text-text-subtle">/month</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Whichever of the two the viewport calls for, with only that one in the DOM.
 * `hidden lg:block` on the sankey would be simpler and is wrong: echarts
 * initialises inside `display: none` at 0x0 and logs "Can't get DOM width or
 * height" instead of drawing anything. `useMediaQuery` reads `matches`
 * synchronously on the first render, so this still costs no layout shift
 * (phases/10-dashboard.md "no layout shift on load").
 *
 * @param {{ result: AllocationResult, accounts: FlowAccount[], lines: FlowLine[], heading?: import("react").ReactNode }} props
 */
export function AllocationFlow({ result, accounts, lines, heading }) {
  const isDesktop = useMediaQuery(LG);

  return isDesktop ? (
    <AllocationSankey result={result} accounts={accounts} lines={lines} heading={heading} />
  ) : (
    <AllocationProportionBar result={result} accounts={accounts} heading={heading} />
  );
}
