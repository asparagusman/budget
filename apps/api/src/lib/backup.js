import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import {
  accounts,
  allocationLines,
  allocationPlans,
  allocationStageGoals,
  allocationVersions,
  auditLog,
  balanceSnapshots,
  billInstances,
  billSeasonalFactors,
  billStepChanges,
  bills,
  costCategories,
  deviceRequests,
  goals,
  houseScenarios,
  incomeLines,
  incomeVariants,
  invites,
  MIGRATION_JOURNAL,
  paySchedules,
  people,
  sessions,
  settings,
  users,
  variableActuals,
  variableBudgets,
  variantSchedule,
} from "@budget/schema";
import { getTableName, sql } from "drizzle-orm";
import { describeError } from "./db-errors.js";

/** @import { Db } from "@budget/schema" */
/** @import { PgTable } from "drizzle-orm/pg-core" */

// In-app backups (.claude/plans/pre-deploy-plan.md, "Phase C").
//
// A backup is one gzipped JSON file in BACKUP_DIR: a header, and one array of
// rows per table. Rows are the database's own column names and its own JSON
// (`to_jsonb`), not drizzle's camelCase objects, so a timestamp, a numeric or
// an enum goes out and comes back through Postgres's own parser instead of
// through a hand-written revive step per column type. See backup-restore.js
// for the way back in.

const gzipAsync = promisify(gzip);

/** Bumped when the file's own layout changes, not when the schema does. */
export const BACKUP_FORMAT = 1;

/**
 * Where a backup came from. The filename carries it, so a listing never has
 * to open a file.
 *
 *   weekly          taken by the scheduler; the newest 3 are kept
 *   manual          "Back up now"; kept until the operator deletes it
 *   before-restore  taken automatically before a restore; the newest 3 are kept
 *   before-import   taken automatically before an import commit; likewise
 */
export const BACKUP_KINDS = /** @type {const} */ (["weekly", "manual", "before-restore", "before-import"]);

/** @typedef {(typeof BACKUP_KINDS)[number]} BackupKind */

// Count-based, not "delete after 21 days": a box that was off for a month must
// never wipe its last good backups just because time passed.
const KEEP_PER_KIND = 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const OVERDUE_MS = 8 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Every table a backup carries, in the order rows can be inserted: parents
 * before the tables that reference them. Restore replaces all of these and
 * nothing else.
 *
 * @type {PgTable[]}
 */
export const BACKED_UP_TABLES = [
  settings,
  people,
  accounts,
  costCategories,
  incomeVariants,
  balanceSnapshots,
  paySchedules,
  incomeLines,
  variantSchedule,
  bills,
  billSeasonalFactors,
  billStepChanges,
  billInstances,
  variableBudgets,
  variableActuals,
  allocationPlans,
  allocationVersions,
  allocationLines,
  allocationStageGoals,
  goals,
  houseScenarios,
];

/**
 * Tables a backup never carries (plan decision 4): who can sign in, and the
 * record of what they did. Restoring a backup must not be able to lock the
 * household out, sign a revoked device back in, or rewrite the audit trail.
 *
 * Together with BACKED_UP_TABLES this has to account for every table
 * `@budget/schema` exports — backup.test.js fails when one is in neither, so
 * a table added later can't be silently left out of backups.
 *
 * @type {PgTable[]}
 */
export const EXCLUDED_TABLES = [users, sessions, deviceRequests, invites, auditLog];

/**
 * The `settings` row holding the last backup attempt. It describes this
 * machine's backup files, not the household, so it is left out of a backup and
 * survives a restore untouched.
 */
export const BACKUP_STATUS_KEY = "backup_last_attempt";

const FILE_NAME = new RegExp(`^(${BACKUP_KINDS.join("|")})-(\\d{8}T\\d{9}Z)\\.json\\.gz$`);

/**
 * @param {BackupKind} kind
 * @param {Date} takenAt
 */
export function backupFileName(kind, takenAt) {
  const stamp = takenAt.toISOString().replace(/[-:.]/g, "");
  return `${kind}-${stamp}.json.gz`;
}

/**
 * The only way a backup id from a URL ever becomes a path: it has to be a
 * filename this module would have written, which has no separator and no `..`.
 *
 * @param {string} name
 * @returns {{ kind: BackupKind, takenAt: Date } | null}
 */
