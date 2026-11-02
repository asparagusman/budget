import { ALLOCATION_SECTIONS, toCents } from "@budget/engine";
import { create } from "zustand";
import { temporal } from "zundo";

/** @import { AllocationLine, Basis, Cents } from "@budget/engine" */

/**
 * @typedef {{
 *   id: string,
 *   stage: number,
 *   label: string,
 *   basis: Basis,
 *   valueText: string,
 *   goalPctText: string,
 *   accountId: string,
 * }} DraftLine
 *
 * The editor's own line shape. `valueText` and `goalPctText` are the raw
 * strings from their inputs, not numbers or nulls: the preview recomputes on
 * every keystroke, and a number would make "7." or "" unrepresentable — the
 * field would fight the operator mid-type. They also make undo restore exactly
 * what was typed.
 *
 * `stage` is the section the line sits in — 1, 2 or 3. There is no per-line
 * category: the sheet's "Category" column is the section heading, and `label`
 * is its "Division".
 */

/**
 * A section's own goal, as typed. Keyed by stage, and a raw string for the
 * same reason `goalPctText` is one.
 *
 * @typedef {Record<number, string>} DraftStageGoals
 */

// Ids are local to the editing session and never sent anywhere: PUT
// /allocation-versions/:id/lines replaces the whole set, so the server assigns
// its own. They only need to be unique for React keys and for the engine's
// line-to-result mapping.
let lineSeq = 0;
function nextLineId() {
  lineSeq += 1;
  return `draft-line-${lineSeq}`;
}

// What a new row in each section starts as. Section A's amounts are injected
// totals with nothing to type, so a new row there is a percentage of gross
// like section B's; section C divides what's left.
/** @param {number} stage */
function defaultBasisForStage(stage) {
  return /** @type {Basis} */ (stage === 3 ? "pct_of_remaining" : "pct_of_gross");
}

/**
 * The value input means a different thing per basis — a percentage, a dollar
 * amount, or a relative weight (see packages/schema/src/tables/allocation.js).
 * Stored `value` is a percentage, integer CENTS, or a weight to match, so the
 * text conversion has to know the basis both ways.
 *
 * @param {Basis} basis
 * @param {number | null} value
 */
export function lineValueToText(basis, value) {
  if (value === null) return "";
  return basis === "fixed_amount" ? String(value / 100) : String(value);
}

/**
 * @param {Basis} basis
 * @param {string} text
 * @returns {number | null}
 */
export function textToLineValue(basis, text) {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed)) return null;
  return basis === "fixed_amount" ? toCents(parsed) : parsed;
}

