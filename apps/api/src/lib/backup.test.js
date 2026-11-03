import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as schema from "@budget/schema";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { seedHousehold } from "../test/household.js";
import { decodeBackup } from "./backup-restore.js";
import {
  BACKED_UP_TABLES,
  BACKUP_STATUS_KEY,
  backupFileName,
  createBackup,
  deleteBackup,
  EXCLUDED_TABLES,
  exclusively,
  getBackupStatus,
  isBackupDue,
  listBackups,
  parseBackupFileName,
  readBackupFile,
} from "./backup.js";

/** @import { Db } from "@budget/schema" */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-02T03:00:00.000Z");

describe("the table-coverage guard", () => {
  // The plan's requirement: a table added to @budget/schema later can't be
  // silently left out of backups. It has to be named in one list or the other.
  it("has every table the schema exports in either the backed-up or the excluded list", () => {
    const exported = Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map((table) => getTableName(table));
    const accounted = [...BACKED_UP_TABLES, ...EXCLUDED_TABLES].map((table) => getTableName(table));

    expect(exported.filter((name) => !accounted.includes(name))).toEqual([]);
    // And no table is claimed by both, or listed twice.
    expect(new Set(accounted).size).toBe(accounted.length);
  });

  it("never backs up who can sign in", () => {
    const excluded = EXCLUDED_TABLES.map((table) => getTableName(table)).sort();
    expect(excluded).toEqual(["audit_log", "device_requests", "invites", "sessions", "users"]);
  });
});

describe("isBackupDue", () => {
  it("is due when there is no backup at all", () => {
    expect(isBackupDue(null, NOW)).toBe(true);
  });

  it("is not due until the newest is 7 days old", () => {
    expect(isBackupDue(new Date(NOW.getTime() - 6 * DAY_MS), NOW)).toBe(false);
    expect(isBackupDue(new Date(NOW.getTime() - 7 * DAY_MS + 1), NOW)).toBe(false);
    expect(isBackupDue(new Date(NOW.getTime() - 7 * DAY_MS), NOW)).toBe(true);
    // Off for a month: still just due, once.
    expect(isBackupDue(new Date(NOW.getTime() - 30 * DAY_MS), NOW)).toBe(true);
  });
});

describe("backup filenames", () => {
  it("round-trips a kind and a time", () => {
    const name = backupFileName("before-restore", NOW);
    expect(name).toBe("before-restore-20261102T030000000Z.json.gz");
    expect(parseBackupFileName(name)).toEqual({ kind: "before-restore", takenAt: NOW });
  });

  it.each([
    "../weekly-20261102T030000000Z.json.gz",
    "weekly-20261102T030000000Z.json.gz/../x",
    "weekly/../../etc/passwd",
    "weekly-20261102T030000000Z.json.gz.partial",
    "weekly-20261102T030000000Z.json",
    "nightly-20261102T030000000Z.json.gz",
    "..\\weekly-20261102T030000000Z.json.gz",
    "",
  ])("refuses %j", (name) => {
    expect(parseBackupFileName(name)).toBeNull();
  });
});

