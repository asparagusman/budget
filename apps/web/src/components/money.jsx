import { cn } from "@/lib/utils.js";
import { formatMoney, formatMoneySpoken } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";
import { useTweenedNumber } from "@/lib/motion.js";

/** @import { Cents } from "@budget/engine" */

/**
 * Renders integer cents as a currency string. The only place in the app a
 * `*_cents` value becomes text — see `formatMoney()`, which this wraps.
 *
 * Two things happen here that are easy to miss:
 *
 *  - The visible glyphs are `aria-hidden` and a spoken form sits beside them
 *    in an `sr-only` span, because screen readers mangle `$387.33`
 *    (phases/11-polish-mobile-import.md, workstream B "Accessibility").
 *  - With `tween`, the figure counts from its old value to its new one over
 *    ~250ms, so the operator can see *which* numbers a change moved. Pass
 *    `tween={false}` — or simply leave it off — for any figure derived from
 *    a field being typed into. It is off by default for exactly that
 *    reason: opting in is a decision, opting out is a thing you forget.
 *
 * @param {{
 *   value: Cents,
 *   signed?: boolean,
 *   compact?: boolean,
 *   cadence?: string,
 *   tween?: boolean,
 *   whole?: boolean,
 *   className?: string,
 * }} props
 */
export function Money({ value, signed = false, compact = false, cadence, tween = false, whole = false, className }) {
  const { currency, locale } = useSettings();
  const shown = useTweenedNumber(value, { enabled: tween });
  const formatted = formatMoney(shown, { currency, locale, signed, compact, whole });
  // Spoken from the settled value, never the tweening one: a live region
  // does not exist here, but an assistive tech that re-reads mid-tween
  // should still hear the real number rather than a frame of the animation.
  const spoken = formatMoneySpoken(whole ? Math.round(value / 100) * 100 : value, { currency, locale, signed });

  return (
    <span className={cn("tabular-nums", className)}>
      <span aria-hidden="true">
        {formatted}
        {cadence ? <span className="text-text-subtle">/{cadence}</span> : null}
      </span>
      <span className="sr-only">
        {spoken}
        {cadence ? ` per ${cadence}` : ""}
      </span>
    </span>
  );
}
