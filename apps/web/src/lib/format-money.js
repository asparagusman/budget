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

/**
 * The same amount, spelled for a screen reader: "3,877.68 Australian
 * dollars" rather than the symbol form, which assistive tech reads
 * inconsistently and often wrongly — "dollar three eight seven point three
 * three" is a real NVDA rendering of `$387.33`
 * (phases/11-polish-mobile-import.md, workstream B "Accessibility").
 *
 * `currencyDisplay: "name"` is Intl doing this, not a hand-rolled string, so
 * it stays correct for whatever currency and locale the operator sets in
 * Settings. Never bypass it with a template literal that hardcodes
 * "dollars".
 *
 * @param {Cents} cents
 * @param {{ currency: string, locale: string, signed?: boolean }} options
 */
export function formatMoneySpoken(cents, { currency, locale, signed = false }) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "name",
    signDisplay: signed ? "exceptZero" : "auto",
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
