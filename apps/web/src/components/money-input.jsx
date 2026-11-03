import { useState } from "react";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group.jsx";
import { formatDecimalText, formatMoneyText, parseDecimalText, parseMoneyText } from "@/lib/numeric-text.js";
import { useNumericText } from "@/lib/use-numeric-text.js";
import { cn } from "@/lib/utils.js";

/** @import { Cents } from "@budget/engine" */

// The app's number fields. Every one is a text input with a decimal keypad
// (see lib/use-numeric-text.js for why the browser's number input is not used), and every
// one hands its owner a NUMBER or `null`, never a string:
//
// - `null` is blank, and blank is never silently zero. What an empty field
//   means — keep the stored figure, clear it, refuse the save — is the call
//   site's to make, in the open.
// - The field keeps its own text. "7." and "-" are representable mid-type and
//   are not reported until they are a figure; and a pasted "$1,234.50" is
//   read, not thrown away.
//
// A field is controlled by `value`, and re-reads it whenever it changes to
// something the typing doesn't already say — Discard, a save landing, a
// derived figure filled in — but never while the number it reports is the
// number it was given.

/**
 * @typedef {Omit<
 *   import("react").ComponentProps<"input">,
 *   "value" | "defaultValue" | "onChange" | "type" | "inputMode" | "min" | "max" | "step" | "className" | "prefix"
 * >} InputPassthrough
 *
 * @typedef {"field" | "cell"} NumberDensity `field` is a form control; `cell`
 * is the compact one for a grid, where a row of them has to fit a table.
 */

/**
 * @template {number} T
 * @typedef {{
 *   value: T | null,
 *   onChange: (next: T | null) => void,
 *   density?: NumberDensity,
 *   step?: number,
 *   className?: string,
 *   inputClassName?: string,
 * }} NumberFieldProps
 */

/**
 * The shared base: the field's text, the rules that turn it into a number and
 * back, and the input props to spread.
 *
 * @param {{
 *   value: number | null,
 *   onChange: (next: number | null) => void,
 *   parse: (text: string) => number | null,
 *   format: (n: number | null) => string,
 *   step: number,
 *   min?: number,
 *   max?: number,
 *   integer?: boolean,
 *   onBlur?: import("react").FocusEventHandler<HTMLInputElement>,
 *   onKeyDown?: import("react").KeyboardEventHandler<HTMLInputElement>,
 * }} params
 */
function useNumberField({ value, onChange, parse, format, step, min, max, integer = false, onBlur, onKeyDown }) {
  const [text, setText] = useState(() => format(value));
  const [seen, setSeen] = useState(value);

  // The prop moved. If the typing already reads as the new value it is our own
  // report coming back and the text stays exactly as typed ("12.50"); if not,
  // someone else changed it and the field shows it.
  if (value !== seen) {
    setSeen(value);
    if (parse(text) !== value) setText(format(value));
  }

  /** @param {string} next */
  function handleText(next) {
    setText(next);
    const parsed = parse(next);
    if (parsed !== value) onChange(parsed);
  }

  const numeric = useNumericText({ value: text, onChange: handleText, step, min, max });

  // Leaving the field tidies what it shows: a lone "-" or "." is cleared, a
  // figure outside the range is pulled into it, one with more places than the
  // field holds is rounded to what it will actually save, and "7." loses its
  // point. Anything else stays as typed — "48.50" is left alone.
  function settle() {
    if (parse(text) === null) {
      if (text !== "") setText("");
      return;
    }
    // In the units the operator typed (dollars, not cents) — `min` and `max`
    // are the field's own, the same ones the arrow keys stop at.
    const typed = Number(text.replace(/[$,\s]/g, ""));
    let inRange = typed;
    if (min !== undefined) inRange = Math.max(min, inRange);
    if (max !== undefined) inRange = Math.min(max, inRange);
    const settled = parse(String(inRange));
    if (settled === null) return;
    if (inRange !== typed || Number(format(settled)) !== typed) {
      setText(format(settled));
      if (settled !== value) onChange(settled);
    } else if (text.endsWith(".")) {
      setText(text.slice(0, -1));
    }
  }

  return {
    ...numeric,
    /** @param {import("react").ChangeEvent<HTMLInputElement>} e */
    onChange(e) {
      // A whole-number field has no use for a point, typed or pasted.
      if (integer && e.target.value.includes(".")) {
        e.target.value = text;
        return;
      }
      numeric.onChange(e);
    },
    /** @param {import("react").KeyboardEvent<HTMLInputElement>} e */
    onKeyDown(e) {
      onKeyDown?.(e);
      if (!e.defaultPrevented) numeric.onKeyDown(e);
    },
    /** @param {import("react").FocusEvent<HTMLInputElement>} e */
    onBlur(e) {
      settle();
      onBlur?.(e);
    },
  };
}

