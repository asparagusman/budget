import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MoneyInput } from "@/components/money-input.jsx";
import { Money } from "@/components/money.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { cn } from "@/lib/utils.js";

/** @import { Cents } from "@budget/engine" */

// Click-to-edit for a single field that is already on screen, so changing a
// name or an amount doesn't mean opening a dialog that repeats the whole
// record around it.
//
// At rest the value is plain text in the page's own type, with a dashed
// underline on hover. Clicked, it becomes a field in the same type with a
// solid one — the same underline every form field in the app uses — so the
// text doesn't move. Enter or leaving the field saves; Escape puts it back.
// A save that fails says why in a toast and the old value returns.
//
// Each field saves on its own, through the caller's `onSave`, which should
// PATCH just that one key and resolve once the fresh data is in (see the
// income page's mutations) — until then the field shows what was typed.

/**
 * Put on a row or card whose empty fields should stay out of the way: they
 * appear when the pointer is over it (or when focused), not before. On a
 * touch screen there is no hover, so they always show.
 */
export const EDITABLE_GROUP = "group/editable";

const AT_REST =
  "cursor-text border-b border-dashed border-transparent text-left outline-none transition-colors hover:border-text-subtle focus-visible:border-solid focus-visible:border-ring";
const HIDDEN_WHEN_EMPTY = "[@media(hover:hover)]:opacity-0 group-hover/editable:opacity-100 focus-visible:opacity-100";
const EDITING = "border-0 border-b border-ring bg-transparent p-0 outline-none";

/**
 * The editing state and the save, shared by every inline field.
 *
 * @template T
 * @param {(next: T) => Promise<unknown>} onSave
 */
function useInlineSave(onSave) {
  const [editing, setEditing] = useState(false);
  // What was typed, shown while the save is in flight.
  const [pending, setPending] = useState(/** @type {{ value: T } | null} */ (null));
  const display = useRef(/** @type {HTMLButtonElement | null} */ (null));
  // Enter, then the blur from the field unmounting, must not save twice;
  // Escape, then that blur, must not save at all.
  const settled = useRef(false);
  const refocus = useRef(false);

  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      display.current?.focus();
    }
  }, [editing]);

  function start() {
    settled.current = false;
    setEditing(true);
  }

  /** @param {{ keyboard?: boolean }} [how] */
  function cancel({ keyboard = false } = {}) {
    if (settled.current) return;
    settled.current = true;
    refocus.current = keyboard;
    setEditing(false);
  }

  /** @param {T} next @param {{ keyboard?: boolean }} [how] */
  async function save(next, { keyboard = false } = {}) {
    if (settled.current) return;
    settled.current = true;
    refocus.current = keyboard;
    setEditing(false);
    setPending({ value: next });
    try {
      await onSave(next);
    } catch (err) {
      toast.error(/** @type {Error} */ (err).message);
    } finally {
      setPending(null);
    }
  }

  return { editing, pending, display, start, cancel, save };
}

/**
 * A line of text — or a short paragraph, with `multiline` — edited where it
 * sits. Saves the trimmed text, or `null` when it is cleared; a `required`
 * field can't be cleared, and emptying one just puts the old value back.
 *
 * @param {{
 *   value: string | null,
 *   onSave: (next: string | null) => Promise<unknown>,
 *   label: string,
 *   placeholder?: string,
 *   required?: boolean,
 *   multiline?: boolean,
 *   maxLength?: number,
 *   className?: string,
 * }} props `label` names the field for a screen reader ("Variant name").
 *   `className` styles the text both at rest and while editing.
 */
