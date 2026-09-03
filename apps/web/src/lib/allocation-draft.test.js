import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allocationDraftHistory,
  draftLineToEngine,
  draftLinesSignature,
  draftLinesToPayload,
  draftStageGoalsToPayload,
  lineValueToText,
  serverLinesSignature,
  textToLineValue,
  useAllocationDraft,
} from "./allocation-draft.js";

/** @import { Basis } from "@budget/engine" */

// The allocation editor holds the only unsaved state in the app: a plan the
// operator is part-way through rewriting, autosaved on a timer, undoable, and
// reconciled against whatever the other browser wrote. Every rule below is
// one that a wrong `lines` array turns into a wrong bank transfer.

const ACCOUNT = "acct-1";

/** @param {{ stage: number, label: string, basis?: Basis, value?: number | null, goalPct?: number | null, sortOrder?: number }} row */
function serverRow({ stage, label, basis = "pct_of_gross", value = 10, goalPct = null, sortOrder = 0 }) {
  return { id: `srv-${label}`, stage, label, basis, value, goalPct, accountId: ACCOUNT, sortOrder };
}

const LOADED = [
  serverRow({ stage: 1, label: "Bills", basis: "from_fixed_costs", value: null, sortOrder: 0 }),
  serverRow({ stage: 2, label: "Mojo", value: 10, sortOrder: 1 }),
  serverRow({ stage: 2, label: "House", value: 7, sortOrder: 2 }),
  serverRow({ stage: 3, label: "Spending", basis: "pct_of_remaining", value: 100, sortOrder: 3 }),
];

/** @param {string} label */
function idOf(label) {
  const line = useAllocationDraft.getState().lines.find((l) => l.label === label);
  if (!line) throw new Error(`no draft line labelled ${label}`);
  return line.id;
}

function labels() {
  return useAllocationDraft.getState().lines.map((l) => [l.stage, l.label]);
}

describe("the value input, which means a different thing per basis", () => {
  it("round-trips a percentage unchanged and a fixed amount through cents", () => {
    expect(lineValueToText("pct_of_gross", 7.5)).toBe("7.5");
    expect(textToLineValue("pct_of_gross", "7.5")).toBe(7.5);
    // Stored as integer cents, typed and displayed as dollars.
    expect(lineValueToText("fixed_amount", 48_914)).toBe("489.14");
    expect(textToLineValue("fixed_amount", "489.14")).toBe(48_914);
  });

  it("treats an empty or unparseable field as no value, never as zero", () => {
    // A cleared field is the absence of a number. Reading it as 0 would make
    // a percentage line silently allocate nothing while still looking set.
    expect(textToLineValue("pct_of_gross", "")).toBeNull();
    expect(textToLineValue("pct_of_gross", "   ")).toBeNull();
    expect(textToLineValue("fixed_amount", "abc")).toBeNull();
    expect(lineValueToText("fixed_amount", null)).toBe("");
  });

  it("keeps a half-typed number as text rather than fighting the operator", () => {
    // "7." is what the field holds between the 7 and the 5. The draft has to
    // survive that keystroke without rewriting the input.
    const line = { id: "l", stage: 2, label: "Mojo", basis: /** @type {Basis} */ ("pct_of_gross"), valueText: "7.", goalPctText: "", accountId: ACCOUNT };
    expect(draftLineToEngine(line).value).toBe(7);
    expect(line.valueText).toBe("7.");
  });
});

