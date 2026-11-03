import { describe, expect, it } from "vitest";
import {
  formatDecimalText,
  formatMoneyText,
  parseDecimalText,
  parseMoneyText,
  parseNumericText,
  roundTo,
} from "./numeric-text.js";

// What a number field's text is worth. The browser's number input read a
// pasted "1,234.50" as empty, which in the actuals and history grids saved as
// null and cleared the stored figure — so the cases below are the ones that
// went wrong, and "blank" is always null, never a zero that looks like data.

describe("parseMoneyText", () => {
  it("reads a pasted figure the way it was copied", () => {
    expect(parseMoneyText("1,234.5")).toBe(123_450);
    expect(parseMoneyText("$1,234.50")).toBe(123_450);
    expect(parseMoneyText("$12")).toBe(1_200);
    expect(parseMoneyText(" 12 000 ")).toBe(1_200_000);
  });

  it("reads blank as no figure, not as zero", () => {
    expect(parseMoneyText("")).toBeNull();
    expect(parseMoneyText("   ")).toBeNull();
    expect(parseMoneyText("$")).toBeNull();
    expect(parseMoneyText("0")).toBe(0);
  });

  it("reads a leading point", () => {
    expect(parseMoneyText(".5")).toBe(50);
  });

  it("rounds to the cent rather than truncating", () => {
    expect(parseMoneyText("12.345")).toBe(1_235);
    expect(parseMoneyText("12.344")).toBe(1_234);
    // 1.005 * 100 is 100.49999999999999 in floating point.
    expect(parseMoneyText("1.005")).toBe(101);
  });

  it("refuses a negative unless the field allows one", () => {
    expect(parseMoneyText("-5")).toBeNull();
    expect(parseMoneyText("-5", { allowNegative: true })).toBe(-500);
    expect(parseMoneyText("-$5.50", { allowNegative: true })).toBe(-550);
    expect(parseMoneyText("-12.345", { allowNegative: true })).toBe(-1_235);
  });

  it("refuses an exponent and anything else that is not a plain figure", () => {
    expect(parseMoneyText("1e3")).toBeNull();
    expect(parseMoneyText("1.2.3")).toBeNull();
    expect(parseMoneyText("12abc")).toBeNull();
    expect(parseMoneyText("-")).toBeNull();
    expect(parseMoneyText(".")).toBeNull();
  });

  it("never reports a negative zero", () => {
    expect(Object.is(parseMoneyText("-0", { allowNegative: true }), 0)).toBe(true);
  });
});

describe("formatMoneyText", () => {
  it("writes cents back as the text a field starts with", () => {
    expect(formatMoneyText(null)).toBe("");
    expect(formatMoneyText(0)).toBe("0");
    expect(formatMoneyText(1250)).toBe("12.5");
    expect(formatMoneyText(123_450)).toBe("1234.5");
    expect(formatMoneyText(-550)).toBe("-5.5");
  });

  it("round-trips through the parser", () => {
    for (const cents of [0, 1, 7, 1250, 387_733, -45_000]) {
      expect(parseMoneyText(formatMoneyText(cents), { allowNegative: true })).toBe(cents);
    }
  });
});

describe("parseDecimalText / formatDecimalText", () => {
  it("rounds to the places the field holds", () => {
    expect(parseDecimalText("7.000000000000001", 2)).toBe(7);
    expect(parseDecimalText("5.03259", 4)).toBe(5.0326);
    expect(parseDecimalText("12.5", 0)).toBe(13);
    expect(parseDecimalText("", 2)).toBeNull();
    expect(parseDecimalText("1e3", 2)).toBeNull();
    expect(parseDecimalText("-5", 2)).toBeNull();
    expect(parseDecimalText("-5", 2, { allowNegative: true })).toBe(-5);
  });

  it("shows a figure multiplied up from a fraction without the float noise", () => {
    // The growth rate that refused to save: 0.07 * 100.
    expect(0.07 * 100).not.toBe(7);
    expect(formatDecimalText(0.07 * 100, 4)).toBe("7");
    expect(formatDecimalText(0.050325 * 100, 4)).toBe("5.0325");
    expect(formatDecimalText(null, 2)).toBe("");
  });
});

describe("parseNumericText / roundTo", () => {
  it("strips the dollar sign, separators and spaces", () => {
    expect(parseNumericText("$1,234.50")).toBe(1234.5);
    expect(parseNumericText("1 234")).toBe(1234);
  });

  it("rounds half away from zero", () => {
    expect(roundTo(2.5, 0)).toBe(3);
    expect(roundTo(-2.5, 0)).toBe(-3);
    expect(roundTo(1.005, 2)).toBe(1.01);
  });
});
