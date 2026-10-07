import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";

/**
 * A line, stage or category's `fidelity` in words: how far its actual share
 * of gross is from the goal set for it, as a share OF THAT GOAL. 6% against a
 * 10% goal is 40% under; 60% against a 50% goal is 20% over.
 *
 * Relative, not in percentage points, because that is the comparison being
 * made: 2 points off a 10% goal is a large miss and 2 points off a 60% goal
 * is a rounding error, and a points figure reads them as the same size. The
 * engine's `fidelity` is already this ratio — this component only says it out
 * loud (`(actualPct - goalPct) / goalPct`, packages/engine/src/allocation.js).
 *
 * "over goal"/"under goal" rather than `+`/`−`: a signed percentage next to a
 * percentage-of-gross figure invites reading it as points, which is the one
 * misreading that changes the number's meaning. The word "goal" is carried in
 * the badge itself rather than left to the text beside it, because the badge
 * also appears on the dashboard's tiles, where there is no goal figure next to
 * it to borrow the meaning from.
 *
 * Deliberately not colour-coded good/bad. Over a savings goal is good news
 * and over a bills goal is bad news, and nothing on this screen knows which a
 * given category is — so a green pill on "20% over" would be a verdict the
 * app is not entitled to. Exactly on-goal gets a check, because that one is
 * unambiguous whatever the category means — a check, not green: green is
 * money in.
 *
 * `compact` drops the word "goal" from the visible pill, for the one place
 * that word is redundant: a dense table row whose own Goal % column is two
 * cells to the left. The spoken form is unchanged — a screen reader has no
 * column to borrow the meaning from either way — and it is opt-in so the
 * dashboard tiles, which really do stand alone, keep the full wording.
 *
 * @param {{ fidelity: number, goalPct?: number | null, compact?: boolean, className?: string }} props
 */
export function FidelityBadge({ fidelity, goalPct = null, compact = false, className }) {
  const pct = fidelity * 100;
  // Under a tenth of a percent renders as "0.0% over", which reads as a miss
  // that isn't there. Rounding drives the words as well as the digits.
  const onGoal = Math.abs(pct) < 0.05;
  const magnitude = Math.abs(pct).toFixed(1);
  const direction = pct > 0 ? "over" : "under";
  // The spoken form names the goal it is relative to, which the visible pill
  // has no room for: "20 percent under its 10% goal".
  const goalSuffix = goalPct === null ? "" : ` its ${goalPct}% goal`;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        onGoal ? "text-text" : "text-text-muted",
        className,
      )}
    >
      {onGoal ? <CheckIcon className="size-3" aria-hidden="true" /> : null}
      <span aria-hidden="true">
        {onGoal ? "on goal" : `${magnitude}% ${direction}${compact ? "" : " goal"}`}
      </span>
      <span className="sr-only">
        {onGoal ? `on goal${goalSuffix}` : `${magnitude} percent ${direction}${goalSuffix || " goal"}`}
      </span>
    </span>
  );
}
