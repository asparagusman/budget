import { describe, expect, it } from "vitest";
import { daysBetween } from "./calendar.js";
import { goalEta, goalRequired, resolveTargetCents } from "./goals.js";
import { toCents } from "./money.js";

/** @import { Goal } from "./goals.js" */

describe("resolveTargetCents", () => {
  it("returns the amount directly for an 'amount' goal", () => {
    /** @type {Goal} */
    const goal = { id: "g", accountId: "a", targetMode: "amount", targetAmountCents: toCents(5000), targetMonths: null, targetDate: null };
    expect(resolveTargetCents(goal, toCents(1000))).toBe(toCents(5000));
  });

  it("resolves 'months_of_expenses' against the current essential burn", () => {
    /** @type {Goal} */
    const goal = { id: "g", accountId: "a", targetMode: "months_of_expenses", targetAmountCents: null, targetMonths: 3, targetDate: null };
    expect(resolveTargetCents(goal, toCents(2000))).toBe(toCents(6000));
  });

  it("can't resolve 'months_of_expenses' before any costs are recorded", () => {
    // Six months of nothing is $0, which every balance meets — the goal read
    // "Reached" on a household that had not entered a single bill.
    /** @type {Goal} */
    const goal = { id: "g", accountId: "a", targetMode: "months_of_expenses", targetAmountCents: null, targetMonths: 6, targetDate: null };
    expect(resolveTargetCents(goal, 0)).toBeNull();
    expect(resolveTargetCents(goal, -100)).toBeNull();
  });
});

describe("goalEta", () => {
  it("returns eta immediately when the target is already met", () => {
    const result = goalEta({
      targetCents: toCents(1000),
      currentBalanceCents: toCents(1000),
      contributionPerPayCents: toCents(100),
      payCadence: "fortnightly",
      annualGrowthRate: 0,
      from: "2026-01-01",
    });
    expect(result.eta).toBe("2026-01-01");
    expect(result.aheadBehindDays).toBe(0);
  });

  it("returns null, never Infinity or a throw, for a zero contribution short of target", () => {
    const result = goalEta({
      targetCents: toCents(1000),
      currentBalanceCents: toCents(0),
      contributionPerPayCents: toCents(0),
      payCadence: "fortnightly",
      annualGrowthRate: 0,
      from: "2026-01-01",
    });
    expect(result.eta).toBeNull();
    expect(result.aheadBehindDays).toBeNull();
    expect(Number.isFinite(result.eta)).toBe(false);
  });

  it("returns null for a negative contribution short of target", () => {
    const result = goalEta({
      targetCents: toCents(1000),
      currentBalanceCents: toCents(0),
      contributionPerPayCents: toCents(-50),
      payCadence: "fortnightly",
      annualGrowthRate: 0,
      from: "2026-01-01",
    });
    expect(result.eta).toBeNull();
  });

  it("reaches the target with a flat (no-growth) contribution in the expected number of periods", () => {
    const result = goalEta({
      targetCents: toCents(1000),
      currentBalanceCents: toCents(0),
      contributionPerPayCents: toCents(100),
      payCadence: "fortnightly",
      annualGrowthRate: 0,
      from: "2026-01-01",
    });
    // 10 contributions of 100 to reach 1000, exactly.
    expect(result.curve).toHaveLength(11); // starting point + 10 steps
    expect(result.eta).not.toBeNull();
  });

  it("arrives sooner with growth than the equivalent linear projection", () => {
    const result = goalEta({
      targetCents: toCents(100000),
      currentBalanceCents: toCents(0),
      contributionPerPayCents: toCents(1000),
      payCadence: "monthly",
      annualGrowthRate: 0.1,
      from: "2026-01-01",
    });
    expect(result.eta).not.toBeNull();
    expect(result.aheadBehindDays).not.toBeNull();
    expect(/** @type {number} */ (result.aheadBehindDays)).toBeGreaterThanOrEqual(0);
  });

  it("measures growth's head start against the no-growth arrival in closed form", () => {
    const args = {
      targetCents: toCents(1000),
      currentBalanceCents: toCents(0),
      contributionPerPayCents: toCents(100),
      payCadence: /** @type {const} */ ("monthly"),
      annualGrowthRate: 0.1,
      from: "2026-01-01",
    };
    const withGrowth = goalEta(args);
    const linear = goalEta({ ...args, annualGrowthRate: 0 });

    // Without growth: exactly 10 periods. The comparison has to say the same
    // thing the no-growth projection itself says.
    expect(linear.curve).toHaveLength(11);
    expect(withGrowth.aheadBehindDays).toBe(
      daysBetween(args.from, /** @type {string} */ (linear.eta)) -
        daysBetween(args.from, /** @type {string} */ (withGrowth.eta)),
    );
  });

  it("answers a comparison millions of periods long without walking them", () => {
    // $1 a fortnight toward $20M: growth arrives in about 53 years, the
    // no-growth comparison in 20 million fortnights. Simulated, that comparison
    // took 10 s and then gave up past five million periods with a null; it
    // has to be a division. (The default 5 s test timeout is the guard.)
    const result = goalEta({
      targetCents: toCents(20_000_000),
      currentBalanceCents: toCents(10_000),
      contributionPerPayCents: toCents(1),
      payCadence: "fortnightly",
      annualGrowthRate: 0.153896,
      from: "2026-10-07",
    });
    const linearPeriods = Math.ceil((toCents(20_000_000) - toCents(10_000)) / toCents(1));

    expect(result.eta).not.toBeNull();
    expect(result.aheadBehindDays).toBe(
      Math.round(linearPeriods * (365.25 / 26)) - daysBetween("2026-10-07", /** @type {string} */ (result.eta)),
    );
  });
});

