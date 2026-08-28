import { toCents } from "@budget/engine";
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
 * The editor's own line shape. `valueText`/`goalPctText` are the raw strings
 * from their inputs, not numbers: the preview recomputes on every keystroke,
 * and a number would make "7." or "" unrepresentable — the field would fight
 * the operator mid-type. They also make undo restore exactly what was typed.
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
 * @param {{ stage: number, label: string, basis: string, value: number | null, goalPct: number | null, accountId: string, sortOrder: number }[]} rows
 */
export function serverLinesSignature(rows) {
  return JSON.stringify(
    [...rows]
      .sort((a, b) => a.stage - b.stage || a.sortOrder - b.sortOrder)
      .map((r) => [r.stage, r.label, r.basis, r.value, r.goalPct, r.accountId]),
  );
}

/**
 * @param {DraftLine[]} lines
 */
export function draftLinesSignature(lines) {
  return JSON.stringify(
    lines.map((l) => [
      l.stage,
      l.label,
      l.basis,
      textToLineValue(l.basis, l.valueText),
      textToGoalPct(l.goalPctText),
      l.accountId,
    ]),
  );
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
 */
export const useAllocationDraft = create(
  temporal(
    /** @returns {{
     *   versionId: string | null,
     *   lines: DraftLine[],
     *   dirty: boolean,
     *   load: (versionId: string, rows: Parameters<typeof serverLineToDraft>[0][]) => void,
     *   reset: () => void,
     *   markSaved: () => void,
     *   updateLine: (id: string, patch: Partial<DraftLine>) => void,
     *   addLine: (stage: number, accountId: string) => void,
     *   removeLine: (id: string) => void,
     *   moveLine: (id: string, direction: -1 | 1) => void,
     *   moveLineBefore: (id: string, targetId: string) => void,
     *   setLineStage: (id: string, stage: number) => void,
     *   addStage: (accountId: string) => void,
     * }} */
    (set, get) => ({
      versionId: null,
      /** @type {DraftLine[]} */
      lines: [],
      dirty: false,

      load: (versionId, rows) => {
        set({ versionId, lines: rows.map(serverLineToDraft), dirty: false });
        useAllocationDraft.temporal.getState().clear();
      },

      reset: () => {
        set({ versionId: null, lines: [], dirty: false });
        useAllocationDraft.temporal.getState().clear();
      },

      markSaved: () => set({ dirty: false }),

      updateLine: (id, patch) =>
        set((state) => ({
          lines: state.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
          dirty: true,
        })),

      addLine: (stage, accountId) =>
        set((state) => {
          /** @type {DraftLine} */
          const line = {
            id: nextLineId(),
            stage,
            label: "",
            basis: "pct_of_gross",
            valueText: "",
            goalPctText: "",
            accountId,
          };
          // Appended after the last line of its own stage so a new line lands
          // where the operator was looking, not at the end of the plan.
          const lastIndexInStage = state.lines.reduce((last, l, i) => (l.stage === stage ? i : last), -1);
          const next = [...state.lines];
          next.splice(lastIndexInStage + 1, 0, line);
          return { lines: next, dirty: true };
        }),

      removeLine: (id) =>
        set((state) => ({ lines: state.lines.filter((line) => line.id !== id), dirty: true })),

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
          return { lines: next, dirty: true };
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
          return { lines: next, dirty: true };
        }),

      setLineStage: (id, stage) =>
        set((state) => {
          const line = state.lines.find((l) => l.id === id);
          if (!line) return state;
          const without = state.lines.filter((l) => l.id !== id);
          const lastIndexInStage = without.reduce((last, l, i) => (l.stage === stage ? i : last), -1);
          const next = [...without];
          next.splice(lastIndexInStage + 1, 0, { ...line, stage });
          return { lines: next, dirty: true };
        }),

      addStage: (accountId) => {
        const highest = get().lines.reduce((max, line) => Math.max(max, line.stage), 0);
        get().addLine(highest + 1, accountId);
      },
    }),
    {
      // Only the lines are undoable. `dirty` and `versionId` are bookkeeping:
      // an undo that also un-dirtied the draft would skip the autosave that
      // has to follow it.
      partialize: (state) => ({ lines: state.lines }),
      limit: HISTORY_LIMIT,
      handleSet: (handleSet) => throttleLeading(handleSet, HISTORY_THROTTLE_MS),
    },
  ),
);

/** The temporal (undo/redo) store behind `useAllocationDraft`. */
export const allocationDraftHistory = useAllocationDraft.temporal;
