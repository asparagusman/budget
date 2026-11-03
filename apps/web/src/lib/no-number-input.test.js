import { describe, expect, it } from "vitest";

// The browser's number input nudges its value when the wheel scrolls over it,
// reads a pasted "1,234.50" as empty (so a grid saves it as null and clears
// the stored figure), accepts "1e3", and refuses 7.000000000000001 as a 7%
// growth rate. The fix is `MoneyInput`, `PercentInput` and `IntegerInput`
// (components/money-input.jsx), built on lib/use-numeric-text.js — and it
// only stays fixed if nobody quietly puts the old one back.
//
// Comments are searched too, on purpose: the one place that has to talk about
// the old input says so without writing the attribute out.
const sources = /** @type {Record<string, string>} */ (
  import.meta.glob(["../**/*.{js,jsx}", "!../**/*.test.{js,jsx}"], {
    query: "?raw",
    import: "default",
    eager: true,
  })
);

// The JSX attribute in any of its spellings: `type="number"`, `type='number'`,
// `type={"number"}`. Not `type: "number"`, which is how a Recharts axis says
// its scale is numeric (components/chart.jsx) and has nothing to do with an input.
const NUMBER_TYPE = /\btype\s*=\s*\{?\s*["'`]number["'`]/;

describe("number inputs", () => {
  it("are never the browser's own", () => {
    const offenders = Object.entries(sources)
      .filter(([, source]) => NUMBER_TYPE.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("sees the source tree, and the pattern catches each spelling", () => {
    // A glob that silently matched nothing would pass the test above forever.
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(sources["../components/money-input.jsx"]).toBeDefined();

    expect(NUMBER_TYPE.test('<input type="number" />')).toBe(true);
    expect(NUMBER_TYPE.test("<input type='number' />")).toBe(true);
    expect(NUMBER_TYPE.test('<input type={"number"} />')).toBe(true);
    expect(NUMBER_TYPE.test('const axis = { type: "number" }')).toBe(false);
    expect(NUMBER_TYPE.test('<input type="text" inputMode="decimal" />')).toBe(false);
  });
});
