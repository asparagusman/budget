import { describe, expect, it } from "vitest";

// Building an Intl formatter costs ~100–170µs; reusing one costs ~2–5µs.
// Pages format money and dates in loops — every `<Money>`, every point of a
// chart's data table, every grid cell's aria-label — so a `new Intl.*` in a
// component or a per-call helper quietly cost tens to hundreds of ms per
// render, and nothing about that is visible in a diff
// (.claude/plans/perf-inp-plan.md, P1.1).
//
// So construction lives in exactly two places, both of which cache:
// `formatMoney`/`formatMoneySpoken` here in lib/, and `getDateFormat` in
// lib/dates.js. Anything else that needs a formatter asks one of them.
const ALLOWED = new Set(["./format-money.js", "./dates.js"]);

const sources = /** @type {Record<string, string>} */ (
  import.meta.glob(["../**/*.{js,jsx}", "!../**/*.test.{js,jsx}"], {
    query: "?raw",
    import: "default",
    eager: true,
  })
);

describe("Intl formatters", () => {
  it("are only constructed by the two caching helpers", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !ALLOWED.has(path))
      .filter(([, source]) => /new\s+Intl\./.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("sees the source tree at all", () => {
    // A glob that silently matched nothing would pass the test above forever.
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(sources["./format-money.js"]).toMatch(/new\s+Intl\.NumberFormat/);
  });
});
