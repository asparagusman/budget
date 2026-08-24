import { cn } from "@/lib/utils.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";

/** @import { Cents } from "@budget/engine" */

/**
 * Renders integer cents as a currency string. The only place in the app a
 * `*_cents` value becomes text — see `formatMoney()`, which this wraps.
 *
 * @param {{
 *   value: Cents,
 *   signed?: boolean,
 *   compact?: boolean,
 *   cadence?: string,
 *   className?: string,
 * }} props
 */
export function Money({ value, signed = false, compact = false, cadence, className }) {
  const { currency, locale } = useSettings();
  const formatted = formatMoney(value, { currency, locale, signed, compact });

  return (
    <span className={cn(className)}>
      {formatted}
      {cadence ? <span className="text-text-subtle">/{cadence}</span> : null}
    </span>
  );
}