describe("backups on disk", () => {
  /** @type {Db} */
  let db;
  /** @type {() => Promise<void>} */
  let close;
  /** @type {string} */
  let dir;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedHousehold(db);
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "budget-backups-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * @param {import("./backup.js").BackupKind} kind
   * @param {number} count
   */
  async function take(kind, count) {
    for (let i = 0; i < count; i += 1) {
      await createBackup(db, { dir, appVersion: "test", kind, now: new Date(NOW.getTime() + i * 1000) });
    }
  }

  it("keeps exactly the newest 3 of each pruned kind, independently", async () => {
    await take("weekly", 5);
    await take("before-restore", 4);
    await take("before-import", 3);

    const backups = await listBackups(dir);
    const ofKind = (/** @type {string} */ kind) => backups.filter((b) => b.kind === kind);
    expect(ofKind("weekly")).toHaveLength(3);
    expect(ofKind("before-restore")).toHaveLength(3);
    expect(ofKind("before-import")).toHaveLength(3);

    // The newest survive, newest first.
    expect(ofKind("weekly").map((b) => b.takenAt)).toEqual([
      new Date(NOW.getTime() + 4000).toISOString(),
      new Date(NOW.getTime() + 3000).toISOString(),
      new Date(NOW.getTime() + 2000).toISOString(),
    ]);
  });

  it("never prunes a manual backup", async () => {
    await take("manual", 5);
    expect((await listBackups(dir)).filter((b) => b.kind === "manual")).toHaveLength(5);
  });

  it("leaves no partial file behind, and ignores strangers in the folder", async () => {
    await writeFile(path.join(dir, "notes.txt"), "mine");
    await take("manual", 1);
    expect(await readdir(dir)).toHaveLength(2);
    expect(await listBackups(dir)).toHaveLength(1);
  });

  it("lists nothing, rather than failing, when the folder doesn't exist yet", async () => {
    expect(await listBackups(path.join(dir, "missing"))).toEqual([]);
  });

  it("reads and deletes a backup only by a name it would have written", async () => {
    await take("manual", 1);
    const [entry] = await listBackups(dir);
    expect((await readBackupFile(dir, entry?.id ?? ""))?.byteLength).toBe(entry?.sizeBytes);

    expect(await readBackupFile(dir, "../outside.json.gz")).toBeNull();
    expect(await deleteBackup(dir, "../outside.json.gz")).toBe(false);
    expect(await deleteBackup(dir, backupFileName("manual", new Date(0)))).toBe(false);

    expect(await deleteBackup(dir, entry?.id ?? "")).toBe(true);
    expect(await listBackups(dir)).toEqual([]);
  });

  it("reports the newest automatic backup, and overdue at 8 days", async () => {
    await createBackup(db, { dir, appVersion: "test", kind: "manual", now: new Date(NOW.getTime() - 20 * DAY_MS) });
    expect((await getBackupStatus(db, NOW, dir)).newestAutomaticAt).toBeNull();
    expect((await getBackupStatus(db, NOW, dir)).overdue).toBe(true);

    await createBackup(db, { dir, appVersion: "test", kind: "weekly", now: new Date(NOW.getTime() - 7 * DAY_MS) });
    const status = await getBackupStatus(db, NOW, dir);
    expect(status.newestAutomaticAt).toBe(new Date(NOW.getTime() - 7 * DAY_MS).toISOString());
    expect(status.nextDueAt).toBe(NOW.toISOString());
    expect(status.overdue).toBe(false);
    expect(status.lastAttempt).toMatchObject({ kind: "weekly", ok: true, error: null });

    expect((await getBackupStatus(db, new Date(NOW.getTime() + 1 * DAY_MS), dir)).overdue).toBe(true);
  });

  it("records a failed attempt, with its error, and throws", async () => {
    // A file where the folder should be: mkdir can't succeed.
    const blocked = path.join(dir, "blocked");
    await writeFile(blocked, "");
    await expect(createBackup(db, { dir: blocked, appVersion: "test", kind: "weekly", now: NOW })).rejects.toThrow();

    const status = await getBackupStatus(db, NOW, dir);
    expect(status.lastAttempt?.ok).toBe(false);
    expect(status.lastAttempt?.error).toBeTruthy();
    expect(status.lastAttempt?.kind).toBe("weekly");
  });

  it("keeps its own status row out of the backup", async () => {
    await take("manual", 1);
    const [entry] = await listBackups(dir);
    const backup = await decodeBackup((await readBackupFile(dir, entry?.id ?? "")) ?? Buffer.alloc(0));
    const keys = (backup.tables.settings ?? []).map((row) => row.key);
    expect(keys).not.toContain(BACKUP_STATUS_KEY);
    expect(keys).toContain("currency");
  });

  it("runs exclusive tasks one at a time, and keeps going after one fails", async () => {
    /** @type {string[]} */
    const order = [];
    const slow = exclusively(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("slow");
      throw new Error("boom");
    });
    const fast = exclusively(async () => {
      order.push("fast");
    });
    await expect(slow).rejects.toThrow("boom");
    await fast;
    expect(order).toEqual(["slow", "fast"]);
  });
});