describe("what gets sent to the server", () => {
  it("numbers the lines by their position, so a reorder is what persists", () => {
    const payload = draftLinesToPayload([
      { id: "a", stage: 1, label: "Bills", basis: "from_fixed_costs", valueText: "", goalPctText: "", accountId: ACCOUNT },
      { id: "b", stage: 2, label: "Mojo", basis: "pct_of_gross", valueText: "10", goalPctText: "12", accountId: ACCOUNT },
    ]);
    expect(payload.map((l) => l.sortOrder)).toEqual([0, 1]);
    expect(payload[1]?.goalPct).toBe(12);
  });

  it("gives an unnamed line a name rather than sending an empty one", () => {
    const payload = draftLinesToPayload([
      { id: "a", stage: 2, label: "   ", basis: "pct_of_gross", valueText: "5", goalPctText: "", accountId: ACCOUNT },
    ]);
    expect(payload[0]?.label).toBe("Untitled");
  });

  it("omits a section whose goal was cleared, rather than sending a goal of nothing", () => {
    // A cleared goal is "this section has no target", which is different from
    // "this section is aiming at 0%" — and the difference shows on screen as
    // a fidelity bar that either exists or does not.
    expect(draftStageGoalsToPayload({ 1: "55", 2: "", 3: "  " })).toEqual([{ stage: 1, goalPct: 55 }]);
    expect(draftStageGoalsToPayload({ 1: "55", 2: "20", 3: "25" })).toHaveLength(3);
  });
});

describe("telling our draft apart from the one the other browser saved", () => {
  it("ignores line ids, which the server reassigns on every save", () => {
    useAllocationDraft.getState().load("v1", LOADED);
    // Same content, different ids: the signatures must agree, or every save
    // would look like a concurrent edit by someone else.
    expect(draftLinesSignature(useAllocationDraft.getState().lines)).toBe(serverLinesSignature(LOADED));
  });

  it("notices a section goal moved even when no line changed", () => {
    const withGoal = serverLinesSignature(LOADED, [{ stage: 2, goalPct: 20 }]);
    expect(withGoal).not.toBe(serverLinesSignature(LOADED));
    useAllocationDraft.getState().load("v1", LOADED, [{ stage: 2, goalPct: 20 }]);
    expect(draftLinesSignature(useAllocationDraft.getState().lines, useAllocationDraft.getState().stageGoals)).toBe(
      withGoal,
    );
  });

  it("does not care what order the server returned the rows in", () => {
    const shuffled = [...LOADED].reverse();
    expect(serverLinesSignature(shuffled)).toBe(serverLinesSignature(LOADED));
  });
});

describe("editing the draft", () => {
  beforeEach(() => {
    useAllocationDraft.getState().reset();
    useAllocationDraft.getState().load("v1", LOADED);
  });

  it("starts clean and dirties on the first edit", () => {
    expect(useAllocationDraft.getState().dirty).toBe(false);
    useAllocationDraft.getState().updateLine(idOf("Mojo"), { valueText: "12" });
    expect(useAllocationDraft.getState().dirty).toBe(true);
    useAllocationDraft.getState().markSaved();
    expect(useAllocationDraft.getState().dirty).toBe(false);
  });

  it("adds a line after the last one of its own section, not at the end", () => {
    useAllocationDraft.getState().addLine(2, ACCOUNT);
    expect(labels()).toEqual([
      [1, "Bills"],
      [2, "Mojo"],
      [2, "House"],
      [2, ""],
      [3, "Spending"],
    ]);
  });

  it("gives a new Leftover row a share of what's left, not a share of gross", () => {
    useAllocationDraft.getState().addLine(3, ACCOUNT);
    const added = useAllocationDraft.getState().lines.filter((l) => l.stage === 3 && l.label === "");
    expect(added[0]?.basis).toBe("pct_of_remaining");
    useAllocationDraft.getState().addLine(2, ACCOUNT);
    expect(useAllocationDraft.getState().lines.find((l) => l.stage === 2 && l.label === "")?.basis).toBe(
      "pct_of_gross",
    );
  });

  it("moves a line only within its own section", () => {
    useAllocationDraft.getState().moveLine(idOf("House"), -1);
    expect(labels()).toEqual([
      [1, "Bills"],
      [2, "House"],
      [2, "Mojo"],
      [3, "Spending"],
    ]);
    // "House" is now first in section 2. Another press up must not lift it
    // into section 1 — crossing a boundary is an explicit choice.
    useAllocationDraft.getState().moveLine(idOf("House"), -1);
    expect(labels()[1]).toEqual([2, "House"]);
  });

  it("moves a line into the section it was dropped on", () => {
    useAllocationDraft.getState().moveLineBefore(idOf("Spending"), idOf("Mojo"));
    expect(labels()).toEqual([
      [1, "Bills"],
      [2, "Spending"],
      [2, "Mojo"],
      [2, "House"],
    ]);
  });

  it("leaves the draft alone when a drag lands on itself or on nothing", () => {
    const before = labels();
    useAllocationDraft.getState().moveLineBefore(idOf("Mojo"), idOf("Mojo"));
    useAllocationDraft.getState().moveLineBefore("no-such-line", idOf("Mojo"));
    useAllocationDraft.getState().moveLine("no-such-line", 1);
    expect(labels()).toEqual(before);
  });

  it("puts a restaged line at the end of its new section", () => {
    useAllocationDraft.getState().setLineStage(idOf("Bills"), 2);
    expect(labels()).toEqual([
      [2, "Mojo"],
      [2, "House"],
      [2, "Bills"],
      [3, "Spending"],
    ]);
  });
});

