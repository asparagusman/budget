import { describe, expect, it } from "vitest";
import { futureValueCents } from "./projections.js";
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
