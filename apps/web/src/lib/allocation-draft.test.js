import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allocationDraftHistory,
  draftLineProblem,
  draftLineToEngine,
  draftProblems,
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

/** The signature an autosave would send for the draft as it stands. */
function currentSignature() {
  const { lines, stageGoals } = useAllocationDraft.getState();
  return draftLinesSignature(lines, stageGoals);
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

describe("what can't be saved yet", () => {
  // An incomplete line used to go to the server anyway: the PUT 400'd, the
  // whole autosave was refused, nothing retried, and the page went on saying
  // "saving shortly". These are the API's own rules, checked first so the
  // line is marked and nothing is sent.

  /** @param {Partial<import("./allocation-draft.js").DraftLine>} patch */
  function line(patch) {
    return {
      id: "l",
      stage: 2,
      label: "Mojo",
      basis: /** @type {Basis} */ ("pct_of_gross"),
      valueText: "10",
      goalPctText: "",
      accountId: ACCOUNT,
      ...patch,
    };
  }

  it("passes a complete line, and one whose amount is injected rather than typed", () => {
    expect(draftLineProblem(line({}))).toBeNull();
    expect(draftLineProblem(line({ basis: "from_fixed_costs", valueText: "" }))).toBeNull();
  });

  it("marks a line added but not yet given a value", () => {
    expect(draftLineProblem(line({ valueText: "" }))).toEqual({ field: "value", message: "Needs a value." });
    expect(draftLineProblem(line({ basis: "sweep", valueText: "" }))?.message).toBe("Needs a value.");
    // "." is what the field holds between keystrokes; it is not a number yet.
    expect(draftLineProblem(line({ valueText: "." }))?.message).toBe("The value isn't a number.");
  });

  it("marks a percentage over 100 typed on the way to something else", () => {
    expect(draftLineProblem(line({ valueText: "150" }))?.message).toMatch(/100 is the most/);
    expect(draftLineProblem(line({ basis: "pct_of_remaining", valueText: "100" }))).toBeNull();
    // A fixed amount is dollars, not a percentage.
    expect(draftLineProblem(line({ basis: "fixed_amount", valueText: "150" }))).toBeNull();
  });

  it("marks a goal outside 0–100 and a line with nowhere to go, on the field at fault", () => {
    expect(draftLineProblem(line({ goalPctText: "120" }))).toMatchObject({
      field: "goal",
      message: expect.stringMatching(/between 0 and 100/),
    });
    expect(draftLineProblem(line({ accountId: "" }))).toEqual({
      field: "destination",
      message: "Choose where this goes.",
    });
  });

  it("marks the second line drawing the same injected total, not the first", () => {
    const problems = draftProblems(
      [
        line({ id: "a", stage: 1, basis: "from_fixed_costs", valueText: "" }),
        line({ id: "b", stage: 1, basis: "from_fixed_costs", valueText: "" }),
      ],
      {},
    );
    expect(problems.byLine.has("a")).toBe(false);
    expect(problems.byLine.get("b")?.message).toMatch(/Only one line/);
    expect(problems.count).toBe(1);
  });

  it("marks a section goal over 100, and ignores a cleared one", () => {
    const problems = draftProblems([line({})], { 1: "", 2: "140", 3: "25" });
    expect([...problems.byStage.keys()]).toEqual([2]);
    expect(problems.byLine.size).toBe(0);
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

describe("remembering what the server holds, across page visits", () => {
  // The page decides whether to re-adopt the server's draft by comparing it
  // with this. It used to live in a component ref that restarted at null on
  // every visit, so every visit reloaded the draft — new line ids, every row
  // remounted — from a cached preview that could predate this browser's own
  // last autosave (perf-inp-plan.md, P2 #1).
  beforeEach(() => {
    useAllocationDraft.getState().reset();
  });

  it("records the loaded draft's signature", () => {
    useAllocationDraft.getState().load("v1", LOADED, [{ stage: 2, goalPct: 20 }]);
    expect(useAllocationDraft.getState().savedSignature).toBe(
      serverLinesSignature(LOADED, [{ stage: 2, goalPct: 20 }]),
    );
  });

  it("moves it forward to whatever each save sent", () => {
    useAllocationDraft.getState().load("v1", LOADED);
    useAllocationDraft.getState().markSaved("after-save");
    expect(useAllocationDraft.getState().savedSignature).toBe("after-save");
    expect(useAllocationDraft.getState().serverSignature).toBe("after-save");
  });

  it("keeps what the server wrote back apart from what was sent", () => {
    // A goal of 12.345% comes back as 12.35. `dirty` must compare against
    // what was SENT (or the rounded copy reads unsaved and autosaves in a
    // loop); the page's "did the other session change it?" check must
    // compare against what came BACK (or our own save reloads the draft
    // over the operator's undo history).
    useAllocationDraft.getState().load("v1", LOADED);
    useAllocationDraft.getState().updateLine(idOf("Mojo"), { goalPctText: "12.345" });
    const sent = currentSignature();
    useAllocationDraft.getState().markSaved(sent, "as-stored");
    expect(useAllocationDraft.getState().dirty).toBe(false);
    expect(useAllocationDraft.getState().serverSignature).toBe("as-stored");
  });

  it("puts loaded lines in section-then-position order, and calls that clean", () => {
    // The draft's own signature reads position from the array, so a load that
    // kept the server's arbitrary row order would look edited the moment it
    // landed — and autosave a reorder nobody made.
    useAllocationDraft.getState().load("v1", [...LOADED].reverse());
    expect(labels()).toEqual([
      [1, "Bills"],
      [2, "Mojo"],
      [2, "House"],
      [3, "Spending"],
    ]);
    expect(useAllocationDraft.getState().dirty).toBe(false);
  });

  it("forgets it on reset", () => {
    useAllocationDraft.getState().load("v1", LOADED);
    useAllocationDraft.getState().reset();
    expect(useAllocationDraft.getState().savedSignature).toBeNull();
    expect(useAllocationDraft.getState().serverSignature).toBeNull();
  });

  it("leaves an already-empty draft alone on reset, so nothing re-renders", () => {
    const before = useAllocationDraft.getState().lines;
    useAllocationDraft.getState().reset();
    expect(useAllocationDraft.getState().lines).toBe(before);
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
    useAllocationDraft.getState().markSaved(currentSignature());
    expect(useAllocationDraft.getState().dirty).toBe(false);
  });

  it("keeps an edit typed while a save was in flight", () => {
    // The autosave sends "12"; before it answers, the operator types "15".
    // The save's success used to clear `dirty` outright, so "15" sat on
    // screen, unsent, with nothing left to send it.
    const mojo = idOf("Mojo");
    useAllocationDraft.getState().updateLine(mojo, { valueText: "12" });
    const sent = currentSignature();
    useAllocationDraft.getState().updateLine(mojo, { valueText: "15" });
    useAllocationDraft.getState().markSaved(sent);
    expect(useAllocationDraft.getState().dirty).toBe(true);

    // The follow-up save sends "15", and only that one clears it.
    useAllocationDraft.getState().markSaved(currentSignature());
    expect(useAllocationDraft.getState().dirty).toBe(false);
  });

  it("is clean again when an edit lands back on what was saved", () => {
    const mojo = idOf("Mojo");
    useAllocationDraft.getState().updateLine(mojo, { valueText: "12" });
    useAllocationDraft.getState().updateLine(mojo, { valueText: "10" });
    // Nothing differs from the server, so there is nothing to autosave.
    expect(useAllocationDraft.getState().dirty).toBe(false);
  });

  it("does not count a change the save would normalise away", () => {
    // A trailing space is trimmed on the way out, so it is not an edit.
    useAllocationDraft.getState().updateLine(idOf("Mojo"), { label: "Mojo " });
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

  it("makes the draft dirty when an undo goes back past a save", () => {
    // Type 99, let it autosave, then undo. The screen shows the old value
    // while the server holds 99 — and an undo that left the draft "saved"
    // skipped the autosave, so Apply promoted the 99 the operator had undone.
    const mojo = idOf("Mojo");
    useAllocationDraft.getState().updateLine(mojo, { valueText: "99" });
    useAllocationDraft.getState().markSaved(currentSignature());
    expect(useAllocationDraft.getState().dirty).toBe(false);

    allocationDraftHistory.getState().undo();
    expect(useAllocationDraft.getState().lines.find((l) => l.id === mojo)?.valueText).toBe("10");
    expect(useAllocationDraft.getState().dirty).toBe(true);

    // And redo back onto the saved state is clean again: nothing to send.
    allocationDraftHistory.getState().redo();
    expect(useAllocationDraft.getState().dirty).toBe(false);
  });

  it("calls an undo that lands exactly on the saved state clean", () => {
    useAllocationDraft.getState().updateLine(idOf("Mojo"), { valueText: "99" });
    useAllocationDraft.getState().markSaved(currentSignature());
    vi.advanceTimersByTime(400);
    useAllocationDraft.getState().removeLine(idOf("House"));
    expect(useAllocationDraft.getState().dirty).toBe(true);

    allocationDraftHistory.getState().undo();
    expect(labels()).toHaveLength(4);
    expect(useAllocationDraft.getState().dirty).toBe(false);
  });

  it("records no undo step for a save, and keeps redo through one", () => {
    // Saving touches only bookkeeping. It used to push a copy of the current
    // lines onto the stack — one press of Undo after every autosave did
    // nothing visible — and to wipe the redo stack.
    useAllocationDraft.getState().updateLine(idOf("Mojo"), { valueText: "99" });
    vi.advanceTimersByTime(1000);
    useAllocationDraft.getState().markSaved(currentSignature());
    expect(allocationDraftHistory.getState().pastStates).toHaveLength(1);

    allocationDraftHistory.getState().undo();
    vi.advanceTimersByTime(1000);
    useAllocationDraft.getState().markSaved(currentSignature());
    expect(allocationDraftHistory.getState().futureStates).toHaveLength(1);
  });

  it("forgets the previous plan's history when a new one is loaded", () => {
    useAllocationDraft.getState().updateLine(idOf("Mojo"), { valueText: "99" });
    expect(allocationDraftHistory.getState().pastStates.length).toBeGreaterThan(0);
    useAllocationDraft.getState().load("v2", LOADED);
    // Otherwise undo on the new plan would paste in a different plan's lines.
    expect(allocationDraftHistory.getState().pastStates).toHaveLength(0);
  });
});
