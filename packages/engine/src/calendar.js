import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  differenceInCalendarMonths,
} from "date-fns";
import { OCCURRENCES_PER_YEAR } from "./cadence.js";
import { mustAt } from "./invariant.js";

/** @import { Cadence } from "./cadence.js" */

/** Calendar date, no timezone, ever. 'YYYY-MM-DD'. A bill due on the 14th is
 * due on the 14th everywhere.
 *
 * @typedef {string} IsoDate
 */

/**
 * Half-open: [from, to).
 *
 * @typedef {{ from: IsoDate, to: IsoDate }} DateWindow
 */

/** @typedef {{ anchorDate: IsoDate, cadence: Cadence }} PaySchedule */

// Internal only: Date is used purely as a calendar-arithmetic scratchpad.
// Every value is constructed and read back through *local* getters/setters
// only — never UTC, never toISOString — so the machine's timezone can never
// leak into a result. As long as construction and reading stay on the same
// side of that line, the actual local offset is irrelevant.
/** @param {IsoDate} iso */
function parseIsoDate(iso) {
  const parts = iso.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return new Date(y, m - 1, d);
}

/** @param {Date} date */
function formatIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** @type {Partial<Record<Cadence, number>>} */
const DAYS_PER_OCCURRENCE = {
  weekly: 7,
  fortnightly: 14,
};

/** @type {Partial<Record<Cadence, number>>} */
const MONTHS_PER_OCCURRENCE = {
  monthly: 1,
  every_2_months: 2,
  quarterly: 3,
  every_6_months: 6,
  yearly: 12,
};

/**
 * Months-per-occurrence for a cadence not measured in days. Throws rather
 * than coercing, so a cadence added to the union but missing from both tables
 * fails loudly instead of silently producing NaN dates.
 *
 * @param {Cadence} cadence
 */
function monthsPerOccurrence(cadence) {
  const months = MONTHS_PER_OCCURRENCE[cadence];
  if (months === undefined) {
    throw new Error(`No occurrence interval defined for cadence ${cadence}.`);
  }
  return months;
}

/**
 * Returns the date of the k-th occurrence (k may be negative) counted from
 * the schedule's anchor. Always computed directly from the anchor — never by
 * chaining off the previous occurrence — so a monthly series anchored on the
 * 31st lands on the last day of a shorter month without permanently dragging
 * the anchor day backwards in later months.
 *
 * @param {Date} anchor
 * @param {Cadence} cadence
 * @param {number} k
 */
function occurrenceDate(anchor, cadence, k) {
  const days = DAYS_PER_OCCURRENCE[cadence];
  if (days !== undefined) return addDays(anchor, k * days);
  return addMonths(anchor, k * monthsPerOccurrence(cadence));
}

/** Rough (possibly off-by-a-few) occurrence index nearest `target`, used only
 * as a starting point for the exact walk below.
 *
 * @param {Date} anchor
 * @param {Cadence} cadence
 * @param {Date} target
 */
function estimateIndex(anchor, cadence, target) {
  const days = DAYS_PER_OCCURRENCE[cadence];
  if (days !== undefined) {
    return Math.floor(differenceInCalendarDays(target, anchor) / days);
  }
  return Math.floor(
    differenceInCalendarMonths(target, anchor) / monthsPerOccurrence(cadence),
  );
}

const MAX_WALK = 1_000_000;

/** Every payday in `window`, ascending, as `[from, to)`.
 *
 * @param {PaySchedule} schedule
 * @param {DateWindow} window
 */
export function projectPaydays(schedule, window) {
  const anchor = parseIsoDate(schedule.anchorDate);
  const fromDate = parseIsoDate(window.from);
  const toDate = parseIsoDate(window.to);
  /** @param {number} k */
  const dateAt = (k) => occurrenceDate(anchor, schedule.cadence, k);

  // Start a little before the estimate and walk to the true first occurrence
  // on or after `from` — the estimate can be off by one due to month-end
  // clamping, so don't trust it beyond "roughly here".
  let k = estimateIndex(anchor, schedule.cadence, fromDate) - 2;
  let guard = 0;
  while (dateAt(k) < fromDate) {
    k++;
    if (++guard > MAX_WALK)
      throw new Error("projectPaydays: runaway forward search");
  }
  while (k > 0 && dateAt(k - 1) >= fromDate) {
    k--;
    if (++guard > MAX_WALK)
      throw new Error("projectPaydays: runaway backward search");
  }

  /** @type {IsoDate[]} */
  const results = [];
  guard = 0;
  for (let d = dateAt(k); d < toDate; d = dateAt(++k)) {
    results.push(formatIsoDate(d));
    if (++guard > MAX_WALK)
      throw new Error("projectPaydays: runaway collection");
  }
  return results;
}

/**
 * @param {PaySchedule} schedule
 * @param {DateWindow} window
 */
export function countPaydays(schedule, window) {
  return projectPaydays(schedule, window).length;
}

/** Length of `window` in calendar days (`to - from`, matching the half-open
 * `[from, to)` convention).
 *
 * @param {DateWindow} window
 */
export function windowLengthDays(window) {
  return differenceInCalendarDays(
    parseIsoDate(window.to),
    parseIsoDate(window.from),
  );
}

/** `date` shifted by `days` calendar days (negative moves backward).
 *
 * @param {IsoDate} date
 * @param {number} days
 */
export function addDaysIso(date, days) {
  return formatIsoDate(addDays(parseIsoDate(date), days));
}