export function InlineText({ value, onSave, label, placeholder = "Add…", required = false, multiline = false, maxLength, className }) {
  const field = useInlineSave(onSave);
  const [draft, setDraft] = useState("");
  const current = value ?? "";
  const shown = field.pending ? (field.pending.value ?? "") : current;

  function begin() {
    setDraft(current);
    field.start();
  }

  /** @param {{ keyboard?: boolean }} [how] */
  function finish(how) {
    const next = draft.trim();
    if (next === current.trim() || (required && !next)) field.cancel(how);
    else field.save(next || null, how);
  }

  /** @param {import("react").KeyboardEvent} e */
  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      field.cancel({ keyboard: true });
    } else if (e.key === "Enter" && !(multiline && e.shiftKey)) {
      e.preventDefault();
      finish({ keyboard: true });
    }
  }

  if (field.editing) {
    const shared = {
      "aria-label": label,
      value: draft,
      maxLength,
      autoFocus: true,
      onFocus: (/** @type {import("react").FocusEvent<HTMLInputElement | HTMLTextAreaElement>} */ e) => e.currentTarget.select(),
      onChange: (/** @type {import("react").ChangeEvent<HTMLInputElement | HTMLTextAreaElement>} */ e) => setDraft(e.target.value),
      onKeyDown,
      onBlur: () => finish(),
      className: cn(EDITING, "w-full min-w-0", multiline && "field-sizing-content resize-none", className),
    };
    return multiline ? <textarea rows={1} {...shared} /> : <input type="text" {...shared} />;
  }

  return (
    <button
      ref={field.display}
      type="button"
      onClick={begin}
      className={cn(
        AT_REST,
        "max-w-full",
        multiline ? "whitespace-pre-line" : "truncate",
        !shown && "text-text-subtle",
        !shown && !required && HIDDEN_WHEN_EMPTY,
        field.pending && "opacity-60",
        className,
      )}
    >
      <span className="sr-only">Edit {label}: </span>
      {shown || placeholder}
    </button>
  );
}

/**
 * A dollar amount edited where it sits. Always has a figure: clearing the
 * field puts the old one back.
 *
 * @param {{
 *   value: Cents,
 *   onSave: (next: Cents) => Promise<unknown>,
 *   label: string,
 *   allowNegative?: boolean,
 *   className?: string,
 * }} props
 */
export function InlineMoney({ value, onSave, label, allowNegative = false, className }) {
  const field = useInlineSave(onSave);
  // A ref as well as state: leaving the field tidies its figure (rounding,
  // clamping) through `onChange` in the same event as the blur that saves,
  // before a re-render could hand `finish` the new state.
  const draft = useRef(/** @type {Cents | null} */ (value));
  const [shownDraft, setShownDraft] = useState(/** @type {Cents | null} */ (value));

  function begin() {
    draft.current = value;
    setShownDraft(value);
    field.start();
  }

  /** @param {{ keyboard?: boolean }} [how] */
  function finish(how) {
    const next = draft.current;
    if (next === null || next === value) field.cancel(how);
    else field.save(next, how);
  }

  if (field.editing) {
    return (
      <MoneyInput
        aria-label={label}
        density="cell"
        autoFocus
        allowNegative={allowNegative}
        value={shownDraft}
        onChange={(next) => {
          draft.current = next;
          setShownDraft(next);
        }}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            field.cancel({ keyboard: true });
          } else if (e.key === "Enter") {
            e.preventDefault();
            finish({ keyboard: true });
          }
        }}
        onBlur={() => finish()}
        className={cn("h-7 min-h-0 w-28 border-ring", className)}
        inputClassName="min-h-0"
      />
    );
  }

  return (
    <button
      ref={field.display}
      type="button"
      onClick={begin}
      className={cn(AT_REST, "tabular-nums", field.pending && "opacity-60", className)}
    >
      <span className="sr-only">Edit {label}: </span>
      <Money value={field.pending ? field.pending.value : value} />
    </button>
  );
}

/**
 * One of a short list, chosen where it sits: the value reads as text with a
 * small chevron, and picking from the list saves straight away.
 *
 * @template {string} V
 * @param {{
 *   value: V,
 *   options: { value: V, label: string }[],
 *   onSave: (next: V) => Promise<unknown>,
 *   label: string,
 *   className?: string,
 * }} props
 */
export function InlineSelect({ value, options, onSave, label, className }) {
  const field = useInlineSave(onSave);
  const shown = field.pending ? field.pending.value : value;

  return (
    <Select
      value={shown}
      onValueChange={(next) => {
        if (next === value) return;
        field.start();
        field.save(/** @type {V} */ (next));
      }}
    >
      <SelectTrigger
        aria-label={label}
        className={cn(
          // Text, not a control: no height of its own, no padding, the
          // underline only on hover — the same at-rest look as InlineText.
          "h-auto min-h-0 gap-0.5 border-dashed border-transparent p-0 text-[length:inherit] data-[size=default]:h-auto data-[state=open]:border-solid data-[state=open]:shadow-none focus-visible:border-solid focus-visible:shadow-none [&>svg]:size-3 [&>svg]:opacity-60",
          field.pending && "opacity-60",
          className,
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
