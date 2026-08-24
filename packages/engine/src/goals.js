import { OCCURRENCES_PER_YEAR, equivalent } from "./cadence.js";
import { addDaysIso, daysBetween } from "./calendar.js";

/** @import { Cents } from "./money.js" */
/** @import { Cadence } from "./cadence.js" */
/** @import { IsoDate } from "./calendar.js" */

/** @typedef {"amount" | "months_of_expenses"} TargetMode */

/**
 * @typedef {{
 *   id: string,
 *   accountId: string,
 *   targetMode: TargetMode,
 *   targetAmountCents: Cents | null,
 *   targetMonths: number | null,
 *   targetDate: IsoDate | null
 * }} Goal
 */

/** @typedef {{ date: IsoDate, balanceCents: Cents }} CurvePoint */

/** Resolve a `months_of_expenses` target into cents using current essential
 * burn. An `amount` goal just returns its own target.
 *
 * @param {Goal} goal
 * @param {Cents} monthlyEssentialBurnCents
 */
export function resolveTargetCents(goal, monthlyEssentialBurnCents) {
  if (goal.targetMode === "amount") {
    return goal.targetAmountCents ?? 0;
  }
  return Math.round(monthlyEssentialBurnCents * (goal.targetMonths ?? 0));
}

/**
 * @param {number} annualGrowthRate
 * @param {Cadence} cadence
 */
function perPeriodRate(annualGrowthRate, cadence) {
  if (annualGrowthRate === 0) return 0;
  return Math.pow(1 + annualGrowthRate, 1 / OCCURRENCES_PER_YEAR[cadence]) - 1;
}

/** @param {Cadence} cadence */
function approxDaysPerPeriod(cadence) {
  return 365.25 / OCCURRENCES_PER_YEAR[cadence];
}

const MAX_PERIODS = 5_000_000;

/** At the current contribution, when do we arrive? Never `Infinity`, never
 * throws: a zero or negative contribution against a target not already met
 * returns `eta: null`. `aheadBehindDays` compares the growth-assisted arrival
 * against a pure-linear (no-growth) projection — positive means growth is
 * getting the goal there that many days sooner.
 *
 * @param {{
 *   targetCents: Cents,
 *   currentBalanceCents: Cents,
 *   contributionPerPayCents: Cents,
 *   payCadence: Cadence,
 *   annualGrowthRate: number,
 *   from: IsoDate,
 * }} args `annualGrowthRate` is 0 for no growth.
 */
export function goalEta(args) {
  const {
    targetCents,
    currentBalanceCents,
    contributionPerPayCents,
    payCadence,
    annualGrowthRate,
    from,
  } = args;

  if (currentBalanceCents >= targetCents) {
    return {
      eta: from,
      aheadBehindDays: 0,
      curve: [{ date: from, balanceCents: currentBalanceCents }],
    };
  }

  if (contributionPerPayCents <= 0) {
    return {
      eta: null,
      aheadBehindDays: null,
      curve: [{ date: from, balanceCents: currentBalanceCents }],
    };
  }

  const rate = perPeriodRate(annualGrowthRate, payCadence);
  const daysStep = approxDaysPerPeriod(payCadence);

  /** @param {number} r */
  const simulate = (r) => {
    /** @type {CurvePoint[]} */
    const curve = [{ date: from, balanceCents: currentBalanceCents }];
    let balance = currentBalanceCents;
    let elapsedDays = 0;
    let periods = 0;
    while (balance < targetCents && periods < MAX_PERIODS) {
      balance = Math.round(balance * (1 + r) + contributionPerPayCents);
      periods++;
      elapsedDays = Math.round(periods * daysStep);
      curve.push({ date: addDaysIso(from, elapsedDays), balanceCents: balance });
    }
    return { curve, elapsedDays, reached: balance >= targetCents };
  };

  const withGrowth = simulate(rate);
  if (!withGrowth.reached) {
    return { eta: null, aheadBehindDays: null, curve: withGrowth.curve };
  }

  const eta = addDaysIso(from, withGrowth.elapsedDays);

  /** @type {number | null} */
  let aheadBehindDays = null;
  if (rate !== 0) {
    const linear = simulate(0);
    aheadBehindDays = linear.reached
      ? linear.elapsedDays - withGrowth.elapsedDays
      : null;
  } else {
    aheadBehindDays = 0;
  }

  return { eta, aheadBehindDays, curve: withGrowth.curve };
}

/** To hit `targetDate`, what contribution is required?
 *
 * ```
 * C = (FV − P(1+r)ⁿ) · r / ((1+r)ⁿ − 1)          for r > 0
 * C = (FV − P) / n                               for r = 0
 * ```
 *
 * @param {{
 *   targetCents: Cents,
 *   currentBalanceCents: Cents,
 *   targetDate: IsoDate,
 *   payCadence: Cadence,
 *   annualGrowthRate: number,
 *   grossPerMonthCents: Cents,
 *   from: IsoDate,
 * }} args
 */
export function goalRequired(args) {
  const days = daysBetween(args.from, args.targetDate);
  const n = Math.max(
    0,
    Math.round((days / 365.25) * OCCURRENCES_PER_YEAR[args.payCadence]),
  );
  const r = perPeriodRate(args.annualGrowthRate, args.payCadence);

  /** @type {Cents} */
  let perPayCents;
  if (n <= 0) {
    // Target date is now or in the past: whatever shortfall exists is due
    // immediately, expressed as a single period's contribution.
    perPayCents = Math.max(0, args.targetCents - args.currentBalanceCents);
  } else if (r === 0) {
    perPayCents = Math.round((args.targetCents - args.currentBalanceCents) / n);
  } else {
    const growth = Math.pow(1 + r, n);
    const c =
      ((args.targetCents - args.currentBalanceCents * growth) * r) /
      (growth - 1);
    perPayCents = Math.round(c);
  }

  const perMonthCents = equivalent(perPayCents, args.payCadence, "monthly");
  const grossPerPayCents = equivalent(
    args.grossPerMonthCents,
    "monthly",
    args.payCadence,
  );
  const pctOfGross =
    grossPerPayCents !== 0 ? (perPayCents / grossPerPayCents) * 100 : 0;
  const feasible = perPayCents <= grossPerPayCents;

  return { perPayCents, perMonthCents, pctOfGross, feasible };
}
