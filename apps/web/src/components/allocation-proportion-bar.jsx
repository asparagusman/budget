import { useMemo } from "react";
import { Money } from "@/components/money.jsx";
import { colorFor, entityColors } from "@/lib/entity-colors.js";

/** @import { AllocationResult } from "@budget/engine" */

/** @typedef {{ id: string, name: string }} FlowAccount */

// Split out of allocation-flow.jsx so /allocation can show the bar without
// importing the pie — and through it Recharts, the app's largest chunk, on a
// page that draws no chart at all (.claude/plans/perf-inp-plan.md, P2 #15).
// allocation-flow.jsx re-exports both, so the dashboard is unchanged.

/**
 * @param {FlowAccount[]} accounts
 * @param {string} accountId
 */
export function accountName(accounts, accountId) {
  return accounts.find((a) => a.id === accountId)?.name ?? "Unknown account";
}

/**
 * The narrow-screen answer: one proportion bar plus the list. Widths
 * are the engine's own monthly cents used as flex weights — no percentage
 * maths of this screen's own.
 *
 * @param {{ result: AllocationResult, accounts: FlowAccount[], heading?: import("react").ReactNode }} props
 */
export function AllocationProportionBar({ result, accounts, heading = "Where the money goes" }) {
  const positive = result.transfers.filter((t) => t.perMonthCents > 0);
  // The same per-account colours as the pie, so the two halves agree.
  const colors = useMemo(() => entityColors(accounts.map((a) => a.id)), [accounts]);

  return (
    <div className="flex flex-col gap-3">
      {heading ? <h3 className="text-sm font-semibold text-text">{heading}</h3> : null}
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-muted">
        {positive.map((transfer) => (
          <div
            key={transfer.accountId}
            className="h-full"
            style={{
              flexGrow: transfer.perMonthCents,
              backgroundColor: colorFor(colors, transfer.accountId),
            }}
            title={accountName(accounts, transfer.accountId)}
          />
        ))}
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {positive.map((transfer) => (
          <li key={transfer.accountId} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: colorFor(colors, transfer.accountId) }}
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