/**
 * The group, the optional unit on either side, and the input. `cell` density
 * is the same control with its padding and unit tightened for a grid.
 *
 * @param {InputPassthrough & {
 *   field: ReturnType<typeof useNumberField>,
 *   density: NumberDensity,
 *   leading?: string,
 *   trailing?: string,
 *   className?: string,
 *   inputClassName?: string,
 * }} props
 */
function NumberField({ field, density, leading, trailing, className, inputClassName, ...rest }) {
  const cell = density === "cell";
  return (
    <InputGroup className={className}>
      {leading ? (
        <InputGroupAddon className={cell ? "pl-1.5" : undefined}>
          <InputGroupText className={cell ? "text-xs" : undefined}>{leading}</InputGroupText>
        </InputGroupAddon>
      ) : null}
      <InputGroupInput
        {...rest}
        {...field}
        className={cn("text-right tabular-nums", cell && "px-1.5 text-sm", inputClassName)}
      />
      {trailing ? (
        <InputGroupAddon align="inline-end" className={cell ? "pr-1.5" : undefined}>
          <InputGroupText className={cell ? "text-xs" : undefined}>{trailing}</InputGroupText>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

/**
 * A dollar amount, held as whole cents. `$` sits inside the field; digits are
 * right-aligned and tabular. Pastes "$1,234.50", has no spinner and ignores
 * the wheel, and refuses a minus sign unless `allowNegative` (a balance can be
 * overdrawn; a bill cannot be). Arrow keys step by `step` dollars.
 *
 * @param {InputPassthrough & NumberFieldProps<Cents> & { allowNegative?: boolean }} props
 */
export function MoneyInput({
  value,
  onChange,
  allowNegative = false,
  density = "field",
  step = 1,
  className,
  inputClassName,
  onBlur,
  onKeyDown,
  ...rest
}) {
  const field = useNumberField({
    value,
    onChange,
    parse: (text) => parseMoneyText(text, { allowNegative }),
    format: (n) => formatMoneyText(n),
    step,
    min: allowNegative ? undefined : 0,
    onBlur,
    onKeyDown,
  });
  return <NumberField {...rest} field={field} density={density} leading="$" className={className} inputClassName={inputClassName} />;
}

/**
 * A plain number to a fixed number of decimal places — the field `PercentInput`
 * and `IntegerInput` are made from, and the one to use for a multiplier or a
 * count of months. What it shows is rounded to `decimals`, so a value that
 * arrived as 7.000000000000001 reads "7", and what it reports is the rounded
 * figure too.
 *
 * @param {InputPassthrough & NumberFieldProps<number> & {
 *   decimals?: number,
 *   min?: number,
 *   max?: number,
 *   allowNegative?: boolean,
 *   unit?: string,
 * }} props
 */
export function NumberInput({
  value,
  onChange,
  decimals = 2,
  min,
  max,
  allowNegative = false,
  unit,
  density = "field",
  step = 1,
  className,
  inputClassName,
  onBlur,
  onKeyDown,
  ...rest
}) {
  const field = useNumberField({
    value,
    onChange,
    parse: (text) => parseDecimalText(text, decimals, { allowNegative }),
    format: (n) => formatDecimalText(n, decimals),
    step,
    min: min ?? (allowNegative ? undefined : 0),
    max,
    integer: decimals === 0,
    onBlur,
    onKeyDown,
  });
  return <NumberField {...rest} field={field} density={density} trailing={unit} className={className} inputClassName={inputClassName} />;
}

/**
 * A percentage, as the number the operator reads — 7 for 7%. Convert at the
 * edge (`/ 100`) where the stored figure is a fraction. `unit` is the text
 * after the figure.
 *
 * @param {Omit<Parameters<typeof NumberInput>[0], "decimals" | "unit"> & { decimals?: number, unit?: string }} props
 */
export function PercentInput({ unit = "%", step = 0.1, ...props }) {
  return <NumberInput {...props} unit={unit} step={step} />;
}

/**
 * A whole number — a count of periods or of months. A point is refused,
 * typed or pasted.
 *
 * @param {Omit<Parameters<typeof NumberInput>[0], "decimals">} props
 */
export function IntegerInput(props) {
  return <NumberInput {...props} decimals={0} />;
}
