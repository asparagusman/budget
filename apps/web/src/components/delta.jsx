import { cn } from "@/lib/utils.js";
import { formatMoney, formatMoneySpoken } from "@/lib/format-money.js";
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
 *   invert?: boolean,
 *   className?: string,
 * }} props
 */
export function Delta({ value, kind = "pct", invert = false, className }) {
  const { currency, locale } = useSettings();
  const magnitude = Math.abs(value);
  // U+2212 MINUS SIGN, not a hyphen — it aligns with the digits. It is also
  // the reason this needs a spoken alternative: assistive tech reads it
  // inconsistently, and "5.3%" and "−5.3%" must never sound the same.
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const text =
    kind === "pct"
      ? `${sign}${magnitude.toFixed(1)}%`
      : `${sign}${formatMoney(/** @type {Cents} */ (magnitude), { currency, locale })}`;
  const direction = value > 0 ? "up" : value < 0 ? "down" : "no change";
  const spoken =
    kind === "pct"
      ? `${direction} ${magnitude.toFixed(1)} percent`
      : `${direction} ${formatMoneySpoken(/** @type {Cents} */ (magnitude), { currency, locale })}`;

  // `invert` flips which sign reads as good news without touching the
  // displayed number — e.g. a spending variance, where MORE than budgeted
  // (a positive number) is the bad outcome and belongs in the negative
  // token, the opposite of a plain income/balance delta.
  const isGood = invert ? value < 0 : value > 0;
  const isBad = invert ? value > 0 : value < 0;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        value === 0
          ? "bg-surface-muted text-text-muted"
          : isGood
            ? "bg-positive-soft text-positive"
            : isBad
              ? "bg-negative-soft text-negative"
              : "bg-surface-muted text-text-muted",
        className,
      )}
    >
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{value === 0 ? "no change" : spoken}</span>
    </span>
  );
}
