// Reading and writing the text of a number field — the half of
// `components/money-input.jsx` that has no DOM in it, so what a pasted figure
// means can be tested without rendering anything.
//
// `useNumericText` decides which keystrokes a field accepts; these decide what
// the accepted text is worth. The two agree on the grammar: an optional minus,
// digits, an optional point, digits. Anything else ("1e3", "1.2.3", "12abc")
// is not a figure, and reads as `null` — blank — rather than as a surprise.

const PLAIN = /^-?(?:\d+\.?\d*|\.\d+)$/;

/**
 * The text of a field as a number, or `null` when it is not (yet) one: blank,
 * a lone "-" or ".", an exponent, or a negative where `allowNegative` is off.
 * "$" and thousands separators are how a figure was copied, not part of it.
 *
 * @param {string} text
 * @param {{ allowNegative?: boolean }} [options]
 * @returns {number | null}
 */
export function parseNumericText(text, { allowNegative = false } = {}) {
  const raw = text.replace(/[$,\s]/g, "");
  if (!PLAIN.test(raw)) return null;
  const n = Number(raw);
  if (n < 0 && !allowNegative) return null;
  return n;
}

/**
 * `n` to `decimals` places, half away from zero. Multiplying first and
 * trimming to 15 significant digits absorbs the float noise that makes
 * `12.345 * 100` land a hair under 1234.5 and round the wrong way — and is
 * what turns `0.07 * 100` into the 7 it was meant to be.
 *
 * @param {number} n
 * @param {number} decimals
 */
export function roundTo(n, decimals) {
  const factor = 10 ** decimals;
  const scaled = Number((Math.abs(n) * factor).toPrecision(15));
  return (Math.sign(n) * Math.round(scaled)) / factor + 0;
}

/**
 * A dollar field's text as whole cents. Blank is `null`, never 0: the caller
 * decides whether an empty field means "keep what is stored", "clear it" or
 * "refuse", and a zero here would have made that choice for it.
 *
 * @param {string} text
 * @param {{ allowNegative?: boolean }} [options]
 * @returns {number | null}
 */
export function parseMoneyText(text, options) {
  const dollars = parseNumericText(text, options);
  return dollars === null ? null : Math.round(roundTo(dollars, 2) * 100) + 0;
}

/**
 * The text a field starts with for a stored figure: "12.5" for 1250 cents,
 * "" for none.
 *
 * @param {number | null} cents
 */
export function formatMoneyText(cents) {
  return cents === null ? "" : String(cents / 100);
}

/**
 * A plain number field's text as a number rounded to `decimals`, or `null`.
 *
 * @param {string} text
 * @param {number} decimals
 * @param {{ allowNegative?: boolean }} [options]
 * @returns {number | null}
 */
export function parseDecimalText(text, decimals, options) {
  const n = parseNumericText(text, options);
  return n === null ? null : roundTo(n, decimals);
}

/**
 * The text a field starts with for a stored number — rounded to `decimals`
 * first, so a rate that was multiplied up from a fraction shows as "7", not
 * "7.000000000000001".
 *
 * @param {number | null} n
 * @param {number} decimals
 */
export function formatDecimalText(n, decimals) {
  return n === null ? "" : String(roundTo(n, decimals));
}
