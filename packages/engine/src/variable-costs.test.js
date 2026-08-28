import { describe, expect, it } from "vitest";
import { resolveVariableBudget, trailingAverageCents } from "./variable-costs.js";
import { toCents } from "./money.js";

/** @import { VariableBudgetRow } from "./variable-costs.js" */

describe("resolveVariableBudget", () => {
  it("returns null when no row applies yet", () => {
    expect(resolveVariableBudget([], "2026-01-01")).toBeNull();

    /** @type {VariableBudgetRow[]} */
    const futureOnly = [{ amountCents: toCents(50), cadence: "monthly", effectiveFrom: "2026-02-01" }];
    expect(resolveVariableBudget(futureOnly, "2026-01-01")).toBeNull();
  });

  it("picks the latest row at or before the date", () => {
    /** @type {VariableBudgetRow[]} */
    const rows = [
      { amountCents: toCents(50), cadence: "monthly", effectiveFrom: "2026-01-01" },
      { amountCents: toCents(70), cadence: "monthly", effectiveFrom: "2026-06-01" },
    ];
    expect(resolveVariableBudget(rows, "2026-03-01")?.amountCents).toBe(toCents(50));
    expect(resolveVariableBudget(rows, "2026-06-01")?.amountCents).toBe(toCents(70));
    expect(resolveVariableBudget(rows, "2026-12-01")?.amountCents).toBe(toCents(70));
  });

  it("resolves a date landing exactly on effectiveFrom to that row, not the one before it", () => {
    /** @type {VariableBudgetRow[]} */
    const rows = [
      { amountCents: toCents(50), cadence: "monthly", effectiveFrom: "2026-01-01" },
      { amountCents: toCents(70), cadence: "monthly", effectiveFrom: "2026-06-01" },
    ];
    expect(resolveVariableBudget(rows, "2026-06-01")?.amountCents).toBe(toCents(70));
  });

  it("the trap: a later-dated row never changes what an earlier date resolves to", () => {
    /** @type {VariableBudgetRow[]} */
    const before = [{ amountCents: toCents(50), cadence: "monthly", effectiveFrom: "2026-01-01" }];
    /** @type {VariableBudgetRow[]} */
    const after = [...before, { amountCents: toCents(70), cadence: "monthly", effectiveFrom: "2026-08-01" }];

    expect(resolveVariableBudget(before, "2026-03-01")?.amountCents).toBe(toCents(50));
    // Adding this month's new budget must not alter a past cycle's already-
    // computed variance (phases/07-variable-costs.md "Acceptance criteria").
    expect(resolveVariableBudget(after, "2026-03-01")?.amountCents).toBe(toCents(50));
  });
});

describe("trailingAverageCents", () => {
  it("is null, not zero, with no history", () => {
    expect(trailingAverageCents([])).toBeNull();
  });

  it("rounds the mean half-up", () => {
    expect(trailingAverageCents([toCents(10), toCents(11)])).toBe(toCents(10.5));
    expect(trailingAverageCents([100, 100, 101])).toBe(100); // 301/3 = 100.33... -> 100
    expect(trailingAverageCents([100, 100, 102])).toBe(101); // 302/3 = 100.66... -> 101
  });

  it("averages a single value to itself", () => {
    expect(trailingAverageCents([toCents(42)])).toBe(toCents(42));
  });
});