export function parseBackupFileName(name) {
  const match = FILE_NAME.exec(name);
  if (!match) return null;
  const [, kind, stamp] = match;
  const takenAt = new Date(
    `${stamp?.slice(0, 4)}-${stamp?.slice(4, 6)}-${stamp?.slice(6, 8)}T${stamp?.slice(9, 11)}:${stamp?.slice(11, 13)}:${stamp?.slice(13, 15)}.${stamp?.slice(15, 18)}Z`,
  );
  return { kind: /** @type {BackupKind} */ (kind), takenAt };
}

/**
 * Whether a weekly backup should be taken now. Pure, so the schedule is
 * testable without a clock or a directory.
 *
 * @param {Date | null} newestAt When the newest automatic backup was taken.
 * @param {Date} now
 */
export function isBackupDue(newestAt, now) {
  return newestAt === null || now.getTime() - newestAt.getTime() >= WEEK_MS;
}

/**
 * @typedef {{ id: string, kind: BackupKind, takenAt: string, sizeBytes: number }} BackupEntry
 */

/**
 * The backups in `dir`, newest first. A missing directory is an empty list:
 * nothing has been backed up yet, which is a state to describe.
 *
 * @param {string} dir
 * @returns {Promise<BackupEntry[]>}
 */
export async function listBackups(dir) {
  /** @type {string[]} */
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return [];
    throw err;
  }
  /** @type {BackupEntry[]} */
  const entries = [];
  for (const name of names) {
    const parsed = parseBackupFileName(name);
    if (!parsed) continue;
    const { size } = await stat(path.join(dir, name));
    entries.push({ id: name, kind: parsed.kind, takenAt: parsed.takenAt.toISOString(), sizeBytes: size });
  }
  // The ids sort the same way the times do; the id breaks a same-millisecond tie.
  return entries.sort((a, b) => b.takenAt.localeCompare(a.takenAt) || b.id.localeCompare(a.id));
}

/**
 * Every backed-up table's rows, as the database's own JSON.
 *
 * @param {Db} db
 * @returns {Promise<Record<string, Record<string, unknown>[]>>}
 */
async function exportTables(db) {
  /** @type {Record<string, Record<string, unknown>[]>} */
  const tables = {};
  for (const table of BACKED_UP_TABLES) {
    const name = getTableName(table);
    const where = table === settings ? sql`where key <> ${BACKUP_STATUS_KEY}` : sql``;
    const result = await db.execute(
      sql`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as rows from ${sql.identifier(name)} t ${where}`,
    );
    tables[name] = /** @type {Record<string, unknown>[]} */ (result.rows[0]?.rows ?? []);
  }
  return tables;
}

/**
 * @param {Db} db
 * @param {{ kind: BackupKind, ok: boolean, error: string | null, at: Date }} attempt
 */
