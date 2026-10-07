import { cn } from "@/lib/utils.js";
import { formatMoney, formatMoneySpoken } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";

/** @import { Cents } from "@budget/engine" */

/**
 * A pill badge for a change — `+$40.00`, `−5.3%` — never bare coloured text.
 *
 * NEUTRAL by default. Most changes in this app are neither good nor bad:
 * moving $140 from Bills to Savings is −$140 on one line and +$140 on the
 * other, and colouring them red and green handed down a verdict on a
 * zero-sum move. The same went for comparing two income variants, where the
 * colours flipped depending on which one you picked first. A returning
 * household reads red as "go and look at this" — so red has to be earned.
 *
 * `variance` is the one case that earns it: actual spending against a
 * budget, where over is genuinely bad and under is genuinely good. It says
 * so in words ("$40.00 over"), so the colour confirms the meaning rather than
 * being the only place it lives.
 *
 * @param {{
 *   value: number,
 *   kind?: 'pct' | 'cents',
 *   variance?: boolean,
 *   className?: string,
 * }} props `value` for a variance is actual − budget: positive is over.
 */
export function Delta({ value, kind = "pct", variance = false, className }) {
  const { currency, locale } = useSettings();
  const magnitude = Math.abs(value);
  const amount =
    kind === "pct" ? `${magnitude.toFixed(1)}%` : formatMoney(/** @type {Cents} */ (magnitude), { currency, locale });
  const amountSpoken =
    kind === "pct"
      ? `${magnitude.toFixed(1)} percent`
      : formatMoneySpoken(/** @type {Cents} */ (magnitude), { currency, locale });

  if (variance) {
    const over = value > 0;
    const under = value < 0;
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
          over ? "bg-negative-soft text-negative" : under ? "bg-positive-soft text-positive" : "bg-surface-muted text-text-muted",
          className,
        )}
      >
        <span aria-hidden="true">{over ? `${amount} over` : under ? `${amount} under` : "on budget"}</span>
        <span className="sr-only">
          {over ? `${amountSpoken} over budget` : under ? `${amountSpoken} under budget` : "on budget"}
        </span>
      </span>
    );
  }

  // U+2212 MINUS SIGN, not a hyphen — it aligns with the digits. It is also
  // the reason this needs a spoken alternative: assistive tech reads it
  // inconsistently, and "5.3%" and "−5.3%" must never sound the same.
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const direction = value > 0 ? "up" : value < 0 ? "down" : "no change";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium whitespace-nowrap tabular-nums",
        value === 0 ? "text-text-muted" : "text-text",
        className,
      )}
    >
      <span aria-hidden="true">{`${sign}${amount}`}</span>
      <span className="sr-only">{value === 0 ? "no change" : `${direction} ${amountSpoken}`}</span>
    </span>
  );
}
