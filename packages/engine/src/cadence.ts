import type { Cents } from "./money.js";

export type Cadence =
  | "weekly"
  | "fortnightly"
  | "monthly"
  | "every_2_months"
  | "quarterly"
  | "every_6_months"
  | "yearly";

// Naming note: the spreadsheet's "Bimonthly" means *every two months*, not
// twice monthly. `every_2_months` exists to kill that ambiguity permanently.
// Never reintroduce the word "bimonthly" in code or UI.
export const OCCURRENCES_PER_YEAR: Record<Cadence, number> = {
  weekly: 52,
  fortnightly: 26,
  monthly: 12,
  every_2_months: 6,
  quarterly: 4,
  every_6_months: 2,
  yearly: 1,
};

/**
 * Conventional equivalence for display fan-out. Uses the fixed divisors
 * above (52 / 26 / 12 / …) — stable, familiar, approximate. Use this for
 * presentation only, never for cash flow or dates.
 */
export function annualise(amount: Cents, from: Cadence): Cents {
  return Math.round(amount * OCCURRENCES_PER_YEAR[from]) as Cents;
}

export function equivalent(amount: Cents, from: Cadence, to: Cadence): Cents {
  const annual = amount * OCCURRENCES_PER_YEAR[from];
  return Math.round(annual / OCCURRENCES_PER_YEAR[to]) as Cents;
}
