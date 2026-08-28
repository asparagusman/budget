import { describe, expect, it } from "vitest";
import { futureValueCents, periodRate } from "./projections.js";
import { toCents } from "./money.js";

describe("futureValueCents", () => {
  it("degrades to simple addition when the rate is zero", () => {
    expect(futureValueCents(toCents(1000), toCents(100), 0, 12)).toBe(toCents(1000 + 100 * 12));
  });

  it("compounds principal and contributions at a positive rate", () => {
    const fv = futureValueCents(toCents(10000), toCents(500), 0.01, 12);
    // FV = P(1+r)^n + C*((1+r)^n - 1)/r
    const growth = Math.pow(1.01, 12);
    const expected = Math.round(1000000 * growth + 50000 * ((growth - 1) / 0.01));
    expect(fv).toBe(expected);
  });

  it("handles zero months (no time elapsed)", () => {
    expect(futureValueCents(toCents(500), toCents(100), 0.01, 0)).toBe(toCents(500));
  });

  it("handles a zero contribution (pure compounding)", () => {
    const fv = futureValueCents(toCents(1000), 0, 0.02, 6);
    expect(fv).toBe(Math.round(100000 * Math.pow(1.02, 6)));
  });
});

describe("periodRate", () => {
  it("returns zero for a zero annual rate, without calling pow", () => {
    expect(periodRate(0, "monthly")).toBe(0);
    expect(periodRate(0, "fortnightly")).toBe(0);
  });

  it("compounds rather than dividing — twelve monthly periods reproduce the annual rate", () => {
    const monthly = periodRate(0.05, "monthly");
    expect(monthly).toBeLessThan(0.05 / 12); // compounding beats naive division
    expect(Math.pow(1 + monthly, 12) - 1).toBeCloseTo(0.05, 12);
  });

  it("reproduces the spreadsheet's monthly rates from their annual equivalents", () => {
    // phases/09-goals-projections.md "Example data": 0.0041/mo -> ~5.03% p.a.,
    // 0.012/mo -> ~15.39% p.a. Stored annually at 4 decimal places, so the
    // round trip lands within a rounding step of the original monthly figure.
    expect(periodRate(0.0503, "monthly")).toBeCloseTo(0.0041, 5);
    expect(periodRate(0.1539, "monthly")).toBeCloseTo(0.012, 5);
  });

  it("scales with the cadence — a fortnightly period grows less than a monthly one", () => {
    expect(periodRate(0.1, "fortnightly")).toBeLessThan(periodRate(0.1, "monthly"));
    expect(periodRate(0.1, "yearly")).toBeCloseTo(0.1, 12);
  });
});
