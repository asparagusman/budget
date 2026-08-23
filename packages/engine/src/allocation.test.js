import { describe, expect, it } from "vitest";
import { computeAllocation, diffAllocations } from "./allocation.js";
import { toCents } from "./money.js";
import { mustAt, mustFind } from "./invariant.js";

/** @import { AllocationInput, AllocationLine } from "./allocation.js" */

/** @type {AllocationLine[]} */
const BASE_LINES = [
  { id: "fixed", stage: 1, label: "Fixed", basis: "from_fixed_costs", value: null, goalPct: null, accountId: "bills" },
  { id: "variable", stage: 1, label: "Variable", basis: "from_variable_essentials", value: null, goalPct: null, accountId: "spending" },
  { id: "save", stage: 2, label: "Save", basis: "pct_of_gross", value: 10, goalPct: 10, accountId: "save" },
  { id: "invest", stage: 2, label: "Invest", basis: "pct_of_gross", value: 5, goalPct: null, accountId: "invest" },
  { id: "sweep_a", stage: 3, label: "Sweep A", basis: "sweep", value: 1, goalPct: null, accountId: "x" },
  { id: "sweep_b", stage: 3, label: "Sweep B", basis: "sweep", value: 1, goalPct: null, accountId: "y" },
];

/**
 * @param {Partial<AllocationInput>} [overrides]
 * @returns {AllocationInput}
 */
function baseInput(overrides = {}) {
  return {
    grossPerMonthCents: toCents(10000),
    payCadence: "monthly",
    fixedTotalPerMonthCents: toCents(3000),
    variableEssentialsPerMonthCents: toCents(2000),
    variableNonEssentialPerMonthCents: toCents(1000),
    incomeLandingAccountId: "bills",
    lines: BASE_LINES,
    ...overrides,
  };
}

