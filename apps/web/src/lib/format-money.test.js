import { describe, expect, it } from "vitest";
import { formatMoney, formatMoneySpoken } from "./format-money.js";

// The only place in the app that turns cents into text. Everything visible on
// screen goes through it, so the tests below are about the two things a money
// formatter gets quietly wrong: dropping a cent, and losing a minus sign.
const AUD = { currency: "AUD", locale: "en-AU" };

describe("formatMoney", () => {
  it("keeps both cents", () => {
    expect(formatMoney(387_733, AUD)).toBe("$3,877.33");
    // The rounding case: 0.005 of a dollar must not become a rounded-away
    // half cent on the way to the screen.
    expect(formatMoney(1, AUD)).toBe("$0.01");
    expect(formatMoney(0, AUD)).toBe("$0.00");
  });

  it("shows a negative as negative", () => {
    expect(formatMoney(-45_000, AUD)).toBe("-$450.00");
  });

  it("shows a leading + only when asked, and never on zero", () => {
    // `signed` is for deltas, where "+$12.00" and "$12.00" mean different
    // things. Zero is neither, and "+$0.00" would be a claim.
    expect(formatMoney(1_200, { ...AUD, signed: true })).toBe("+$12.00");
    expect(formatMoney(-1_200, { ...AUD, signed: true })).toBe("-$12.00");
    expect(formatMoney(0, { ...AUD, signed: true })).toBe("$0.00");
  });

  it("abbreviates only when asked", () => {
    expect(formatMoney(125_000_00, { ...AUD, compact: true })).toBe("$125.0K");
    expect(formatMoney(125_000_00, AUD)).toBe("$125,000.00");
  });

  it("follows the currency and locale the operator set, not a hardcoded dollar", () => {
    expect(formatMoney(387_733, { currency: "EUR", locale: "de-DE" })).toContain("€");
    expect(formatMoney(387_733, { currency: "USD", locale: "en-US" })).toBe("$3,877.33");
  });
});

describe("formatMoneySpoken", () => {
  it("names the currency instead of using a symbol", () => {
    // "$387.33" is read aloud by real screen readers as "dollar three eight
    // seven point three three"; the name form is not.
    const spoken = formatMoneySpoken(38_733, AUD);
    expect(spoken).toContain("Australian dollars");
    expect(spoken).not.toContain("$");
  });

  it("still says which side of zero it is on", () => {
    expect(formatMoneySpoken(-38_733, AUD)).toContain("-");
    expect(formatMoneySpoken(38_733, { ...AUD, signed: true })).toContain("+");
  });
});
