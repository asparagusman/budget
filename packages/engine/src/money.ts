// Money is always integer cents, never a float. `Cents` is a branded number so
// a raw `number` can't slip in where a monetary value is expected without an
// explicit conversion through `toCents`.

export type Cents = number & { readonly __brand: "Cents" };

/** Convert a dollar amount (e.g. from a form field) to integer cents. Rounds
 * half-up on the cent to absorb floating-point noise in the input. */
export function toCents(dollars: number): Cents {
  return Math.round(dollars * 100) as Cents;
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
 */
export function divideCents(total: Cents, weights: number[]): Cents[] {
  const n = weights.length;
  if (n === 0) return [];

  const weightSum = weights.reduce((a, b) => a + b, 0);

  if (weightSum === 0) {
    // No basis to split on. Put everything on the first share so the sum
    // still reconciles exactly, and everyone else gets zero.
    const shares = new Array<Cents>(n).fill(0 as Cents);
    shares[0] = total;
    return shares;
  }

  const raw = weights.map((w) => (total * w) / weightSum);
  const floors = raw.map((r) => Math.floor(r));
  const remainders = raw.map((r, i) => r - floors[i]!);

  const flooredSum = floors.reduce((a, b) => a + b, 0);
  let leftover = total - flooredSum;

  const shares = floors.slice();

  // Distribute leftover cents to the largest remainders first; index breaks
  // ties, so equal remainders always resolve the same way.
  const order = weights
    .map((_, i) => i)
    .sort((a, b) => {
      const diff = remainders[b]! - remainders[a]!;
      if (diff !== 0) return diff;
      return a - b;
    });

  // `leftover` can be negative if total < 0 (e.g. a reversal); step in the
  // matching direction one cent at a time either way.
  const step = leftover >= 0 ? 1 : -1;
  let i = 0;
  while (leftover !== 0) {
    const idx = order[i % n]!;
    shares[idx] = (shares[idx]! + step) as Cents;
    leftover -= step;
    i++;
  }

  return shares.map((s) => s as Cents);
}

/** pct is a percentage (8 means 8%). Rounds half-up on the cent. */
export function pctOfCents(amount: Cents, pct: number): Cents {
  return Math.round((amount * pct) / 100) as Cents;
}

export function sumCents(values: Cents[]): Cents {
  return values.reduce((a, b) => a + b, 0) as Cents;
}
