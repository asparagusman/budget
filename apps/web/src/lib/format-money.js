/** @import { Cents } from "@budget/engine" */

/**
 * Turns integer cents into a display string. This is the ONLY function in
 * the app that does that conversion — `<Money>` calls it, and so should
 * anything else that needs money as text (a toast, an aria-label).
 *
 * @param {Cents} cents
 * @param {{
 *   currency: string,
 *   locale: string,
 *   signed?: boolean,
 *   compact?: boolean,
 * }} options
 */
export function formatMoney(cents, { currency, locale, signed = false, compact = false }) {
  const dollars = cents / 100;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    signDisplay: signed ? "exceptZero" : "auto",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 2,
  }).format(dollars);
}
