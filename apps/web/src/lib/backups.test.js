import { describe, expect, it } from "vitest";
import { describeBackupStatus, formatBytes, restoreConfirmText } from "./backups.js";

/** @import { BackupStatus } from "./backups-api.js" */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-02T03:00:00.000Z");

/** @param {number} daysAgo @returns {BackupStatus} */
function weeklyTakenDaysAgo(daysAgo) {
  const at = new Date(NOW.getTime() - daysAgo * DAY_MS);
  return {
    newestAutomaticAt: at.toISOString(),
    nextDueAt: new Date(at.getTime() + 7 * DAY_MS).toISOString(),
    lastAttempt: null,
    overdue: false,
  };
}

describe("describeBackupStatus", () => {
  it("says how long ago and how long until the next", () => {
    expect(describeBackupStatus(weeklyTakenDaysAgo(3), NOW)).toBe(
      "Last automatic backup 3 days ago · next in about 4 days",
    );
  });

  it("reads naturally at the edges", () => {
    expect(describeBackupStatus(weeklyTakenDaysAgo(0), NOW)).toContain("today");
    expect(describeBackupStatus(weeklyTakenDaysAgo(1), NOW)).toContain("yesterday");
    expect(describeBackupStatus(weeklyTakenDaysAgo(6.5), NOW)).toContain("next within a day");
    expect(describeBackupStatus(weeklyTakenDaysAgo(7), NOW)).toContain("next is due now");
    // Off for a month: overdue, not "next in about -23 days".
    expect(describeBackupStatus(weeklyTakenDaysAgo(30), NOW)).toBe(
      "Last automatic backup 30 days ago · next is due now",
    );
  });

  it("says so when there has never been one", () => {
    const status = { newestAutomaticAt: null, nextDueAt: null, lastAttempt: null, overdue: true };
    expect(describeBackupStatus(status, NOW)).toContain("No automatic backup yet");
  });
});

describe("restoreConfirmText", () => {
  it("names the backup and says what is and isn't replaced", () => {
    const { title, description } = restoreConfirmText("the backup from Tue 30 Sep, 3:00am");
    expect(title).toBe("Replace all household data with the backup from Tue 30 Sep, 3:00am?");
    expect(description).toContain("Everything entered since then is replaced.");
    expect(description).toContain("Users and their devices aren't affected.");
    expect(description).toContain("backed up first, so this can be undone");
  });
});

describe("formatBytes", () => {
  it("rounds to a readable unit", () => {
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(14_336)).toBe("14 KB");
    expect(formatBytes(1_363_148)).toBe("1.3 MB");
  });
});
