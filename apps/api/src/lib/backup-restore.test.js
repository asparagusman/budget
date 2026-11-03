import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { allocationVersions, auditLog, balanceSnapshots, MIGRATION_JOURNAL, people, sessions, settings, users } from "@budget/schema";
import { eq, sql } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { HOUSEHOLD_IDS as ID, seedHousehold } from "../test/household.js";
import { BackupError, decodeBackup, restoreBackup } from "./backup-restore.js";
import { BACKED_UP_TABLES, BACKUP_STATUS_KEY, createBackup, listBackups, readBackupFile } from "./backup.js";

/** @import { Db } from "@budget/schema" */
/** @import { BackupFile } from "./backup-restore.js" */

const NOW = new Date("2026-11-02T03:00:00.000Z");

/** @type {Db} */
let db;
/** @type {() => Promise<void>} */
let close;
/** @type {string} */
let dir;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  // One database for the file, emptied and re-seeded per test: a PGlite per
  // test would spend most of the run starting up.
  const names = [...BACKED_UP_TABLES.map((t) => getTableName(t)), "users"].map((n) => `"${n}"`).join(", ");
  await db.execute(sql.raw(`truncate table ${names} cascade`));
  await seedHousehold(db);
  dir = await mkdtemp(path.join(tmpdir(), "budget-restore-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every backed-up table's rows, as drizzle reads them, in a stable order. */
async function snapshot() {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const table of BACKED_UP_TABLES) {
    // The status row is this machine's record of its backups, rewritten by
    // every backup and left alone by every restore.
    const rows = (await db.select().from(table)).filter((row) => row.key !== BACKUP_STATUS_KEY);
    out[getTableName(table)] = rows.map((row) => JSON.stringify(row)).sort();
  }
  return out;
}

/** @returns {Promise<{ bytes: Buffer, file: BackupFile }>} */
async function backUp() {
  const entry = await createBackup(db, { dir, appVersion: "test", kind: "manual", now: NOW });
  const bytes = /** @type {Buffer} */ (await readBackupFile(dir, entry.id));
  return { bytes, file: await decodeBackup(bytes) };
}

/** @param {BackupFile} file */
const pack = (file) => gzipSync(JSON.stringify(file));

/** @param {BackupFile} file @param {string} schemaVersion */
const withSchemaVersion = (file, schemaVersion) => ({ ...file, header: { ...file.header, schemaVersion } });

/** @param {() => Promise<unknown>} run */
async function failure(run) {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error("expected a failure");
}

describe("backup then restore", () => {
  it("gives back identical rows after the data is changed", async () => {
    const before = await snapshot();
    expect(before.people).toHaveLength(2);
    expect(before.bills?.length).toBeGreaterThan(0);
    const { bytes } = await backUp();

    // Change something in every way a restore has to undo: edit, delete, add.
    await db.update(people).set({ name: "Changed" }).where(eq(people.id, ID.ada));
    await db.delete(balanceSnapshots);
    await db.insert(people).values({ name: "Newcomer", sortOrder: 9 });
    await db.update(settings).set({ value: "USD" }).where(eq(settings.key, "currency"));
    expect(await snapshot()).not.toEqual(before);

    const result = await restoreBackup(db, { dir, appVersion: "test", bytes });
    expect(result.restored.takenAt).toBe(NOW.toISOString());
    expect(await snapshot()).toEqual(before);
  });

  it("restores into an empty database, which is what a fresh host is", async () => {
    const before = await snapshot();
    const { bytes } = await backUp();
    await db.execute(
      sql.raw(`truncate table ${BACKED_UP_TABLES.map((t) => `"${getTableName(t)}"`).join(", ")} cascade`),
    );

    await restoreBackup(db, { dir, appVersion: "test", bytes });
    expect(await snapshot()).toEqual(before);
  });

  it("takes a safety backup of the current state first, and that can undo the restore", async () => {
    const { bytes } = await backUp();
    await db.update(people).set({ name: "Changed" }).where(eq(people.id, ID.ada));
    const changed = await snapshot();

    const { safetyBackup } = await restoreBackup(db, { dir, appVersion: "test", bytes });
    expect(safetyBackup.kind).toBe("before-restore");
    expect((await listBackups(dir)).map((b) => b.kind).sort()).toEqual(["before-restore", "manual"]);

    const undo = /** @type {Buffer} */ (await readBackupFile(dir, safetyBackup.id));
    await restoreBackup(db, { dir, appVersion: "test", bytes: undo });
    expect(await snapshot()).toEqual(changed);
  });

  it("leaves users, their devices, the audit log and the backup status alone", async () => {
    const { bytes } = await backUp();

    const [user] = await db.insert(users).values({ displayName: "Ada", email: "ada@example.com" }).returning();
    await db.insert(sessions).values({
      userId: user?.id ?? "",
      tokenHash: "hash",
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    await db.insert(auditLog).values({ actorId: user?.id ?? null, action: "x.y", entityType: "x", entityId: "1" });
    const status = await db.query.settings.findFirst({ where: eq(settings.key, BACKUP_STATUS_KEY) });
    expect(status).toBeDefined();

    await restoreBackup(db, { dir, appVersion: "test", bytes });

    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(sessions)).toHaveLength(1);
    expect((await db.select().from(auditLog)).map((row) => row.action)).toEqual(["x.y"]);
    // Rewritten by the safety backup taken during the restore, not by the file.
    const after = await db.query.settings.findFirst({ where: eq(settings.key, BACKUP_STATUS_KEY) });
    expect(after?.value).toMatchObject({ kind: "before-restore", ok: true });
  });

  it("nulls an allocation version's author where that user no longer exists", async () => {
    const [user] = await db.insert(users).values({ displayName: "Ada" }).returning();
    await db.update(allocationVersions).set({ createdBy: user?.id ?? null });
    const { bytes, file } = await backUp();
    expect(file.tables.allocation_versions?.every((row) => row.created_by === user?.id)).toBe(true);

    await db.delete(users).where(eq(users.id, user?.id ?? ""));
    // set null on delete already cleared it live; put the backup's value back
    // in play by restoring onto a database where that user is gone.
    await restoreBackup(db, { dir, appVersion: "test", bytes });

    const versions = await db.select().from(allocationVersions);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every((v) => v.createdBy === null)).toBe(true);
  });

  it("keeps the author where that user still exists", async () => {
    const [user] = await db.insert(users).values({ displayName: "Ada" }).returning();
    await db.update(allocationVersions).set({ createdBy: user?.id ?? null });
    const { bytes } = await backUp();
    await db.update(allocationVersions).set({ createdBy: null });

    await restoreBackup(db, { dir, appVersion: "test", bytes });
    expect((await db.select().from(allocationVersions)).every((v) => v.createdBy === user?.id)).toBe(true);
  });
});

describe("a restore that fails", () => {
  it("rolls back completely when an insert fails", async () => {
    const { file } = await backUp();
    const before = await snapshot();

    // The last-but-one table to be filled, so most of the restore has already
    // run when this fails: a bill pointing at a category that doesn't exist.
    const broken = structuredClone(file);
    const bill = broken.tables.bills?.[0];
    expect(bill).toBeDefined();
    if (bill) bill.category_id = "99999999-9999-4999-8999-999999999999";

    const err = await failure(() => restoreBackup(db, { dir, appVersion: "test", bytes: pack(broken) }));
    expect(err).toBeInstanceOf(BackupError);
    expect(/** @type {BackupError} */ (err).code).toBe("restore_failed");
    expect(/** @type {BackupError} */ (err).message).toContain("nothing was changed");
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a file that isn't a backup, before taking a safety backup", async () => {
    const before = await snapshot();
    for (const bytes of [Buffer.from("not gzip"), gzipSync("not json"), gzipSync(JSON.stringify({ header: {} }))]) {
      const err = await failure(() => restoreBackup(db, { dir, appVersion: "test", bytes }));
      expect(/** @type {BackupError} */ (err).code).toBe("invalid_backup");
    }
    expect(await listBackups(dir)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
});

describe("schema versions", () => {
  const first = MIGRATION_JOURNAL[0]?.tag ?? "";

  it("restores a backup from the same schema", async () => {
    const { file } = await backUp();
    expect(file.header.schemaVersion).toBe(MIGRATION_JOURNAL.at(-1)?.tag);
    await restoreBackup(db, { dir, appVersion: "test", bytes: pack(file) });
  });

  it("refuses a newer schema, untouched and without a safety backup", async () => {
    const { file } = await backUp();
    const before = await snapshot();

    for (const schemaVersion of ["9999_from_the_future", ""]) {
      const err = await failure(() =>
        restoreBackup(db, { dir, appVersion: "test", bytes: pack(withSchemaVersion(file, schemaVersion)) }),
      );
      expect(/** @type {BackupError} */ (err).code).toBe("backup_too_new");
    }
    const newerFormat = { ...file, header: { ...file.header, format: 99 } };
    const err = await failure(() => restoreBackup(db, { dir, appVersion: "test", bytes: pack(newerFormat) }));
    expect(/** @type {BackupError} */ (err).code).toBe("backup_too_new");

    expect((await listBackups(dir)).map((b) => b.kind)).toEqual(["manual"]);
    expect(await snapshot()).toEqual(before);
  });

  it("attempts an older schema, and a column it lacks takes its default", async () => {
    const { file } = await backUp();
    const older = withSchemaVersion(file, first);
    // What an older backup looks like after an additive migration: a column,
    // and a whole table, that it never heard of.
    for (const row of older.tables.allocation_versions ?? []) delete row.note;
    delete older.tables.house_scenarios;
    const before = await snapshot();

    await restoreBackup(db, { dir, appVersion: "test", bytes: pack(older) });
    expect(await snapshot()).toEqual(before);
  });

  it("rolls an older schema back with a clear message when it can't be mapped", async () => {
    const { file } = await backUp();
    const older = withSchemaVersion(file, first);
    // A NOT NULL column with no default that the backup doesn't have.
    for (const row of older.tables.people ?? []) delete row.name;
    const before = await snapshot();

    const err = await failure(() => restoreBackup(db, { dir, appVersion: "test", bytes: pack(older) }));
    expect(/** @type {BackupError} */ (err).code).toBe("restore_failed");
    expect(/** @type {BackupError} */ (err).message).toContain("predates a change that can't be mapped automatically");
    expect(await snapshot()).toEqual(before);
  });
});
