/** @import { Cents } from "./money.js" */

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