describe("undo", () => {
  // The history throttle keeps its "last recorded at" in a module-level
  // closure, so the clock these tests share has to move FORWARD and never
  // back — a clock that jumped backwards would look like one long burst and
  // swallow the next test's first edit. Hence one far-future fake clock for
  // the whole suite, advanced between tests, rather than a fresh one per
  // test (and not the fake-timer default of the Unix epoch, which the
  // throttle's own zero sentinel is indistinguishable from).
  beforeAll(() => {
    vi.useFakeTimers({ now: new Date("2099-01-01T00:00:00Z") });
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    useAllocationDraft.getState().reset();
    useAllocationDraft.getState().load("v1", LOADED);
    // Loading is itself a set, and it opened a throttle window. Step past it,
    // so the first edit each test makes counts as the start of its own burst
    // rather than as the tail of the setup.
    vi.advanceTimersByTime(1000);
  });

  it("starts with nothing to undo, because loading is not an edit", () => {
    expect(allocationDraftHistory.getState().pastStates).toHaveLength(0);
  });

  it("records one step per burst of typing, not one per keystroke", () => {
    const mojo = idOf("Mojo");
    // Dragging a percentage from 8 to 12 is two keys. Having to press undo
    // twice to get back reads as a bug.
    useAllocationDraft.getState().updateLine(mojo, { valueText: "1" });
    useAllocationDraft.getState().updateLine(mojo, { valueText: "12" });
    expect(allocationDraftHistory.getState().pastStates).toHaveLength(1);

    // A later burst is its own step.
    vi.advanceTimersByTime(400);
    useAllocationDraft.getState().updateLine(mojo, { valueText: "15" });
    expect(allocationDraftHistory.getState().pastStates).toHaveLength(2);

    allocationDraftHistory.getState().undo();
    expect(useAllocationDraft.getState().lines.find((l) => l.id === mojo)?.valueText).toBe("12");
  });

  it("restores the lines without un-dirtying the draft", () => {
    useAllocationDraft.getState().updateLine(idOf("Mojo"), { valueText: "99" });
    useAllocationDraft.getState().markSaved();
    vi.advanceTimersByTime(400);
    useAllocationDraft.getState().removeLine(idOf("House"));

    allocationDraftHistory.getState().undo();
    expect(labels()).toHaveLength(4);
    // An undo that also cleared `dirty` would skip the autosave that has to
    // follow it, and the server would keep the state the operator just undid.
    expect(useAllocationDraft.getState().dirty).toBe(true);
  });

  it("forgets the previous plan's history when a new one is loaded", () => {
    useAllocationDraft.getState().updateLine(idOf("Mojo"), { valueText: "99" });
    expect(allocationDraftHistory.getState().pastStates.length).toBeGreaterThan(0);
    useAllocationDraft.getState().load("v2", LOADED);
    // Otherwise undo on the new plan would paste in a different plan's lines.
    expect(allocationDraftHistory.getState().pastStates).toHaveLength(0);
  });
});
