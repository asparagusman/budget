import { getDateFormat } from "@/lib/dates.js";

/** @import { BackupStatus, BackupKind } from "@/lib/backups-api.js" */

const DAY_MS = 24 * 60 * 60 * 1000;

/** @type {Record<BackupKind, string>} */
export const BACKUP_KIND_LABELS = {
  weekly: "Weekly",
  manual: "Manual",
  "before-restore": "Before restore",
  "before-import": "Before import",
};

/**
 * A backup's moment, the way the restore confirmation and the toast name it:
 * "Tue 30 Sep, 3:00am" — what the operator remembers the day by, not an ISO
 * string.
 *
 * @param {string} locale
 * @param {string} iso
 */
export function formatBackupWhen(locale, iso) {
  return getDateFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The status line above the list: how long since the last automatic backup
 * and how long until the next. The weekly schedule is the API's; this only
 * says where it stands.
 *
 * @param {BackupStatus} status
 * @param {Date} now
 */
export function describeBackupStatus(status, now) {
  if (!status.newestAutomaticAt || !status.nextDueAt) {
    return "No automatic backup yet. One is taken as soon as the server is running.";
  }
  const ago = Math.floor((now.getTime() - new Date(status.newestAutomaticAt).getTime()) / DAY_MS);
  const lastText = ago <= 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`;

  const untilNext = (new Date(status.nextDueAt).getTime() - now.getTime()) / DAY_MS;
  const nextText =
    untilNext <= 0
      ? "next is due now"
      : untilNext < 1
        ? "next within a day"
        : `next in about ${Math.round(untilNext)} ${Math.round(untilNext) === 1 ? "day" : "days"}`;

  return `Last automatic backup ${lastText} · ${nextText}`;
}

/**
 * What the restore confirmation says. `what` is the backup as the operator
 * knows it: "the backup from Tue 30 Sep, 3:00am", or for a file they chose,
 * its name.
 *
 * @param {string} what
 */
export function restoreConfirmText(what) {
  return {
    title: `Replace all household data with ${what}?`,
    description:
      "Everything entered since then is replaced. Users and their devices aren't affected. The current state is backed up first, so this can be undone.",
  };
}
