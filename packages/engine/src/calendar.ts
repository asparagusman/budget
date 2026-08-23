import { addDays, addMonths, differenceInCalendarDays, differenceInCalendarMonths } from "date-fns";
import type { Cadence } from "./cadence.js";

/** Calendar date, no timezone, ever. 'YYYY-MM-DD'. A bill due on the 14th is
 * due on the 14th everywhere. */
export type IsoDate = string;

/** Half-open: [from, to). */
export interface DateWindow {
  from: IsoDate;
  to: IsoDate;
}

export interface PaySchedule {
  anchorDate: IsoDate;
  cadence: Cadence;
}

// Internal only: Date is used purely as a calendar-arithmetic scratchpad.
// Every value is constructed and read back through *local* getters/setters
// only — never UTC, never toISOString — so the machine's timezone can never
// leak into a result. As long as construction and reading stay on the same
// side of that line, the actual local offset is irrelevant.
function parseIsoDate(iso: IsoDate): Date {
  const parts = iso.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return new Date(y, m - 1, d);
}

function formatIsoDate(date: Date): IsoDate {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const DAYS_PER_OCCURRENCE: Partial<Record<Cadence, number>> = {
  weekly: 7,
  fortnightly: 14,
};

const MONTHS_PER_OCCURRENCE: Partial<Record<Cadence, number>> = {
  monthly: 1,
  every_2_months: 2,
  quarterly: 3,
  every_6_months: 6,
  yearly: 12,
};

/**
 * Returns the date of the k-th occurrence (k may be negative) counted from
 * the schedule's anchor. Always computed directly from the anchor — never by
 * chaining off the previous occurrence — so a monthly series anchored on the
 * 31st lands on the last day of a shorter month without permanently dragging
 * the anchor day backwards in later months.
 */
function occurrenceDate(anchor: Date, cadence: Cadence, k: number): Date {
  const days = DAYS_PER_OCCURRENCE[cadence];
  if (days !== undefined) return addDays(anchor, k * days);
  const months = MONTHS_PER_OCCURRENCE[cadence];
  return addMonths(anchor, k * (months as number));
}

/** Rough (possibly off-by-a-few) occurrence index nearest `target`, used only
 * as a starting point for the exact walk below. */
function estimateIndex(anchor: Date, cadence: Cadence, target: Date): number {
  const days = DAYS_PER_OCCURRENCE[cadence];
  if (days !== undefined) {
    return Math.floor(differenceInCalendarDays(target, anchor) / days);
  }
  const months = MONTHS_PER_OCCURRENCE[cadence] as number;
  return Math.floor(differenceInCalendarMonths(target, anchor) / months);
}

const MAX_WALK = 1_000_000;

/** Every payday in `window`, ascending, as `[from, to)`. */
export function projectPaydays(schedule: PaySchedule, window: DateWindow): IsoDate[] {
  const anchor = parseIsoDate(schedule.anchorDate);
  const fromDate = parseIsoDate(window.from);
  const toDate = parseIsoDate(window.to);
  const dateAt = (k: number) => occurrenceDate(anchor, schedule.cadence, k);

  // Start a little before the estimate and walk to the true first occurrence
  // on or after `from` — the estimate can be off by one due to month-end
  // clamping, so don't trust it beyond "roughly here".
  let k = estimateIndex(anchor, schedule.cadence, fromDate) - 2;
  let guard = 0;
  while (dateAt(k) < fromDate) {
    k++;
    if (++guard > MAX_WALK) throw new Error("projectPaydays: runaway forward search");
  }
  while (k > 0 && dateAt(k - 1) >= fromDate) {
    k--;
    if (++guard > MAX_WALK) throw new Error("projectPaydays: runaway backward search");
  }

  const results: IsoDate[] = [];
  guard = 0;
  for (let d = dateAt(k); d < toDate; d = dateAt(++k)) {
    results.push(formatIsoDate(d));
    if (++guard > MAX_WALK) throw new Error("projectPaydays: runaway collection");
  }
  return results;
}

export function countPaydays(schedule: PaySchedule, window: DateWindow): number {
  return projectPaydays(schedule, window).length;
}

/** Length of `window` in calendar days (`to - from`, matching the half-open
 * `[from, to)` convention). */
export function windowLengthDays(window: DateWindow): number {
  return differenceInCalendarDays(parseIsoDate(window.to), parseIsoDate(window.from));
}

/** `date` shifted by `days` calendar days (negative moves backward). */
export function addDaysIso(date: IsoDate, days: number): IsoDate {
  return formatIsoDate(addDays(parseIsoDate(date), days));
}

/** Calendar days from `from` to `to` (`to - from`). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return differenceInCalendarDays(parseIsoDate(to), parseIsoDate(from));
}

/** The pay cycle (payday-to-payday window) that `on` falls inside. If `on`
 * lands exactly on a payday, that payday is the cycle start. */
export function resolveCycle(
  primary: PaySchedule,
  on: IsoDate,
): { cycleStart: IsoDate; cycleEnd: IsoDate } {
  const anchor = parseIsoDate(primary.anchorDate);
  const onDate = parseIsoDate(on);
  const dateAt = (k: number) => occurrenceDate(anchor, primary.cadence, k);

  let k = estimateIndex(anchor, primary.cadence, onDate);
  let guard = 0;
  while (dateAt(k) > onDate) {
    k--;
    if (++guard > MAX_WALK) throw new Error("resolveCycle: runaway backward search");
  }
  while (dateAt(k + 1) <= onDate) {
    k++;
    if (++guard > MAX_WALK) throw new Error("resolveCycle: runaway forward search");
  }

  return { cycleStart: formatIsoDate(dateAt(k)), cycleEnd: formatIsoDate(dateAt(k + 1)) };
}

export interface VariantScheduleEntry {
  variantId: string;
  startsOn: IsoDate;
  /** null = open-ended, still in effect. */
  endsOn: IsoDate | null;
}

export interface VariantResolution {
  variantId: string | null;
  diagnostics: Array<
    | { kind: "overlap"; variantIds: string[]; from: IsoDate; to: IsoDate }
    | { kind: "gap"; from: IsoDate; to: IsoDate }
  >;
}

/**
 * Resolves which income variant is in effect on `on`. Never guesses: if more
 * than one entry covers the date, `variantId` is `null` and an `overlap`
 * diagnostic is reported instead of silently picking one; if none covers it,
 * `variantId` is `null` with a `gap` diagnostic. Exactly one covering entry
 * resolves cleanly with no diagnostics.
 *
 * Diagnostic ranges are bounded by the neighbouring entries actually present
 * in `entries`. Where a gap or overlap is open-ended on one side (no
 * neighbouring entry to bound it), that side is reported as `on` itself —
 * this only ever surfaces as an operator-facing warning, never as a value
 * fed back into a calculation, so an unbounded side collapsing to the query
 * date is an acceptable, clearly-flagged approximation.
 */
export function resolveVariant(entries: VariantScheduleEntry[], on: IsoDate): VariantResolution {
  const onDate = parseIsoDate(on);
  const covering = entries.filter((e) => {
    const start = parseIsoDate(e.startsOn);
    if (start > onDate) return false;
    if (e.endsOn === null) return true;
    return onDate < parseIsoDate(e.endsOn);
  });

  if (covering.length === 1) {
    return { variantId: covering[0]!.variantId, diagnostics: [] };
  }

  if (covering.length > 1) {
    const starts = covering.map((e) => parseIsoDate(e.startsOn));
    const from = formatIsoDate(new Date(Math.max(...starts.map((d) => d.getTime()))));
    const boundedEnds = covering.filter((e) => e.endsOn !== null).map((e) => parseIsoDate(e.endsOn as string));
    const to = boundedEnds.length > 0
      ? formatIsoDate(new Date(Math.min(...boundedEnds.map((d) => d.getTime()))))
      : on;
    return {
      variantId: null,
      diagnostics: [{ kind: "overlap", variantIds: covering.map((e) => e.variantId), from, to }],
    };
  }

  // No entry covers `on` — find the nearest bounding neighbours, if any.
  const previousEnds = entries
    .filter((e) => e.endsOn !== null && parseIsoDate(e.endsOn as string) <= onDate)
    .map((e) => parseIsoDate(e.endsOn as string));
  const nextStarts = entries
    .filter((e) => parseIsoDate(e.startsOn) > onDate)
    .map((e) => parseIsoDate(e.startsOn));

  const from = previousEnds.length > 0 ? formatIsoDate(new Date(Math.max(...previousEnds.map((d) => d.getTime())))) : on;
  const to = nextStarts.length > 0 ? formatIsoDate(new Date(Math.min(...nextStarts.map((d) => d.getTime())))) : on;

  return { variantId: null, diagnostics: [{ kind: "gap", from, to }] };
}
