import { describe, expect, it } from "vitest";
import { computeAllocation, diffAllocations } from "./allocation.js";
import { equivalent } from "./cadence.js";
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

  it("renders a goal in money, not only as a percentage", () => {
    const result = computeAllocation(baseInput());
    const save = mustFind(result.lines, (l) => l.lineId === "save");
    const invest = mustFind(result.lines, (l) => l.lineId === "invest");

    // 10% of $10,000 gross.
    expect(save.goalPerMonthCents).toBe(toCents(1000));
    // No goal set — null, not zero. A zero would read as "your goal is
    // nothing", which is a different claim from "you haven't set one".
    expect(invest.goalPerMonthCents).toBeNull();
    expect(invest.goalPerPayCents).toBeNull();

    // The stage's goal is the sum of its lines' goals, in money too.
    expect(mustAt(result.stages, 1).goalPerMonthCents).toBe(toCents(1000));
    expect(mustAt(result.stages, 0).goalPerMonthCents).toBeNull();
  });

  it("carries every cadence on a stage subtotal, matching its own lines", () => {
    const result = computeAllocation(baseInput({ payCadence: "fortnightly" }));
    const stage2 = mustAt(result.stages, 1);
    const save = mustFind(result.lines, (l) => l.lineId === "save");
    const invest = mustFind(result.lines, (l) => l.lineId === "invest");

    // The screen renders lines and their subtotal side by side; the subtotal
    // must not be in a different unit from the rows above it.
    expect(stage2.subtotalPerPayCents).toBe(save.perPayCents + invest.perPayCents);
    expect(stage2.subtotalPerWeekCents).toBe(save.perWeekCents + invest.perWeekCents);
    expect(stage2.remainingPerPayCents).toBeGreaterThan(0);
    expect(stage2.remainingPerPayCents).toBeLessThan(stage2.remainingPerMonthCents);
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

  it("measures Good Life against what is left after section B when there is no section C yet", () => {
    /** @type {AllocationLine[]} */
    const lines = [
      { id: "fixed", stage: 1, label: "Fixed", basis: "from_fixed_costs", value: null, goalPct: null, accountId: "bills" },
      { id: "save", stage: 2, label: "Save", basis: "pct_of_gross", value: 20, goalPct: null, accountId: "save" },
    ];
    const result = computeAllocation(
      baseInput({
        lines,
        fixedTotalPerMonthCents: toCents(5000),
        variableEssentialsPerMonthCents: 0,
        variableNonEssentialPerMonthCents: toCents(2500),
      }),
    );
    // $3,000 is left once the 20% saving is out, so $2,500 of aspiration has
    // $500 of headroom. Measured from stage 2's ENTRY — which still has the
    // saving in it — this read as $2,500 of headroom.
    expect(result.unallocatedPerMonthCents).toBe(toCents(3000));
    expect(result.goodLifeFidelityCents).toBe(toCents(-500));
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

describe("computeAllocation over-allocation", () => {
  it("is null for a plan that fits inside gross", () => {
    expect(computeAllocation(baseInput()).overAllocation).toBeNull();
  });

  it("flags a shortfall a sweep would otherwise hide", () => {
    // Gross $5,000 against $5,500 of needs and a 10% saving. The sweep lines
    // absorb the gap, so unallocated reads zero and the transfers still sum
    // to gross — the only trace is two negative transfers.
    const result = computeAllocation(
      baseInput({
        grossPerMonthCents: toCents(5000),
        payCadence: "fortnightly",
        fixedTotalPerMonthCents: toCents(4000),
        variableEssentialsPerMonthCents: toCents(1500),
        lines: [
          { id: "fixed", stage: 1, label: "Fixed", basis: "from_fixed_costs", value: null, goalPct: null, accountId: "bills" },
          { id: "variable", stage: 1, label: "Variable", basis: "from_variable_essentials", value: null, goalPct: null, accountId: "spending" },
          { id: "save", stage: 2, label: "Save", basis: "pct_of_gross", value: 10, goalPct: null, accountId: "save" },
          { id: "sweep_a", stage: 3, label: "Sweep A", basis: "sweep", value: 1, goalPct: null, accountId: "x" },
          { id: "sweep_b", stage: 3, label: "Sweep B", basis: "sweep", value: 1, goalPct: null, accountId: "y" },
        ],
      }),
    );

    expect(result.unallocatedPerMonthCents).toBe(0);
    expect(result.overAllocation).toEqual({
      // Stage 1 overspends by $500, stage 2's saving takes it to $1,000.
      shortfallPerMonthCents: toCents(1000),
      shortfallPerPayCents: equivalent(toCents(1000), "monthly", "fortnightly"),
      negativeLineIds: ["sweep_a", "sweep_b"],
      negativeStages: [1, 2],
    });
  });

  it("flags a plan whose percentages run past gross, with no sweep to absorb it", () => {
    const result = computeAllocation(
      baseInput({
        lines: [
          { id: "a", stage: 2, label: "A", basis: "pct_of_gross", value: 80, goalPct: null, accountId: "x" },
          { id: "b", stage: 2, label: "B", basis: "pct_of_gross", value: 50, goalPct: null, accountId: "y" },
        ],
      }),
    );

    expect(result.unallocatedPerMonthCents).toBe(toCents(-3000));
    expect(result.overAllocation).toMatchObject({
      shortfallPerMonthCents: toCents(3000),
      negativeLineIds: [],
      negativeStages: [2],
    });
  });

  it("flags a line below zero even while every stage stays in credit", () => {
    const result = computeAllocation(
      baseInput({
        lines: [
          { id: "refund", stage: 2, label: "Refund", basis: "fixed_amount", value: -5000, goalPct: null, accountId: "x" },
        ],
      }),
    );

    expect(result.overAllocation).toEqual({
      shortfallPerMonthCents: 0,
      shortfallPerPayCents: 0,
      negativeLineIds: ["refund"],
      negativeStages: [],
    });
  });
});

describe("computeAllocation section goals", () => {
  it("prefers a goal set on the section over the sum of its lines' goals", () => {
    // Stage 2's lines carry 10% between them. A goal on the section itself is
    // a different claim — "a quarter of our income should be going here" — and
    // it is the one the operator can see and edit, so it wins.
    const result = computeAllocation(baseInput({ stageGoals: [{ stage: 2, goalPct: 25 }] }));
    const stage2 = mustFind(result.stages, (s) => s.stage === 2);

    expect(stage2.goalPct).toBe(25);
    expect(stage2.goalSource).toBe("stage");
    expect(stage2.goalPerMonthCents).toBe(toCents(2500));
    expect(stage2.actualPct).toBe(15);
    // Relative to the goal, not in percentage points: 10 points under a goal
    // of 25 is 40% short of what was intended.
    expect(stage2.fidelity).toBeCloseTo(-0.4, 10);
  });

  it("falls back to the summed line goals, and says which it did", () => {
    const stages = computeAllocation(baseInput()).stages;

    // Stage 1's lines are the two injected totals and carry no goal at all —
    // "you haven't set one" is a different claim from "your goal is nothing",
    // so it stays null rather than becoming 0.
    expect(mustFind(stages, (s) => s.stage === 1)).toMatchObject({
      goalPct: null,
      goalSource: null,
      fidelity: null,
    });
    expect(mustFind(stages, (s) => s.stage === 2)).toMatchObject({
      goalPct: 10,
      goalSource: "lines",
    });
  });

  it("reads a 60% actual against a 50% section target as 20% over", () => {
    // The worked example the fidelity model was settled on, and the sheet's
    // own section A row. Kept as its own test because it is the sentence the
    // screen has to be able to say.
    const result = computeAllocation(
      baseInput({
        lines: [
          { id: "bills", stage: 1, label: "Bills", basis: "pct_of_gross", value: 60, goalPct: null, accountId: "bills" },
        ],
        stageGoals: [{ stage: 1, goalPct: 50 }],
      }),
    );
    const stage1 = mustAt(result.stages, 0);

    expect(stage1.actualPct).toBe(60);
    expect(stage1.goalPct).toBe(50);
    expect(stage1.fidelity).toBeCloseTo(0.2, 10);
  });

  it("moves no money — a goal is a marker, never an instruction", () => {
    // The whole reason goals are safe to carry: nothing in the engine ever
    // writes an allocation to meet one. If this fails, a goal has leaked into
    // the arithmetic.
    const before = computeAllocation(baseInput());
    const after = computeAllocation(
      baseInput({ stageGoals: [{ stage: 1, goalPct: 50 }, { stage: 2, goalPct: 99 }] }),
    );

    expect(after.lines).toEqual(before.lines);
    expect(after.transfers).toEqual(before.transfers);
    expect(after.unallocatedPerMonthCents).toBe(before.unallocatedPerMonthCents);
    expect(after.stages.map((s) => s.subtotalPerMonthCents)).toEqual(
      before.stages.map((s) => s.subtotalPerMonthCents),
    );
  });

  it("shows a section that has a goal but no lines yet", () => {
    // Setting the target before entering the lines is a normal way to work.
    // 0% against a goal is a real and readable state; dropping the section
    // until it has a line would hide the target that was just typed.
    const result = computeAllocation(
      baseInput({
        lines: [{ id: "fixed", stage: 1, label: "Fixed", basis: "from_fixed_costs", value: null, goalPct: null, accountId: "bills" }],
        stageGoals: [{ stage: 2, goalPct: 20 }],
      }),
    );
    const stage2 = mustFind(result.stages, (s) => s.stage === 2);

    expect(stage2.subtotalPerMonthCents).toBe(0);
    expect(stage2.actualPct).toBe(0);
    expect(stage2.goalPct).toBe(20);
    expect(stage2.fidelity).toBeCloseTo(-1, 10);
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
