import { mustAt } from "./invariant.js";

// Money is always integer cents, never a float.
//
// `Cents` is a documentation alias, not a distinct type — it marks intent in
// signatures, but it will not stop a dollars value being passed where cents
// are expected. The enforcement for that is the `*_cents` / `*Cents` naming
// rule, `toCents()` at every input edge, and the reconciliation assertions in
// the test suite. See the "Money" section of the phase README.

/** @typedef {number} Cents */

/** Convert a dollar amount (e.g. from a form field) to integer cents. Rounds
 * half-up on the cent to absorb floating-point noise in the input.
 *
 * @param {number} dollars
 * @returns {Cents}
 */
export function toCents(dollars) {
  return Math.round(dollars * 100);
}

/**
 * Split `total` across `weights` so the results sum to EXACTLY `total`.
 * Largest-remainder method: each weight gets its floor share, then the
 * leftover cents are handed out one at a time to the shares with the largest
 * fractional remainder. Ties break deterministically by index (earlier index
 * wins) so the result never depends on iteration order.
 *
 * Negative weights, weights summing to zero, a single weight and an empty
 * list are all handled without throwing.
 *
 * @param {Cents} total
 * @param {number[]} weights
 * @returns {Cents[]}
 */
export function divideCents(total, weights) {
  const n = weights.length;
  if (n === 0) return [];

  const weightSum = weights.reduce((a, b) => a + b, 0);

  if (weightSum === 0) {
    // No basis to split on. Put everything on the first share so the sum
    // still reconciles exactly, and everyone else gets zero.
    const shares = Array.from({ length: n }, () => 0);
    shares[0] = total;
    return shares;
  }

  const raw = weights.map((w) => (total * w) / weightSum);
  const floors = raw.map((r) => Math.floor(r));
  const remainders = raw.map((r) => r - Math.floor(r));

  const flooredSum = floors.reduce((a, b) => a + b, 0);
  let leftover = total - flooredSum;

  const shares = floors.slice();

  // Distribute leftover cents to the largest remainders first; index breaks
  // ties, so equal remainders always resolve the same way. Carrying the index
  // alongside the remainder keeps the comparator free of array lookups.
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .map((entry) => entry.index);

  // `leftover` can be negative if total < 0 (e.g. a reversal); step in the
  // matching direction one cent at a time either way.
  const step = leftover >= 0 ? 1 : -1;
  let i = 0;
  while (leftover !== 0) {
    const idx = mustAt(order, i % n, "share index");
    shares[idx] = mustAt(shares, idx, "share") + step;
    leftover -= step;
    i++;
  }

  return shares;
}

/** pct is a percentage (8 means 8%). Rounds half-up on the cent.
 *
 * @param {Cents} amount
 * @param {number} pct
 * @returns {Cents}
 */
export function pctOfCents(amount, pct) {
  return Math.round((amount * pct) / 100);
}

/**
 * @param {Cents[]} values
 * @returns {Cents}
 */
export function sumCents(values) {
  return values.reduce((a, b) => a + b, 0);
}
