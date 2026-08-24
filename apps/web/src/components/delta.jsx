import { cn } from "@/lib/utils.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";

/** @import { Cents } from "@budget/engine" */

/**
 * A tinted pill badge for a signed change — `+5.3%` or `+$40.00` — never
 * bare coloured text. Positive/negative tokens only ever mean money in/out
 * here; a value of exactly zero gets the neutral muted treatment.
 *
 * @param {{
 *   value: number,
 *   kind?: 'pct' | 'cents',
 *   className?: string,
 * }} props
 */
export function Delta({ value, kind = "pct", className }) {
  const { currency, locale } = useSettings();
  const magnitude = Math.abs(value);
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const text =
    kind === "pct"
      ? `${sign}${magnitude.toFixed(1)}%`
      : `${sign}${formatMoney(/** @type {Cents} */ (magnitude), { currency, locale })}`;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        value === 0
          ? "bg-surface-muted text-text-muted"
          : value > 0
            ? "bg-positive-soft text-positive"
            : "bg-negative-soft text-negative",
        className,
      )}
    >
      {text}
    </span>
  );
}
