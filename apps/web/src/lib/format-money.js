/** @import { Cents } from "@budget/engine" */

// One `Intl.NumberFormat` per distinct set of options, built on first use and
// reused from then on. Constructing one is the expensive part — ICU resolves
// the locale's data every time, ~100µs — while `.format` on an existing one
// is ~2µs. `<Money>` formats twice per render and a page renders hundreds of
// them, so a fresh formatter per call was the largest single cost of mounting
// a page (.claude/plans/perf-inp-plan.md, P1.1). The set of keys is tiny: one
// locale and currency, times the handful of flag combinations below.
/** @type {Map<string, Intl.NumberFormat>} */
const formatters = new Map();

/**
 * @param {string} key
 * @param {string} locale
 * @param {Intl.NumberFormatOptions} options
 */
function cachedFormat(key, locale, options) {
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    formatters.set(key, formatter);
  }
  return formatter;
}

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
 *   whole?: boolean,
 * }} options `whole` rounds to the dollar — for an estimate, where cents
 * would claim a precision the figure doesn't have (a house price, a
 * repayment at a rate nobody has been offered yet).
 */
export function formatMoney(cents, { currency, locale, signed = false, compact = false, whole = false }) {
  const dollars = cents / 100;
  return cachedFormat(`money|${locale}|${currency}|${signed}|${compact}|${whole}`, locale, {
    style: "currency",
    currency,
    signDisplay: signed ? "exceptZero" : "auto",
    notation: compact ? "compact" : "standard",
    ...(whole ? { minimumFractionDigits: 0 } : {}),
    maximumFractionDigits: whole ? 0 : compact ? 1 : 2,
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
  return cachedFormat(`spoken|${locale}|${currency}|${signed}`, locale, {
    style: "currency",
    currency,
    currencyDisplay: "name",
    signDisplay: signed ? "exceptZero" : "auto",
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
