/** @import { Cents } from "./money.js" */

/**
 * @typedef {"weekly"
 *   | "fortnightly"
 *   | "monthly"
 *   | "every_2_months"
 *   | "quarterly"
 *   | "every_6_months"
 *   | "yearly"} Cadence
 */

// Naming note: the spreadsheet's "Bimonthly" means *every two months*, not
// twice monthly. `every_2_months` exists to kill that ambiguity permanently.
// Never reintroduce the word "bimonthly" in code or UI.
/** @type {Record<Cadence, number>} */
export const OCCURRENCES_PER_YEAR = {
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
 *
 * @param {Cents} amount
 * @param {Cadence} from
 * @returns {Cents}
 */
export function annualise(amount, from) {
  return Math.round(amount * OCCURRENCES_PER_YEAR[from]);
}

/**
 * @param {Cents} amount
 * @param {Cadence} from
 * @param {Cadence} to
 * @returns {Cents}
 */
export function equivalent(amount, from, to) {
  const annual = amount * OCCURRENCES_PER_YEAR[from];
  return Math.round(annual / OCCURRENCES_PER_YEAR[to]);
}