/** @param {string} text */
function textToGoalPct(text) {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Draft line -> the engine's pure `AllocationLine`. The one conversion the
 * live preview depends on; everything downstream of it is engine arithmetic.
 *
 * @param {DraftLine} line
 * @returns {AllocationLine}
 */
export function draftLineToEngine(line) {
  return {
    id: line.id,
    stage: line.stage,
    label: line.label,
    basis: line.basis,
    value: textToLineValue(line.basis, line.valueText),
    goalPct: textToGoalPct(line.goalPctText),
    accountId: line.accountId,
  };
}

/**
 * Draft line -> the API's line payload. `sortOrder` comes from the line's
 * position within its stage, so a drag or a move up/down is what persists —
 * there is no separate ordering field for the operator to get wrong.
 *
 * @param {DraftLine[]} lines
 */
export function draftLinesToPayload(lines) {
  return lines.map((line, index) => ({
    stage: line.stage,
    label: line.label.trim() === "" ? "Untitled" : line.label.trim(),
    basis: line.basis,
    value: textToLineValue(line.basis, line.valueText),
    goalPct: textToGoalPct(line.goalPctText),
    accountId: line.accountId,
    sortOrder: index,
  }));
}

/**
 * Draft stage goals -> the API's payload. Only the sections that actually
 * carry a number are sent: a cleared field is the absence of a goal, not a
 * goal of nothing (the same rule `goalPct` follows on a line).
 *
 * @param {DraftStageGoals} stageGoals
 */
export function draftStageGoalsToPayload(stageGoals) {
  return ALLOCATION_SECTIONS.map((section) => ({
    stage: section.stage,
    goalPct: textToGoalPct(stageGoals[section.stage] ?? ""),
  })).flatMap((goal) => (goal.goalPct === null ? [] : [{ stage: goal.stage, goalPct: goal.goalPct }]));
}

/**
 * Server stage goals -> the editor's keyed strings.
 *
 * @param {{ stage: number, goalPct: number }[]} rows
 * @returns {DraftStageGoals}
 */
export function serverStageGoalsToDraft(rows) {
  /** @type {DraftStageGoals} */
  const out = {};
  for (const row of rows) out[row.stage] = String(row.goalPct);
  return out;
}

/**
 * Server line -> draft line.
 *
 * @param {{ id: string, stage: number, label: string, basis: Basis, value: number | null, goalPct: number | null, accountId: string }} row
 * @returns {DraftLine}
 */
export function serverLineToDraft(row) {
  return {
    id: nextLineId(),
    stage: row.stage,
    label: row.label,
    basis: row.basis,
    valueText: lineValueToText(row.basis, row.value),
    goalPctText: row.goalPct === null ? "" : String(row.goalPct),
    accountId: row.accountId,
  };
}

/**
 * A stable signature of what the server holds, used to tell "this draft
 * changed in the other session" from "this is the same draft we already have".
 * Deliberately ignores line ids, which are reassigned on every save.
 *
 * Section goals are part of it: a goal typed in the other session is a change
 * to the same draft, and a signature blind to it would leave one browser
 * showing a target the other had already moved.
 *
 * @param {{ stage: number, label: string, basis: string, value: number | null, goalPct: number | null, accountId: string, sortOrder: number }[]} rows
 * @param {{ stage: number, goalPct: number }[]} [stageGoalRows]
 */
export function serverLinesSignature(rows, stageGoalRows = []) {
  return JSON.stringify([
    [...rows]
      .sort((a, b) => a.stage - b.stage || a.sortOrder - b.sortOrder)
      .map((r) => [r.stage, r.label, r.basis, r.value, r.goalPct, r.accountId]),
    [...stageGoalRows].sort((a, b) => a.stage - b.stage).map((g) => [g.stage, g.goalPct]),
  ]);
}

/**
 * The same signature for the draft being edited — what `serverLinesSignature`
 * will read once this draft is saved. Built from the save payload itself, so
 * whatever a save normalises (a blank label sent as "Untitled", stray spaces,
 * the position within a section becoming `sortOrder`) normalises here too,
 * and a draft compares equal to the server copy it was loaded from or saved
 * as. That equality is what `dirty` is.
 *
 * @param {DraftLine[]} lines
 * @param {DraftStageGoals} [stageGoals]
 */
export function draftLinesSignature(lines, stageGoals = {}) {
  return serverLinesSignature(draftLinesToPayload(lines), draftStageGoalsToPayload(stageGoals));
}

// The API's own limits on a line (packages/schema/src/zod/allocation.js), so a
// draft that breaks one is caught here and marked on its row rather than sent
// and refused — which used to 400 the WHOLE autosave, with nothing on screen
// saying which line was the problem.
const LABEL_MAX = 160;
const VALUE_MAX = 99_999_999;

/** @param {Basis} basis */
function basisNeedsValue(basis) {
  return basis === "pct_of_gross" || basis === "pct_of_remaining" || basis === "fixed_amount" || basis === "sweep";
}

/**
 * Why this line can't be saved yet, or null when it can. Mirrors the API's
 * checks (`basisValueError` and the line schema), worded for the row it is
 * shown under. A line part-way through being typed is the usual case — a new
 * row with no value yet, or "150" on its way to "15" — so these read as
 * "finish this", not as a fault. `field` says which control it is about, so
 * the row can mark that one and not its neighbours.
 *
 * @typedef {{ field: "label" | "basis" | "value" | "goal" | "destination", message: string }} LineProblem
 *
 * @param {DraftLine} line
 * @returns {LineProblem | null}
 */
export function draftLineProblem(line) {
  if (line.label.trim().length > LABEL_MAX) {
    return { field: "label", message: `The name can be at most ${LABEL_MAX} characters.` };
  }
  if (line.accountId === "") return { field: "destination", message: "Choose where this goes." };

  if (basisNeedsValue(line.basis)) {
    const value = textToLineValue(line.basis, line.valueText);
    if (value === null) {
      return {
        field: "value",
        message: line.valueText.trim() === "" ? "Needs a value." : "The value isn't a number.",
      };
    }
    if (value < 0) return { field: "value", message: "The value can't be negative." };
    if ((line.basis === "pct_of_gross" || line.basis === "pct_of_remaining") && value > 100) {
      return { field: "value", message: "A percentage — 100 is the most it can be." };
    }
    if (value > VALUE_MAX) return { field: "value", message: "The value is too large." };
  }

  if (line.goalPctText.trim() !== "") {
    const goal = textToGoalPct(line.goalPctText);
    if (goal === null) return { field: "goal", message: "The goal isn't a number." };
    if (goal < 0 || goal > 100) return { field: "goal", message: "The goal is a percentage — between 0 and 100." };
  }
  return null;
}

/**
 * Every reason the draft can't be saved as it stands: per line, per section
 * goal, and the one rule that spans lines (a second line drawing the same
 * injected total — the API refuses it, because it would deduct that total
 * twice). Empty maps mean the draft can be sent.
 *
 * @param {DraftLine[]} lines
 * @param {DraftStageGoals} stageGoals
 */
export function draftProblems(lines, stageGoals) {
  /** @type {Map<string, LineProblem>} */
  const byLine = new Map();
  for (const line of lines) {
    const problem = draftLineProblem(line);
    if (problem) byLine.set(line.id, problem);
  }
  for (const basis of /** @type {const} */ (["from_fixed_costs", "from_variable_essentials"])) {
    const drawing = lines.filter((l) => l.basis === basis);
    // The first keeps the total; every later one is the duplicate.
    for (const line of drawing.slice(1)) {
      if (!byLine.has(line.id)) {
        byLine.set(line.id, {
          field: "basis",
          message: `Only one line can take the ${basis === "from_fixed_costs" ? "fixed-cost" : "essentials"} total — it's the whole total, not a share.`,
        });
      }
    }
  }

  /** @type {Map<number, string>} */
  const byStage = new Map();
  for (const [stage, text] of Object.entries(stageGoals)) {
    if (text.trim() === "") continue;
    const goal = textToGoalPct(text);
    if (goal === null) byStage.set(Number(stage), "The goal isn't a number.");
    else if (goal < 0 || goal > 100) byStage.set(Number(stage), "The goal is a percentage — between 0 and 100.");
  }

  return { byLine, byStage, count: byLine.size + byStage.size };
}

/**
 * Leading-edge throttle: runs `fn` on the FIRST call of a burst and swallows
 * the rest. That direction matters for undo — the state worth remembering is
 * the one from before the operator started typing, not the one from the last
 * keystroke, which is where a trailing debounce would land.
 *
 * @template {unknown[]} A
 * @param {(...args: A) => void} fn
 * @param {number} ms
 */
function throttleLeading(fn, ms) {
  let last = 0;
  return (/** @type {A} */ ...args) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}

// One undo step per burst of typing rather than one per character: an
// operator dragging a percentage from 8 to 12 pressed two keys, and having to
// press undo twice to get back reads as a bug. A structural edit (adding a
// line, a reorder) inside the same 300ms window rides along in that one step;
// rare enough to be worth the trade.
const HISTORY_THROTTLE_MS = 300;

// 100 steps is deep enough that the operator never hits the end during a real
// editing session, and shallow enough that the whole history stays small.
const HISTORY_LIMIT = 100;

/**
 * The draft being edited, with undo/redo over it. History lives here and
 * nowhere else: undo never round-trips to the server (phases/08-allocation.md
 * "Undo / redo"), it just replays a previous `lines` array. Autosave is a
 * separate concern — the page debounces a PUT off `dirty`.
 *
 * `dirty` is derived, never set: it is "this draft's signature differs from
 * `savedSignature`" (see the subscription below the store). It used to be a
 * flag every edit set and every save cleared, and both halves lost work:
 *
 * - A save clearing it unconditionally dropped whatever was typed while that
 *   save was in flight — the edit was on screen, `dirty` said it wasn't, and
 *   nothing ever sent it.
 * - An undo after a save restored older lines without setting it, so the
 *   draft looked saved, autosave never ran, and Apply promoted the lines the
 *   operator had just undone.
 *
 * Comparing signatures makes both impossible: a save marks saved exactly the
 * signature it SENT, and any state that differs from that — however it came
 * about — is dirty.
 */
export const useAllocationDraft = create(
  temporal(
    /** @returns {{
     *   versionId: string | null,
     *   lines: DraftLine[],
     *   stageGoals: DraftStageGoals,
     *   dirty: boolean,
     *   savedSignature: string | null,
     *   serverSignature: string | null,
     *   load: (versionId: string, rows: (Parameters<typeof serverLineToDraft>[0] & { sortOrder: number })[], stageGoalRows?: { stage: number, goalPct: number }[]) => void,
     *   reset: () => void,
     *   markSaved: (sentSignature: string, serverSignature?: string) => void,
     *   updateLine: (id: string, patch: Partial<DraftLine>) => void,
     *   setStageGoal: (stage: number, text: string) => void,
     *   addLine: (stage: number, accountId: string) => void,
     *   removeLine: (id: string) => void,
     *   moveLine: (id: string, direction: -1 | 1) => void,
     *   moveLineBefore: (id: string, targetId: string) => void,
     *   setLineStage: (id: string, stage: number) => void,
     * }} */
    (set, get) => ({
      versionId: null,
      /** @type {DraftLine[]} */
      lines: [],
      /** @type {DraftStageGoals} */
      stageGoals: {},
      dirty: false,
      // What the server holds for this draft as far as this browser knows:
      // the signature loaded, or the one each save SENT. `dirty` is the draft
      // differing from it. Kept HERE, with `serverSignature` below, not in
      // the page, so both outlive the page: a component ref
      // started over at null on every visit, which made the page re-adopt
      // the cached preview each time — new line ids, so every row remounted
      // — and that cache could be older than this browser's own last
      // autosave (.claude/plans/perf-inp-plan.md, P2 #1).
      /** @type {string | null} */
      savedSignature: null,
      // The same record as the server itself wrote it back, which is what a
      // refetched preview will show. Usually identical to `savedSignature`;
      // it differs only when the database rounds what was sent (a goal of
      // 12.345% is stored as 12.35). The page compares refetches against
      // THIS, so our own rounded save isn't mistaken for the other session's
      // edit and reloaded over the operator's undo history.
      /** @type {string | null} */
      serverSignature: null,

      load: (versionId, rows, stageGoalRows = []) => {
        const signature = serverLinesSignature(rows, stageGoalRows);
        set({
          versionId,
          // In the order the server means them — section, then position — so
          // the editor shows that order and the draft's own signature (which
          // reads position from the array) agrees with the server's.
          lines: [...rows].sort((a, b) => a.stage - b.stage || a.sortOrder - b.sortOrder).map(serverLineToDraft),
          stageGoals: serverStageGoalsToDraft(stageGoalRows),
          dirty: false,
          savedSignature: signature,
          serverSignature: signature,
        });
        useAllocationDraft.temporal.getState().clear();
      },

      reset: () => {
        // Already empty: leave it be. The read-only page calls this on every
        // visit, and a fresh `lines: []` re-rendered everything subscribed
        // to the lines for nothing.
        const state = get();
        if (state.versionId === null && state.lines.length === 0 && !state.dirty && state.savedSignature === null) return;
        set({ versionId: null, lines: [], stageGoals: {}, dirty: false, savedSignature: null, serverSignature: null });
        useAllocationDraft.temporal.getState().clear();
      },

      // `sentSignature` is the draft's signature at the moment the save was
      // SENT, not now: anything typed while it was in flight still differs
      // from it, so the draft stays dirty and the next autosave sends it.
      // Comparing against what was sent — not what came back — is also what
      // stops a rounded value from looking unsaved forever and autosaving in
      // a loop.
      markSaved: (sentSignature, serverSignature = sentSignature) =>
        set({ savedSignature: sentSignature, serverSignature }),

      // Every edit below only changes the lines or the goals; `dirty` follows
      // from them (see the subscription after the store).
      updateLine: (id, patch) =>
        set((state) => ({
          lines: state.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
        })),

      setStageGoal: (stage, text) => set((state) => ({ stageGoals: { ...state.stageGoals, [stage]: text } })),

      addLine: (stage, accountId) =>
        set((state) => {
          // Appended after the last line of its own stage so a new line lands
          // where the operator was looking, not at the end of the plan.
          const lastIndexInStage = state.lines.reduce((last, l, i) => (l.stage === stage ? i : last), -1);
          /** @type {DraftLine} */
          const line = {
            id: nextLineId(),
            stage,
            label: "",
            // Whatever the section it lands in mostly uses — a new row in
            // Leftover is a share of what's left, not a percentage of gross.
            // A starting value in an editable control, never a rule.
            basis: defaultBasisForStage(stage),
            valueText: "",
            goalPctText: "",
            accountId,
          };
          const next = [...state.lines];
          next.splice(lastIndexInStage + 1, 0, line);
          return { lines: next };
        }),

      removeLine: (id) => set((state) => ({ lines: state.lines.filter((line) => line.id !== id) })),

      moveLine: (id, direction) =>
        set((state) => {
          const index = state.lines.findIndex((line) => line.id === id);
          const line = state.lines[index];
          if (index === -1 || !line) return state;
          // Moves within the line's own stage only — crossing a stage
          // boundary is `setLineStage`, an explicit choice, not something a
          // repeated arrow press should do by accident.
          const siblings = state.lines.filter((l) => l.stage === line.stage);
          const positionInStage = siblings.indexOf(line);
          const target = siblings[positionInStage + direction];
          if (!target) return state;
          const targetIndex = state.lines.indexOf(target);
          const next = [...state.lines];
          next[index] = target;
          next[targetIndex] = line;
          return { lines: next };
        }),

      moveLineBefore: (id, targetId) =>
        set((state) => {
          if (id === targetId) return state;
          const from = state.lines.findIndex((line) => line.id === id);
          const line = state.lines[from];
          const target = state.lines.find((l) => l.id === targetId);
          if (!line || !target) return state;
          const without = state.lines.filter((l) => l.id !== id);
          const to = without.indexOf(target);
          // Dropping onto a row in another stage moves the line there too —
          // one gesture, and the row lands exactly where it was dropped.
          const moved = { ...line, stage: target.stage };
          const next = [...without.slice(0, to), moved, ...without.slice(to)];
          return { lines: next };
        }),

      setLineStage: (id, stage) =>
        set((state) => {
          const line = state.lines.find((l) => l.id === id);
          if (!line) return state;
          const without = state.lines.filter((l) => l.id !== id);
          const lastIndexInStage = without.reduce((last, l, i) => (l.stage === stage ? i : last), -1);
          const next = [...without];
          next.splice(lastIndexInStage + 1, 0, { ...line, stage });
          return { lines: next };
        }),

    }),
    {
      // The lines and the section goals are undoable; `dirty`, `versionId`
      // and `savedSignature` are bookkeeping.
      partialize: (state) => ({ lines: state.lines, stageGoals: state.stageGoals }),
      // ...and a set that touches only bookkeeping records nothing. Without
      // this every autosave's `markSaved` pushed a copy of the current lines
      // onto the undo stack and cleared redo: one press of Undo after a save
      // did nothing visible, and the undo counter crept up on its own.
      equality: (past, current) => past.lines === current.lines && past.stageGoals === current.stageGoals,
      limit: HISTORY_LIMIT,
      handleSet: (handleSet) => throttleLeading(handleSet, HISTORY_THROTTLE_MS),
    },
  ),
);

/**
 * Whether the draft differs from what the server was last known to hold.
 *
 * @param {{ versionId: string | null, lines: DraftLine[], stageGoals: DraftStageGoals, savedSignature: string | null }} state
 */
function isDirty(state) {
  if (state.versionId === null || state.savedSignature === null) return false;
  return draftLinesSignature(state.lines, state.stageGoals) !== state.savedSignature;
}

// `dirty`, kept in step with the lines, the goals and the saved signature —
// whatever changed them. A subscription rather than a line in each action,
// because undo and redo don't go through the actions: zundo writes the past
// lines straight into the store, and an undo back past a save is exactly the
// change that has to make the draft dirty again. The `setState` here touches
// only `dirty`, so it records no history and does not re-trigger itself.
useAllocationDraft.subscribe((state, previous) => {
  if (
    state.lines === previous.lines &&
    state.stageGoals === previous.stageGoals &&
    state.savedSignature === previous.savedSignature &&
    state.versionId === previous.versionId
  ) {
    return;
  }
  const dirty = isDirty(state);
  if (dirty !== state.dirty) useAllocationDraft.setState({ dirty });
});

/** The temporal (undo/redo) store behind `useAllocationDraft`. */
export const allocationDraftHistory = useAllocationDraft.temporal;
