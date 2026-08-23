import { describe, expect, it } from "vitest";
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
});
