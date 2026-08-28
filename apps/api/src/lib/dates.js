// The API layer, unlike packages/engine, is allowed to read the real clock
// (see accounts.js's `archivedAt: new Date()`) — this is the one place a
// route needs "today" as a calendar date rather than a timestamp, for the
// bill-history scaffold's "walk backward from today" (phases/
// 06-fixed-costs.md "the entry scaffold").

/** Today's local calendar date as `YYYY-MM-DD`. */
export function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
