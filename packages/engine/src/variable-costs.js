import { sumCents } from "./money.js";

/** @import { Cents } from "./money.js" */
/** @import { Cadence } from "./cadence.js" */
/** @import { IsoDate } from "./calendar.js" */

/**
 * @typedef {{
 *   amountCents: Cents,
 *   cadence: Cadence,
 *   effectiveFrom: IsoDate
 * }} VariableBudgetRow
 */

/**
 * The budget in force on `on`: the latest row with `effectiveFrom <= on`. A
 * new dated row is a new plan from that date forward — it never rewrites an
 * earlier row's own amount, so a date before every row's `effectiveFrom`
 * resolves to `null` rather than guessing backward to the earliest one
 * (phases/07-variable-costs.md "Schema"). Critically, a row dated *after*
 * `on` can never change what `on` resolves to — adding this month's new
 * budget must not alter a past cycle's already-computed variance.
 *
 * @template {VariableBudgetRow} T
 * @param {T[]} rows
 * @param {IsoDate} on
 * @returns {T | null}
 */
export function resolveVariableBudget(rows, on) {
  const applicable = rows.filter((r) => r.effectiveFrom <= on);
  if (applicable.length === 0) return null;
  return applicable.reduce((a, b) => (a.effectiveFrom > b.effectiveFrom ? a : b));
}

/**
 * Mean of recorded actuals, rounded to the nearest cent. `null` — never
 * `0` — when there is no history, so a category with nothing entered yet
 * reads as "—", not "$0.00" (phases/07-variable-costs.md "Acceptance
 * criteria").
 *
 * @param {Cents[]} actualsCents
 * @returns {Cents | null}
 */
export function trailingAverageCents(actualsCents) {
  if (actualsCents.length === 0) return null;
  return Math.round(sumCents(actualsCents) / actualsCents.length);
}