describe("computeAllocation", () => {
  it("resolves stages in ascending order against a stage-entry snapshot of remaining", () => {
    const result = computeAllocation(baseInput());

    expect(result.stages.map((s) => s.stage)).toEqual([1, 2, 3]);
    expect(result.stages[0]).toMatchObject({
      subtotalPerMonthCents: toCents(5000),
      remainingPerMonthCents: toCents(5000),
      goalPct: null,
      actualPct: 50,
      fidelity: null,
    });
    expect(result.stages[1]).toMatchObject({
      subtotalPerMonthCents: toCents(1500),
      remainingPerMonthCents: toCents(3500),
      goalPct: 10,
      actualPct: 15,
      fidelity: 0.5,
    });
    expect(result.stages[2]).toMatchObject({
      subtotalPerMonthCents: toCents(3500),
      remainingPerMonthCents: 0,
    });
  });

  it("resolves per-line actual% and fidelity against each line's own goal", () => {
    const result = computeAllocation(baseInput());
    const save = mustFind(result.lines, (l) => l.lineId === "save");
    const invest = mustFind(result.lines, (l) => l.lineId === "invest");
    expect(save.actualPct).toBe(10);
    expect(save.fidelity).toBe(0); // exactly meeting the goal
    expect(invest.actualPct).toBe(5);
    expect(invest.fidelity).toBeNull(); // no goal set
  });

  it("splits a sweep stage across its lines by weight, consuming all of remaining", () => {
    const result = computeAllocation(baseInput());
    const a = mustFind(result.lines, (l) => l.lineId === "sweep_a");
    const b = mustFind(result.lines, (l) => l.lineId === "sweep_b");
    expect(a.perMonthCents).toBe(toCents(1750));
    expect(b.perMonthCents).toBe(toCents(1750));
    expect(result.unallocatedPerMonthCents).toBe(0);
  });

  it("groups transfers by destination account and marks the income-landing account a no-op", () => {
    const result = computeAllocation(baseInput());
    const byAccount = Object.fromEntries(result.transfers.map((t) => [t.accountId, t]));

    expect(byAccount["bills"]).toMatchObject({ perMonthCents: toCents(3000), perPayCents: toCents(3000), isNoOp: true });
    expect(byAccount["spending"]).toMatchObject({ perMonthCents: toCents(2000), isNoOp: false });
    expect(byAccount["save"]).toMatchObject({ perMonthCents: toCents(1000) });
    expect(byAccount["invest"]).toMatchObject({ perMonthCents: toCents(500) });
    expect(byAccount["x"]).toMatchObject({ perMonthCents: toCents(1750) });
    expect(byAccount["y"]).toMatchObject({ perMonthCents: toCents(1750) });
  });

  it("reconciles transfers exactly to gross for the pay cadence", () => {
    const result = computeAllocation(baseInput());
    const total = result.transfers.reduce((sum, t) => sum + t.perPayCents, 0);
    expect(total).toBe(toCents(10000));
  });

  it("computes goodLifeFidelityCents as nonEssential minus what was actually available before the final stage", () => {
    const result = computeAllocation(baseInput());
    // Remaining entering stage 3 (the sweep stage) is 3500; benchmark is
    // 1000, so there's 2500 more available than the aspiration — headroom,
    // reported as negative.
    expect(result.goodLifeFidelityCents).toBe(toCents(-2500));
  });

  it("reports a positive unallocated amount when the lines don't sum to 100%, instead of it vanishing", () => {
    /** @type {AllocationLine[]} */
    const lines = [
      { id: "fixed", stage: 1, label: "Fixed", basis: "from_fixed_costs", value: null, goalPct: null, accountId: "bills" },
    ];
    const result = computeAllocation(
      baseInput({
        lines,
        fixedTotalPerMonthCents: toCents(3000),
        variableEssentialsPerMonthCents: toCents(0),
      }),
    );
    expect(result.unallocatedPerMonthCents).toBe(toCents(7000));
  });

  it("resolves fixed_amount and pct_of_remaining bases", () => {
    /** @type {AllocationLine[]} */
    const lines = [
      { id: "rent", stage: 1, label: "Rent", basis: "fixed_amount", value: 200000, goalPct: null, accountId: "landlord" },
      { id: "half_remaining", stage: 2, label: "Half of what's left", basis: "pct_of_remaining", value: 50, goalPct: null, accountId: "save" },
    ];
    const result = computeAllocation(baseInput({ lines }));
    const rent = mustFind(result.lines, (l) => l.lineId === "rent");
    const half = mustFind(result.lines, (l) => l.lineId === "half_remaining");
    expect(rent.perMonthCents).toBe(toCents(2000));
    // Remaining entering stage 2 is 10000 - 2000 = 8000; half of that is 4000.
    expect(half.perMonthCents).toBe(toCents(4000));
  });

  it("resolves every line in a stage against the same snapshot, independent of row order", () => {
    /** @type {AllocationLine[]} */
    const linesA = [
      { id: "a", stage: 1, label: "A", basis: "pct_of_remaining", value: 50, goalPct: null, accountId: "a" },
      { id: "b", stage: 1, label: "B", basis: "pct_of_remaining", value: 50, goalPct: null, accountId: "b" },
    ];
    /** @type {AllocationLine[]} */
    const linesB = [mustAt(linesA, 1), mustAt(linesA, 0)];
    const resultA = computeAllocation(baseInput({ lines: linesA }));
    const resultB = computeAllocation(baseInput({ lines: linesB }));
    expect(mustFind(resultA.lines, (l) => l.lineId === "a").perMonthCents).toBe(
      mustFind(resultB.lines, (l) => l.lineId === "a").perMonthCents,
    );
    expect(mustFind(resultA.lines, (l) => l.lineId === "b").perMonthCents).toBe(
      mustFind(resultB.lines, (l) => l.lineId === "b").perMonthCents,
    );
  });
});

describe("diffAllocations", () => {
  it("reports per-account deltas, including additions and removals", () => {
    // The income-landing account ("bills") absorbs whatever isn't
    // explicitly allocated, so adding a new destination line reduces what's
    // left sitting in "bills" by exactly what the new line takes.
    const active = computeAllocation(
      baseInput({ lines: [{ id: "fixed", stage: 1, label: "Fixed", basis: "from_fixed_costs", value: null, goalPct: null, accountId: "bills" }] }),
    );
    const draft = computeAllocation(
      baseInput({
        lines: [
          { id: "fixed", stage: 1, label: "Fixed", basis: "from_fixed_costs", value: null, goalPct: null, accountId: "bills" },
          { id: "new_save", stage: 2, label: "New Save", basis: "pct_of_gross", value: 10, goalPct: null, accountId: "new_save" },
        ],
      }),
    );

    const deltas = diffAllocations(active, draft);
    const byAccount = Object.fromEntries(deltas.map((d) => [d.accountId, d]));

    expect(byAccount["bills"]).toMatchObject({ fromPerPayCents: toCents(10000), toPerPayCents: toCents(9000), deltaPerPayCents: toCents(-1000) });
    expect(byAccount["new_save"]).toMatchObject({ fromPerPayCents: null, toPerPayCents: toCents(1000), deltaPerPayCents: toCents(1000) });
  });
});
