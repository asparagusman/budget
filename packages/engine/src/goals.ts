import type { Cents } from "./money.js";
import type { Cadence } from "./cadence.js";
import { OCCURRENCES_PER_YEAR, equivalent } from "./cadence.js";
import type { IsoDate } from "./calendar.js";
import { addDaysIso, daysBetween } from "./calendar.js";

export type TargetMode = "amount" | "months_of_expenses";

export interface Goal {
  id: string;
  accountId: string;
  targetMode: TargetMode;
  targetAmountCents: Cents | null;
  targetMonths: number | null;
  targetDate: IsoDate | null;
}

/** Resolve a `months_of_expenses` target into cents using current essential
 * burn. An `amount` goal just returns its own target. */
export function resolveTargetCents(goal: Goal, monthlyEssentialBurnCents: Cents): Cents {
  if (goal.targetMode === "amount") {
    return goal.targetAmountCents ?? (0 as Cents);
  }
  return Math.round(monthlyEssentialBurnCents * (goal.targetMonths ?? 0)) as Cents;
}

function perPeriodRate(annualGrowthRate: number, cadence: Cadence): number {
  if (annualGrowthRate === 0) return 0;
  return Math.pow(1 + annualGrowthRate, 1 / OCCURRENCES_PER_YEAR[cadence]) - 1;
}

function approxDaysPerPeriod(cadence: Cadence): number {
  return 365.25 / OCCURRENCES_PER_YEAR[cadence];
}

const MAX_PERIODS = 5_000_000;

/** At the current contribution, when do we arrive? Never `Infinity`, never
 * throws: a zero or negative contribution against a target not already met
 * returns `eta: null`. `aheadBehindDays` compares the growth-assisted arrival
 * against a pure-linear (no-growth) projection — positive means growth is
 * getting the goal there that many days sooner. */
export function goalEta(args: {
  targetCents: Cents;
  currentBalanceCents: Cents;
  contributionPerPayCents: Cents;
  payCadence: Cadence;
  annualGrowthRate: number; // 0 for no growth
  from: IsoDate;
}): { eta: IsoDate | null; aheadBehindDays: number | null; curve: Array<{ date: IsoDate; balanceCents: Cents }> } {
  const { targetCents, currentBalanceCents, contributionPerPayCents, payCadence, annualGrowthRate, from } = args;

  if (currentBalanceCents >= targetCents) {
    return { eta: from, aheadBehindDays: 0, curve: [{ date: from, balanceCents: currentBalanceCents }] };
  }

  if (contributionPerPayCents <= 0) {
    return { eta: null, aheadBehindDays: null, curve: [{ date: from, balanceCents: currentBalanceCents }] };
  }

  const rate = perPeriodRate(annualGrowthRate, payCadence);
  const daysStep = approxDaysPerPeriod(payCadence);

  const simulate = (r: number) => {
    const curve: Array<{ date: IsoDate; balanceCents: Cents }> = [{ date: from, balanceCents: currentBalanceCents }];
    let balance = currentBalanceCents;
    let elapsedDays = 0;
    let periods = 0;
    while (balance < targetCents && periods < MAX_PERIODS) {
      balance = Math.round(balance * (1 + r) + contributionPerPayCents) as Cents;
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

  let aheadBehindDays: number | null = null;
  if (rate !== 0) {
    const linear = simulate(0);
    aheadBehindDays = linear.reached ? linear.elapsedDays - withGrowth.elapsedDays : null;
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
 */
export function goalRequired(args: {
  targetCents: Cents;
  currentBalanceCents: Cents;
  targetDate: IsoDate;
  payCadence: Cadence;
  annualGrowthRate: number;
  grossPerMonthCents: Cents;
  from: IsoDate;
}): { perPayCents: Cents; perMonthCents: Cents; pctOfGross: number; feasible: boolean } {
  const days = daysBetween(args.from, args.targetDate);
  const n = Math.max(0, Math.round((days / 365.25) * OCCURRENCES_PER_YEAR[args.payCadence]));
  const r = perPeriodRate(args.annualGrowthRate, args.payCadence);

  let perPayCents: Cents;
  if (n <= 0) {
    // Target date is now or in the past: whatever shortfall exists is due
    // immediately, expressed as a single period's contribution.
    perPayCents = Math.max(0, (args.targetCents as number) - (args.currentBalanceCents as number)) as Cents;
  } else if (r === 0) {
    perPayCents = Math.round(((args.targetCents as number) - (args.currentBalanceCents as number)) / n) as Cents;
  } else {
    const growth = Math.pow(1 + r, n);
    const c = (((args.targetCents as number) - (args.currentBalanceCents as number) * growth) * r) / (growth - 1);
    perPayCents = Math.round(c) as Cents;
  }

  const perMonthCents = equivalent(perPayCents, args.payCadence, "monthly");
  const grossPerPayCents = equivalent(args.grossPerMonthCents, "monthly", args.payCadence);
  const pctOfGross = grossPerPayCents !== 0 ? ((perPayCents as number) / (grossPerPayCents as number)) * 100 : 0;
  const feasible = perPayCents <= grossPerPayCents;

  return { perPayCents, perMonthCents, pctOfGross, feasible };
}
