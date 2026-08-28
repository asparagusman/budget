import { OCCURRENCES_PER_YEAR } from "./cadence.js";

/** @import { Cents } from "./money.js" */
/** @import { Cadence } from "./cadence.js" */

/**
 * An annual growth rate as the equivalent rate for ONE period of `cadence`,
 * compounding — `(1 + annual)^(1/periods) - 1`, not `annual / periods`.
 *
 * Rates are stored and edited annually because that is how humans think about
 * returns, and because the source spreadsheet's monthly 0.0041 formatted as
 * `0%` and was invisible for months (phases/09-goals-projections.md
 * "/projections"). Every consumer converts through here rather than doing it
 * itself: `futureValueCents` below takes a monthly rate, `goalEta` a per-pay
 * one, and a hand-rolled division would quietly disagree with both.
 *
 * @param {number} annualGrowthRate 0.05 == 5% p.a.
 * @param {Cadence} cadence
 */
export function periodRate(annualGrowthRate, cadence) {
  if (annualGrowthRate === 0) return 0;
  return Math.pow(1 + annualGrowthRate, 1 / OCCURRENCES_PER_YEAR[cadence]) - 1;
}

/**
 * `FV = P(1+r)ⁿ + C·((1+r)ⁿ − 1)/r`, degrading to `P + C·n` when `r === 0`.
 * `monthlyRate` is the per-month growth rate (0.01 == 1%/month), `months`
 * the number of monthly contributions.
 *
 * @param {Cents} principalCents
 * @param {Cents} contributionPerMonthCents
 * @param {number} monthlyRate
 * @param {number} months
 */
export function futureValueCents(
  principalCents,
  contributionPerMonthCents,
  monthlyRate,
  months,
) {
  if (monthlyRate === 0) {
    return principalCents + contributionPerMonthCents * months;
  }
  const growth = Math.pow(1 + monthlyRate, months);
  const fv =
    principalCents * growth +
    contributionPerMonthCents * ((growth - 1) / monthlyRate);
  return Math.round(fv);
}
