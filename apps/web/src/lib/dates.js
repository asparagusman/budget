// UI-only calendar helpers. The pure engine (packages/engine) never calls
// `new Date()` itself — every caller passes `today` in — but a page reading
// "today" to prefill a form field or badge a stale balance is a UI concern,
// not a business calculation, so it's fine here.

/** Today's local calendar date as `YYYY-MM-DD`. */
export function todayIso() {
  return localIsoDate(new Date());
}

/**
 * The local calendar date of an instant, as `YYYY-MM-DD`.
 *
 * For timestamps the API sends as ISO strings (`createdAt`, `activatedAt`):
 * those are UTC, and slicing the first ten characters off one gives the UTC
 * date — which in Sydney is yesterday for anything done before 10 or 11am.
 *
 * @param {Date | string} instant a `Date`, or an ISO timestamp string
 */
export function localIsoDate(instant) {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** @type {Map<string, Intl.DateTimeFormat>} */
const dateFormats = new Map();

/**
 * A shared `Intl.DateTimeFormat` for these options, built once and reused.
 * The ONLY place in the app that constructs one: building a formatter costs
 * ~170µs and calling `.format` on an existing one ~5µs, and pages format
 * dates in loops — every point of a chart's data table, every cell's
 * aria-label — so a fresh one per call cost tens to hundreds of ms per render
 * (.claude/plans/perf-inp-plan.md, P1.1). Enforced by
 * `intl-formatters.test.js`.
 *
 * @param {string} locale
 * @param {Intl.DateTimeFormatOptions} options
 */
export function getDateFormat(locale, options) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    dateFormats.set(key, format);
  }
  return format;
}

/** @param {string} iso `YYYY-MM-DD` @param {string} locale */
export function formatIsoDate(iso, locale) {
  return getDateFormat(locale, { dateStyle: "medium" }).format(new Date(`${iso}T00:00:00`));
}

/** Whole calendar days between `iso` and today (positive when `iso` is in the past).
 *
 * @param {string} iso `YYYY-MM-DD`
 */
export function daysSinceIso(iso) {
  const then = new Date(`${iso}T00:00:00`);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((startOfToday.getTime() - then.getTime()) / 86_400_000);
}

/** A calendar range as one string — "14 – 27 Aug", collapsing the shared
 * month or year the way the locale itself does.
 *
 * @param {string} fromIso `YYYY-MM-DD`
 * @param {string} toIso `YYYY-MM-DD` (inclusive)
 * @param {string} locale
 */
export function formatIsoDateRange(fromIso, toIso, locale) {
  return getDateFormat(locale, { day: "numeric", month: "short" }).formatRange(
    new Date(`${fromIso}T00:00:00`),
    new Date(`${toIso}T00:00:00`),
  );
}

/** "today" / "tomorrow" / "in 5 days" / "3 days ago" — a relative day count
 * put into words. Takes the count rather than computing one, so the caller
 * stays the single place that decides what the date is relative TO (the
 * dashboard reports on `?on=`, not on the wall clock).
 *
 * @param {number} days
 */
export function relativeDayLabel(days) {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}