describe("goalRequired", () => {
  it("splits the shortfall evenly across periods when there's no growth", () => {
    const result = goalRequired({
      targetCents: toCents(1000),
      currentBalanceCents: toCents(0),
      targetDate: "2026-01-01",
      payCadence: "fortnightly",
      annualGrowthRate: 0,
      grossPerMonthCents: toCents(10000),
      from: "2025-01-01",
    });
    expect(result.perPayCents).toBeGreaterThan(0);
    expect(result.perMonthCents).toBeGreaterThan(0);
    expect(typeof result.feasible).toBe("boolean");
  });

  it("is feasible when the required contribution fits within gross income", () => {
    const result = goalRequired({
      targetCents: toCents(1200),
      currentBalanceCents: toCents(0),
      targetDate: "2027-01-01",
      payCadence: "monthly",
      annualGrowthRate: 0,
      grossPerMonthCents: toCents(10000),
      from: "2026-01-01",
    });
    // 12 months, $100/mo required against $10,000/mo gross.
    expect(result.perMonthCents).toBe(toCents(100));
    expect(result.feasible).toBe(true);
  });

  it("is infeasible when the required contribution would exceed gross income", () => {
    const result = goalRequired({
      targetCents: toCents(1_000_000),
      currentBalanceCents: toCents(0),
      targetDate: "2026-02-01",
      payCadence: "monthly",
      annualGrowthRate: 0,
      grossPerMonthCents: toCents(1000),
      from: "2026-01-01",
    });
    expect(result.feasible).toBe(false);
  });

  it("requires the full shortfall immediately when the target date is not in the future", () => {
    const result = goalRequired({
      targetCents: toCents(1000),
      currentBalanceCents: toCents(400),
      targetDate: "2026-01-01",
      payCadence: "monthly",
      annualGrowthRate: 0,
      grossPerMonthCents: toCents(10000),
      from: "2026-01-01",
    });
    expect(result.perPayCents).toBe(toCents(600));
  });

  it("never asks for a negative contribution, on any branch", () => {
    const common = {
      targetCents: toCents(10_000),
      targetDate: "2027-10-07",
      payCadence: /** @type {const} */ ("fortnightly"),
      grossPerMonthCents: toCents(10_000),
      from: "2026-10-07",
    };
    const cases = [
      // Already met, no growth — the r = 0 branch said -$76.92 a fortnight.
      { ...common, currentBalanceCents: toCents(12_000), annualGrowthRate: 0 },
      // Already met, with growth — the r > 0 branch.
      { ...common, currentBalanceCents: toCents(12_000), annualGrowthRate: 0.05 },
      // Not met, but growth alone gets there — said -$10.89.
      { ...common, currentBalanceCents: toCents(9_800), annualGrowthRate: 0.05 },
      // Target date already passed and already met — the n <= 0 branch.
      { ...common, currentBalanceCents: toCents(12_000), annualGrowthRate: 0, targetDate: "2026-01-01" },
    ];
    for (const args of cases) {
      expect(goalRequired(args)).toEqual({ perPayCents: 0, perMonthCents: 0, pctOfGross: 0, feasible: true });
    }
  });
});
