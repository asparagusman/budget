import { useRef, useState } from "react";
import { CalendarIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { Calendar } from "@/components/ui/calendar.jsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.jsx";
import { cn } from "@/lib/utils.js";
import { formatIsoDate } from "@/lib/dates.js";
import { useSettings } from "@/lib/settings.jsx";

/**
 * The app's one date field. Every screen that used to render a native
 * `<input type="date">` renders this instead: the OS widget is drawn by the
 * OS, in the OS's date order, with the OS's own chrome, which is exactly why
 * it read as foreign next to the rest of the controls (`[General 10]`).
 *
 * The value on the wire is always `YYYY-MM-DD` — the same string every call
 * site already stores and posts — while what's on screen is that date in the
 * operator's configured locale, matching how dates read everywhere else in
 * the app.
 *
 * Deliberately not typeable. A free-text date field has to guess whether
 * "03/04" is March or April, and this app's whole point is not presenting a
 * guess as a fact; the calendar itself is fully keyboard-driven (arrows by
 * day, PageUp/PageDown by month, Home/End, Enter to pick), so nothing is
 * lost to someone who never touches the mouse.
 *
 * `ariaLabel` is for the places this sits in a table cell, where the column
 * heading is the only label and there is no `<FieldRow>` to carry one.
 *
 * @param {{
 *   id?: string,
 *   value: string,
 *   onChange: (iso: string) => void,
 *   placeholder?: string,
 *   ariaLabel?: string,
 *   clearable?: boolean,
 *   disabled?: boolean,
 *   className?: string,
 * }} props
 */
export function DatePicker({
  id,
  value,
  onChange,
  placeholder = "Pick a date",
  ariaLabel,
  clearable = false,
  disabled = false,
  className,
}) {
  const { locale } = useSettings();
  const [open, setOpen] = useState(false);
  const calendarRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const selected = isoToDate(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("relative flex w-full items-center", className)}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            aria-label={ariaLabel}
            disabled={disabled}
            data-empty={selected === null ? "" : undefined}
            className={cn(
              // Sized and underlined as an Input, not as a button: it sits
              // in the same FieldRow column as the text fields beside it and
              // a control that looks different is the drift this component
              // exists to remove.
              "h-8 w-full justify-start rounded-none border-0 border-b border-input bg-transparent px-0.5 font-normal hover:border-text-subtle hover:bg-transparent focus-visible:border-ring focus-visible:shadow-[0_1px_0_0_var(--color-ring)] focus-visible:ring-0 aria-expanded:border-ring aria-expanded:bg-transparent data-empty:text-muted-foreground dark:border-input dark:bg-transparent dark:hover:bg-transparent",
              clearable && selected !== null && "pr-8",
            )}
          >
            <CalendarIcon className="size-4 shrink-0 opacity-60" aria-hidden="true" />
            {selected ? formatIsoDate(value, locale) : placeholder}
          </Button>
        </PopoverTrigger>
        {clearable && selected !== null && !disabled ? (
          <button
            type="button"
            aria-label="Clear date"
            className="absolute right-1 grid size-6 place-items-center rounded-(--radius-control) text-text-subtle hover:text-text"
            onClick={() => onChange("")}
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <PopoverContent
        className="w-auto p-0"
        align="start"
        // Radix focuses a popover's first focusable child on open, which here
        // is the previous-month chevron — so the grid opens with the arrow
        // keys paging months instead of walking days. react-day-picker's own
        // `autoFocus` doesn't win that race either (it marks a focused day,
        // and the day button focuses itself on mount, before Radix runs). So
        // take it over: land on the selected day, or the first day drawn.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          // A frame later, not inline: Radix dispatches this while the
          // content is still mounting, so the ref is not populated yet and
          // there is nothing to query.
          requestAnimationFrame(() => {
            const content = calendarRef.current;
            // `button[...]`, not `[...]`: react-day-picker puts `data-day` on
            // the grid CELL as well as on the button inside it, and focusing
            // a `<td>` is a silent no-op.
            const day =
              content?.querySelector('button[data-selected-single="true"]') ??
              content?.querySelector("[data-today] button[data-day]") ??
              content?.querySelector("button[data-day]");
            if (day instanceof HTMLElement) day.focus();
          });
        }}
      >
        <div ref={calendarRef}>
          <Calendar
            mode="single"
            autoFocus
            captionLayout="dropdown"
            startMonth={new Date(1970, 0)}
            endMonth={new Date(2100, 11)}
            defaultMonth={selected ?? undefined}
            selected={selected ?? undefined}
            onSelect={(/** @type {Date | undefined} */ date) => {
              if (!date) return;
              onChange(dateToIso(date));
              setOpen(false);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * `YYYY-MM-DD` to a Date at local midnight. Built from the parts rather than
 * `new Date(iso)`, which parses a bare date string as UTC and lands on the
 * previous day for anyone west of Greenwich.
 *
 * @param {string} iso
 * @returns {Date | null}
 */
function isoToDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The inverse, read off the local calendar parts for the same reason —
 * `toISOString()` would convert to UTC first and shift the date.
 *
 * @param {Date} date
 */
function dateToIso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
