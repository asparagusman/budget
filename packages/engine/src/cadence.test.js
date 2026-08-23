import { describe, expect, it } from "vitest";
import { OCCURRENCES_PER_YEAR, annualise, equivalent } from "./cadence.js";
import { toCents } from "./money.js";

/** @import { Cadence } from "./cadence.js" */

describe("OCCURRENCES_PER_YEAR", () => {
  it("uses fixed conventional divisors, not the spreadsheet's 'Bimonthly'", () => {
    expect(OCCURRENCES_PER_YEAR.weekly).toBe(52);
    expect(OCCURRENCES_PER_YEAR.fortnightly).toBe(26);
    expect(OCCURRENCES_PER_YEAR.monthly).toBe(12);
    expect(OCCURRENCES_PER_YEAR.every_2_months).toBe(6);
    expect(OCCURRENCES_PER_YEAR.quarterly).toBe(4);
    expect(OCCURRENCES_PER_YEAR.every_6_months).toBe(2);
    expect(OCCURRENCES_PER_YEAR.yearly).toBe(1);
  });
});

describe("annualise", () => {
  it("multiplies by the cadence's occurrences per year", () => {
    expect(annualise(toCents(90), "monthly")).toBe(toCents(1080));
    expect(annualise(toCents(175), "every_2_months")).toBe(toCents(1050));
  });
});

describe("equivalent", () => {
  it("converts a monthly amount to its fortnightly equivalent", () => {
    // 2111/mo -> annual 25332 -> /26 = 974.3076923...
    expect(equivalent(toCents(2111), "monthly", "fortnightly")).toBe(toCents(974.31));
  });

  it("round-trips through the same cadence unchanged", () => {
    const amount = toCents(123.45);
    const cadences = /** @type {Cadence[]} */ (Object.keys(OCCURRENCES_PER_YEAR));
    cadences.forEach((cadence) => {
      expect(equivalent(amount, cadence, cadence)).toBe(amount);
    });
  });

  it("is consistent with annualise for monthly -> yearly", () => {
    const amount = toCents(500);
    expect(equivalent(amount, "monthly", "yearly")).toBe(annualise(amount, "monthly"));
  });
});
