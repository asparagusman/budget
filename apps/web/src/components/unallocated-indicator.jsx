import { equivalent } from "@budget/engine";
import { AlertTriangleIcon, CheckIcon } from "lucide-react";
import { Money } from "@/components/money.jsx";
import { CADENCE_LABELS } from "@/lib/constants.js";
import { cn } from "@/lib/utils.js";

/** @import { AllocationResult, Cadence } from "@budget/engine" */

/**
 * A plan can land on exactly zero unallocated and still be wrong — stage 3
 * sweeping a negative remainder reconciles perfectly. Green has to mean "this
 * is fine", not just "the arithmetic closed". Exported so a summary elsewhere
 * can't disagree with the indicator about what "balanced" means.
 *
 * @param {AllocationResult} result
 */
export function isBalanced(result) {
  return result.unallocatedPerMonthCents === 0 && result.lines.every((l) => l.perMonthCents >= 0);
}

/**
 * The guard the spreadsheet never had. Its own total check read 97% and stayed
 * silently broken because one row had no formula, so non-zero has to feel
 * wrong immediately (phases/08-allocation.md "The invariant indicator").
 *
 * Shared rather than per-screen: /allocation and the dashboard both show it,
 * and two indicators that disagreed about what "balanced" means would defeat
 * the point of having one (phases/10-dashboard.md "Unallocated": "Same
 * component as phase 08's indicator").
 *
 * @param {{
 *   result: AllocationResult,
 *   payCadence: Cadence,
 *   hasPrimaryPaySchedule: boolean,
 *   footer?: import("react").ReactNode,
 * }} props
 */
export function UnallocatedIndicator({ result, payCadence, hasPrimaryPaySchedule, footer }) {
  const cents = result.unallocatedPerMonthCents;
  const negativeLines = result.lines.filter((l) => l.perMonthCents < 0);
  const balanced = isBalanced(result);
  const zeroUnallocated = cents === 0;

  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-(--radius-card) px-5 py-4 shadow-(--shadow-card)",
        balanced ? "bg-positive-soft" : zeroUnallocated ? "bg-warning-soft" : "bg-negative-soft",
      )}
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-text-muted uppercase">Unallocated</p>
        {balanced ? (
          <CheckIcon className="size-5 text-positive" aria-label="Balanced" />
        ) : (
          <AlertTriangleIcon className="size-5 text-negative" aria-hidden="true" />
        )}
      </div>
      <p
        className={cn(
          "text-2xl font-bold tracking-tight",
          balanced ? "text-positive" : zeroUnallocated ? "text-text" : "text-negative",
        )}
      >
        <Money value={cents} signed={!zeroUnallocated} />
        <span className="ml-1.5 text-sm font-medium text-text-muted">/month</span>
      </p>
      {!zeroUnallocated ? (
        <p className="text-sm text-text-muted">
          {cents > 0 ? (
            <>
              <Money value={hasPrimaryPaySchedule ? equivalent(cents, "monthly", payCadence) : cents} /> per{" "}
              {hasPrimaryPaySchedule ? CADENCE_LABELS[payCadence].toLowerCase() : "month"} isn&apos;t allocated
              anywhere — it stays in the income account.
            </>
          ) : (
            <>This plan allocates more than the income it has. Nothing is rebalanced for you.</>
          )}
        </p>
      ) : null}
      {negativeLines.length > 0 ? (
        <p className="text-sm text-negative">
          {negativeLines.length} line{negativeLines.length === 1 ? "" : "s"} resolve{negativeLines.length === 1 ? "s" : ""}{" "}
          to a negative amount — an earlier stage is taking more than the one before it leaves.
        </p>
      ) : null}
      {footer}
    </div>
  );
}