async function recordAttempt(db, { kind, ok, error, at }) {
  const value = { at: at.toISOString(), kind, ok, error };
  try {
    await db
      .insert(settings)
      .values({ key: BACKUP_STATUS_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  } catch (err) {
    // Reporting a backup's outcome must never be what fails it.
    console.error(`Could not record the backup attempt: ${describeError(err)}`);
  }
}

/**
 * What the status line says about a failed attempt. A file error (a full disk,
 * a folder that can't be written) says what it needs to as it is; anything
 * from the database goes through describeError, which is what keeps a query's
 * parameters — household figures — out of it.
 *
 * @param {unknown} err
 */
function attemptError(err) {
  const code = /** @type {{ code?: unknown }} */ (err).code;
  if (err instanceof Error && typeof code === "string" && /^E[A-Z]+$/.test(code)) return err.message;
  return describeError(err).split("\n")[0] ?? "Unknown error";
}

/**
 * Writes one backup, then trims that kind to its newest 3 (manual backups
 * excepted). The outcome is recorded either way, for the status line.
 *
 * Written to a temporary name and renamed, so a crash mid-write never leaves
 * a half-file that looks like a backup.
 *
 * @param {Db} db
 * @param {{ dir: string, appVersion: string, kind: BackupKind, now?: Date }} options
 * @returns {Promise<BackupEntry>}
 */
export async function createBackup(db, { dir, appVersion, kind, now = new Date() }) {
  try {
    const header = {
      format: BACKUP_FORMAT,
      takenAt: now.toISOString(),
      kind,
      appVersion,
      // The migration this data was written under — what restore compares.
      schemaVersion: MIGRATION_JOURNAL.at(-1)?.tag ?? "",
    };
    const bytes = await gzipAsync(JSON.stringify({ header, tables: await exportTables(db) }));

    const id = backupFileName(kind, now);
    const file = path.join(dir, id);
    const partial = `${file}.partial`;
    await mkdir(dir, { recursive: true });
    await writeFile(partial, new Uint8Array(bytes));
    await rename(partial, file);

    if (kind !== "manual") await pruneBackups(dir, kind);
    await recordAttempt(db, { kind, ok: true, error: null, at: now });
    return { id, kind, takenAt: header.takenAt, sizeBytes: bytes.byteLength };
  } catch (err) {
    console.error(`Backup (${kind}) failed: ${describeError(err)}`);
    await recordAttempt(db, { kind, ok: false, error: attemptError(err), at: now });
    throw err;
  }
}

/**
 * Deletes all but the newest 3 backups of `kind`.
 *
 * @param {string} dir
 * @param {BackupKind} kind
 */
async function pruneBackups(dir, kind) {
  const ofKind = (await listBackups(dir)).filter((entry) => entry.kind === kind);
  for (const stale of ofKind.slice(KEEP_PER_KIND)) {
    await rm(path.join(dir, stale.id), { force: true });
  }
}

/**
 * Removes one backup. Returns false if there is no such file.
 *
 * @param {string} dir
 * @param {string} id
 */
export async function deleteBackup(dir, id) {
  if (!parseBackupFileName(id)) return false;
  try {
    await stat(path.join(dir, id));
  } catch {
    return false;
  }
  await rm(path.join(dir, id), { force: true });
  return true;
}

/**
 * A backup's bytes, or null if `id` isn't a backup in `dir`. `id` is matched
 * against the filename pattern first, so it can never name another path.
 *
 * @param {string} dir
 * @param {string} id
 * @returns {Promise<Buffer | null>}
 */
export async function readBackupFile(dir, id) {
  if (!parseBackupFileName(id)) return null;
  try {
    return await readFile(path.join(dir, id));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * What the status line, and the dashboard's backup warning, need.
 *
 * `newestAutomaticAt` is read from the files, not remembered: a backup the
 * operator deleted, or one that never reached the disk, must not count.
 * `overdue` is the dashboard's threshold (8 days) — a day past the schedule's
 * own 7, so a backup that is merely due doesn't raise it.
 *
 * @typedef {{
 *   newestAutomaticAt: string | null,
 *   nextDueAt: string | null,
 *   lastAttempt: { at: string, kind: BackupKind, ok: boolean, error: string | null } | null,
 *   overdue: boolean,
 * }} BackupStatus
 *
 * @param {Db} db
 * @param {Date} now
 * @param {string} dir
 * @returns {Promise<BackupStatus>}
 */
export async function getBackupStatus(db, now, dir) {
  const newest = (await listBackups(dir)).find((entry) => entry.kind === "weekly");
  const newestAt = newest ? new Date(newest.takenAt) : null;
  const row = await db.query.settings.findFirst({ where: (s, { eq }) => eq(s.key, BACKUP_STATUS_KEY) });
  return {
    newestAutomaticAt: newestAt?.toISOString() ?? null,
    nextDueAt: newestAt ? new Date(newestAt.getTime() + WEEK_MS).toISOString() : null,
    lastAttempt: /** @type {BackupStatus["lastAttempt"]} */ (row?.value ?? null),
    overdue: newestAt === null || now.getTime() - newestAt.getTime() >= OVERDUE_MS,
  };
}

// Backups, restores and import commits all walk the same files and the same
// tables. One at a time is plenty for two people, and it means a restore can
// never be racing the safety backup of another.
let queue = Promise.resolve();

/**
 * Runs `task` once everything already queued has finished.
 *
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function exclusively(task) {
  const result = queue.then(task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Takes a weekly backup when one is due: checked now and then hourly, so being
 * off for a week means the next start catches up. Returns a function that
 * stops the schedule.
 *
 * @param {Db} db
 * @param {{ dir: string, appVersion: string }} options
 */
export function startBackupScheduler(db, { dir, appVersion }) {
  const check = async () => {
    try {
      await exclusively(async () => {
        const newest = (await listBackups(dir)).find((entry) => entry.kind === "weekly");
        if (!isBackupDue(newest ? new Date(newest.takenAt) : null, new Date())) return;
        await createBackup(db, { dir, appVersion, kind: "weekly" });
        console.log("Took the weekly backup.");
      });
    } catch (err) {
      // createBackup has already logged and recorded a failed write; this is
      // the directory being unreadable.
      console.error(`Backup check failed: ${describeError(err)}`);
    }
  };
  void check();
  const timer = setInterval(check, HOUR_MS);
  // The schedule alone must not keep the process alive.
  timer.unref();
  return () => clearInterval(timer);
}
