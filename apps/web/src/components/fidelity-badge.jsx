import { ArrowDownIcon, ArrowUpIcon, CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";

/**
 * A line, stage or category's `fidelity` in words: where its actual share of
 * gross sits against the goal set for it, and which side of it.
 *
 * The engine's `fidelity` is a RELATIVE difference (`(actualPct - goalPct) /
 * goalPct`, packages/engine/src/allocation.js), and that is how this badge used
 * to say it: "31.6% over goal" for 65.8% against a 50% goal. People read that
 * as 31.6 points over, which is the wrong size by half. So the badge never says
 * the ratio. It says the two figures themselves, which need no reading:
 *
 * - `actualPct` given (the dashboard, where nothing else on the row names the
 *   share): "65.8% of income · goal 50%" behind the arrow. The two figures
 *   already say which side of the goal it is, so the word is left to the
 *   spoken form — spelled out, the pill outgrew the narrowest income column.
 * - `actualPct` omitted (/allocation, whose rows already print the share and
 *   the goal beside the badge): the distance in percentage points, "15.8 pts
 *   over goal". The share is rebuilt from the goal and the ratio, so the two
 *   can never disagree with the engine's own figures.
 * - No goal to compare against: nothing to turn into points, so the relative
 *   figure is all there is, worded as it always was.
 *
 * The cue is an arrow (plus the word "over" or "under" where the figures
 * alone don't say it), never green or red.
 * Over a savings goal is good news and over a bills goal is bad news, and
 * nothing on this screen knows which a given category is — so a coloured pill
 * would be a verdict the app is not entitled to. Exactly on-goal gets a check,
 * because that one is unambiguous whatever the category means — a check, not
 * green: green is money in.
 *
 * `compact` drops the word "goal" from the points form, for the one place that
 * word is redundant: a dense table row whose own Goal % column is two cells to
 * the left. The spoken form is unchanged — a screen reader has no column to
 * borrow the meaning from either way.
 *
 * @param {{ fidelity: number, goalPct?: number | null, actualPct?: number | null, compact?: boolean, className?: string }} props
 */
export function FidelityBadge({ fidelity, goalPct = null, actualPct = null, compact = false, className }) {
  const hasGoal = goalPct !== null && goalPct > 0;
  // Percentage points, actual minus goal. Without a goal there is only the
  // ratio, which is what the fallback below reports.
  const points = hasGoal ? goalPct * fidelity : fidelity * 100;
  // Under a tenth of a percent renders as "0.0 over", which reads as a miss
  // that isn't there. Rounding drives the words as well as the digits.
  const onGoal = Math.abs(points) < 0.05;
  const magnitude = Math.abs(points).toFixed(1);
  const direction = points > 0 ? "over" : "under";
  const Arrow = points > 0 ? ArrowUpIcon : ArrowDownIcon;

  let visible;
  let spoken;
  if (!hasGoal) {
    visible = onGoal ? "on goal" : `${magnitude}% ${direction}${compact ? "" : " goal"}`;
    spoken = onGoal ? "on goal" : `${magnitude} percent ${direction} goal`;
  } else if (actualPct !== null) {
    visible = `${actualPct.toFixed(1)}% of income · goal ${goalPct}%`;
    spoken = `${actualPct.toFixed(1)} percent of income against a ${goalPct}% goal, ${
      onGoal ? "on goal" : `${magnitude} points ${direction}`
    }`;
  } else {
    visible = onGoal ? "on goal" : `${magnitude} pts ${direction}${compact ? "" : " goal"}`;
    spoken = onGoal
      ? `on its ${goalPct}% goal`
      : `${magnitude} percentage points ${direction} its ${goalPct}% goal`;
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        onGoal ? "text-text" : "text-text-muted",
        className,
      )}
    >
      {onGoal ? (
        <CheckIcon className="size-3" aria-hidden="true" />
      ) : (
        <Arrow className="size-3" aria-hidden="true" />
      )}
      <span aria-hidden="true">{visible}</span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}