/** Calendar days from `from` to `to` (`to - from`).
 *
 * @param {IsoDate} from
 * @param {IsoDate} to
 */
export function daysBetween(from, to) {
  return differenceInCalendarDays(parseIsoDate(to), parseIsoDate(from));
}

/** How many whole periods of `cadence` fit between two dates — 39 fortnights,
 * about 18 months.
 *
 * Exists so a duration is never expressed in a unit nobody used: the source
 * spreadsheet labelled a column of fortnights "Weeks to save" and understated
 * every emergency-fund timeline by half (phases/09-goals-projections.md
 * "/goals"). Callers ask for periods of a named cadence and label the answer
 * with that cadence's own name, so the two can't drift apart.
 *
 * Uses the conventional average period length (365.25 / occurrences per year)
 * rather than walking a real schedule — this answers "how long", not "which
 * dates"; `projectPaydays` is the one that lands on actual days.
 *
 * @param {IsoDate} from
 * @param {IsoDate} to
 * @param {Cadence} cadence
 */
export function periodsBetween(from, to, cadence) {
  const days = daysBetween(from, to);
  return Math.round(days / (365.25 / OCCURRENCES_PER_YEAR[cadence]));
}

/** The pay cycle (payday-to-payday window) that `on` falls inside. If `on`
 * lands exactly on a payday, that payday is the cycle start.
 *
 * @param {PaySchedule} primary
 * @param {IsoDate} on
 */
export function resolveCycle(primary, on) {
  const anchor = parseIsoDate(primary.anchorDate);
  const onDate = parseIsoDate(on);
  /** @param {number} k */
  const dateAt = (k) => occurrenceDate(anchor, primary.cadence, k);

  let k = estimateIndex(anchor, primary.cadence, onDate);
  let guard = 0;
  while (dateAt(k) > onDate) {
    k--;
    if (++guard > MAX_WALK)
      throw new Error("resolveCycle: runaway backward search");
  }
  while (dateAt(k + 1) <= onDate) {
    k++;
    if (++guard > MAX_WALK)
      throw new Error("resolveCycle: runaway forward search");
  }

  return {
    cycleStart: formatIsoDate(dateAt(k)),
    cycleEnd: formatIsoDate(dateAt(k + 1)),
  };
}

/**
 * @typedef {{
 *   variantId: string,
 *   startsOn: IsoDate,
 *   endsOn: IsoDate | null
 * }} VariantScheduleEntry
 *
 * - `endsOn` — null = open-ended, still in effect.
 */

/**
 * @typedef {{ kind: "overlap", variantIds: string[], from: IsoDate, to: IsoDate }
 *   | { kind: "gap", from: IsoDate, to: IsoDate }} VariantDiagnostic
 */

/**
 * @typedef {{
 *   variantId: string | null,
 *   diagnostics: VariantDiagnostic[]
 * }} VariantResolution
 */

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
 *
 * The `@returns` is load-bearing: without it every `kind: "overlap"` literal
 * below widens to `string`, and callers that switch on it (the dashboard's
 * warnings strip) lose the discriminated union.
 *
 * @param {VariantScheduleEntry[]} entries
 * @param {IsoDate} on
 * @returns {VariantResolution}
 */
export function resolveVariant(entries, on) {
  const onDate = parseIsoDate(on);
  const covering = entries.filter((e) => {
    const start = parseIsoDate(e.startsOn);
    if (start > onDate) return false;
    if (e.endsOn === null) return true;
    return onDate < parseIsoDate(e.endsOn);
  });

  if (covering.length === 1) {
    const only = mustAt(covering, 0, "covering variant");
    return { variantId: only.variantId, diagnostics: [] };
  }

  if (covering.length > 1) {
    const starts = covering.map((e) => parseIsoDate(e.startsOn));
    const from = formatIsoDate(
      new Date(Math.max(...starts.map((d) => d.getTime()))),
    );
    // TS 5.5+ infers a type predicate for this filter, so the following map
    // sees IsoDate rather than IsoDate | null — no assertion needed.
    const boundedEnds = covering
      .map((e) => e.endsOn)
      .filter((endsOn) => endsOn !== null)
      .map((endsOn) => parseIsoDate(endsOn));
    const to =
      boundedEnds.length > 0
        ? formatIsoDate(
            new Date(Math.min(...boundedEnds.map((d) => d.getTime()))),
          )
        : on;
    return {
      variantId: null,
      diagnostics: [
        {
          kind: "overlap",
          variantIds: covering.map((e) => e.variantId),
          from,
          to,
        },
      ],
    };
  }

  // No entry covers `on` — find the nearest bounding neighbours, if any.
  const previousEnds = entries
    .map((e) => e.endsOn)
    .filter((endsOn) => endsOn !== null)
    .map((endsOn) => parseIsoDate(endsOn))
    .filter((d) => d <= onDate);
  const nextStarts = entries
    .map((e) => parseIsoDate(e.startsOn))
    .filter((d) => d > onDate);

  const from =
    previousEnds.length > 0
      ? formatIsoDate(
          new Date(Math.max(...previousEnds.map((d) => d.getTime()))),
        )
      : on;
  const to =
    nextStarts.length > 0
      ? formatIsoDate(new Date(Math.min(...nextStarts.map((d) => d.getTime()))))
      : on;

  return { variantId: null, diagnostics: [{ kind: "gap", from, to }] };
}
