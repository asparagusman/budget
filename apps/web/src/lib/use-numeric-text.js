import { useCallback } from "react";

/**
 * A number field that behaves like a spreadsheet cell instead of like the
 * browser's own number-typed input (the one with a spinner).
 *
 * That input looked like the honest choice and is wrong for every field in a
 * figures grid. It is also banned outright: lib/no-number-input.test.js fails
 * on it anywhere in src/, so a new field reaches for `MoneyInput`,
 * `PercentInput` or `IntegerInput` (components/money-input.jsx), which are
 * this hook with the unit and the number handling attached.
 *
 * - **Its stepper is a 13x8px half-arrow inside the text area.** In the
 *   allocation editor the field is 50px of content box, so a quarter of it is
 *   spent on a control that is, in practice, un-hittable — five pixel-precise
 *   clicks along the arrows moved nothing. It reads as a broken button on
 *   every row.
 * - **`step="0.01"` made it pointless even when hit**: one press of the up
 *   arrow on a percentage moves it a hundredth of a percent, which is
 *   invisible in the figure and invisible in the totals.
 * - **The wheel edits it.** Hovering a focused field and scrolling the page
 *   silently turned 12.5 into 12.49. Scrolling a plan is how you read it, so
 *   the browser's own affordance corrupts the numbers being read.
 * - **Its value is a number, so partial input does not exist.** `DraftLine`
 *   deliberately holds `valueText`/`goalPctText` as raw strings so "7." is
 *   representable mid-type, and the widget underneath threw exactly that away:
 *   an invalid intermediate reports `""`.
 * - **No caret.** `selectionStart` is always `null`, so nothing can place or
 *   read a cursor — a click into the digits cannot be relied on to select
 *   them.
 *
 * So: a text input with a decimal keypad, a keystroke filter, and stepping on
 * the arrow keys with steps sized to what the field actually means (Shift for
 * x10, Alt for a tenth). Digits are the operator's to type; the value stays a
 * string all the way to `textToLineValue`.
 *
 * @param {{
 *   value: string,
 *   onChange: (next: string) => void,
 *   step?: number,
 *   min?: number,
 *   max?: number,
 * }} params
 */
export function useNumericText({ value, onChange, step = 1, min, max }) {
  const pattern = min === undefined || min < 0 ? SIGNED : UNSIGNED;

  const handleChange = useCallback(
    /** @param {import("react").ChangeEvent<HTMLInputElement>} e */
    (e) => {
      // A pasted figure arrives as "$1,234.50" as often as "1234.5"; the
      // separators are how it was copied, not what was meant.
      const next = e.target.value.replace(/[$,\s]/g, "");
      if (!pattern.test(next)) {
        // A controlled input only resets itself when a render follows, and a
        // rejected keystroke changes no state — so the character would stick
        // in the DOM with the state behind it. Put the field back by hand.
        e.target.value = value;
        return;
      }
      onChange(next);
    },
    [onChange, pattern, value],
  );

  const handleKeyDown = useCallback(
    /** @param {import("react").KeyboardEvent<HTMLInputElement>} e */
    (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const delta = (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
      const base = Number(value.trim());
      const from = value.trim() === "" || Number.isNaN(base) ? 0 : base;
      const places = Math.min(4, Math.max(decimalsOf(delta), decimalsOf(from)));
      let next = Number((from + delta).toFixed(places));
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
      onChange(String(next));
    },
    [max, min, onChange, step, value],
  );

  const handleBlur = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed === "") {
      if (value !== "") onChange("");
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed)) return;
    let settled = parsed;
    if (min !== undefined) settled = Math.max(min, settled);
    if (max !== undefined) settled = Math.min(max, settled);
    // A figure outside the field's range is a typo every time, and "7." is
    // fine to type but odd to leave sitting in the column. Anything else is
    // left exactly as typed — rewriting "48.50" to "48.5" the moment the
    // field loses focus is the field arguing with the operator over nothing.
    if (settled !== parsed) onChange(String(settled));
    else if (trimmed.endsWith(".")) onChange(trimmed.slice(0, -1));
    else if (trimmed !== value) onChange(trimmed);
  }, [max, min, onChange, value]);

  return {
    type: /** @type {const} */ ("text"),
    inputMode: /** @type {const} */ ("decimal"),
    autoComplete: /** @type {const} */ ("off"),
    spellCheck: false,
    value,
    onChange: handleChange,
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
  };
}

// Two forms of the same rule, hoisted so they are stable identities for the
// change handler's dependency list.
const SIGNED = /^-?\d*(?:\.\d*)?$/;
const UNSIGNED = /^\d*(?:\.\d*)?$/;

/** @param {number} n */
function decimalsOf(n) {
  const [, fraction = ""] = String(n).split(".");
  return fraction.length;
}
