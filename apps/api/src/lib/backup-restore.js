import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { allocationVersions, MIGRATION_JOURNAL, settings, users } from "@budget/schema";
import { getTableColumns, getTableName, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  BACKED_UP_TABLES,
  BACKUP_FORMAT,
  BACKUP_KINDS,
  BACKUP_STATUS_KEY,
  createBackup,
} from "./backup.js";
import { describeError } from "./db-errors.js";

/** @import { Db, Tx } from "@budget/schema" */

const gunzipAsync = promisify(gunzip);

// A household's whole database is well under a megabyte of JSON. This only
// stops an uploaded file inflating into something that takes the process down.
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

const backupFileSchema = z.object({
  header: z.object({
    format: z.number().int().positive(),
    takenAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
    kind: z.enum(BACKUP_KINDS),
    appVersion: z.string(),
    schemaVersion: z.string(),
  }),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

/** @typedef {z.infer<typeof backupFileSchema>} BackupFile */

/**
 * A backup request that can't be carried out, with a message written for the
 * person reading it. `status` is the HTTP status the route answers with.
 */
export class BackupError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {400 | 404 | 409 | 422} status
   */
  constructor(code, message, status) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Opens a backup file and checks it is one.
 *
 * @param {Buffer} bytes
 * @returns {Promise<BackupFile>}
 */
export async function decodeBackup(bytes) {
  const notABackup = new BackupError("invalid_backup", "That file isn't a backup from this app.", 400);
  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse((await gunzipAsync(new Uint8Array(bytes), { maxOutputLength: MAX_UNPACKED_BYTES })).toString("utf8"));
  } catch {
    throw notABackup;
  }
  const parsed = backupFileSchema.safeParse(json);
  if (!parsed.success) throw notABackup;
  return parsed.data;
}

/**
 * How a backup's schema compares with this build's: the position of its
 * migration in the journal. A migration this build has never heard of is
 * newer, whatever it is called.
 *
 * @param {BackupFile["header"]} header
 * @returns {"same" | "older" | "newer"}
 */
export function compareSchemaVersion(header) {
  const latest = MIGRATION_JOURNAL.length - 1;
  const index = MIGRATION_JOURNAL.findIndex((entry) => entry.tag === header.schemaVersion);
  if (index === -1 || index > latest || header.format > BACKUP_FORMAT) return "newer";
  return index === latest ? "same" : "older";
}

/**
 * Swaps every backed-up table's rows for the backup's, inside `tx`.
 *
 * Tables are emptied together and refilled parents-first. Each table goes back
 * in one statement through `jsonb_populate_recordset`, naming only the columns
 * the backup actually has: a column added since the backup was taken keeps
 * its default, which is what makes an older backup restorable after an
 * additive migration. Anything else that doesn't fit — a NOT NULL column with
 * no default, an enum value that no longer exists — throws, and the caller
 * rolls the whole transaction back.
 *
 * @param {Tx} tx
 * @param {BackupFile["tables"]} tables
 */
async function replaceHouseholdData(tx, tables) {
  // Users aren't in the backup, so an allocation version's author may not
  // exist here (a fresh host has different users). Nulled rather than failed:
  // it's `on delete set null` in the schema for the same reason.
  const userIds = new Set((await tx.select({ id: users.id }).from(users)).map((row) => row.id));

  const emptied = BACKED_UP_TABLES.filter((table) => table !== settings).map((table) =>
    sql.identifier(getTableName(table)),
  );
  await tx.execute(sql`truncate table ${sql.join(emptied, sql`, `)}`);
  await tx.delete(settings).where(ne(settings.key, BACKUP_STATUS_KEY));

  for (const table of BACKED_UP_TABLES) {
    const name = getTableName(table);
    let rows = tables[name] ?? [];
    if (table === settings) rows = rows.filter((row) => row.key !== BACKUP_STATUS_KEY);
    if (table === allocationVersions) {
      rows = rows.map((row) =>
        typeof row.created_by === "string" && !userIds.has(row.created_by) ? { ...row, created_by: null } : row,
      );
    }
    if (rows.length === 0) continue;

    const known = new Set(Object.values(getTableColumns(table)).map((column) => column.name));
    const present = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => known.has(key));
    const columns = sql.join(
      present.map((key) => sql.identifier(key)),
      sql`, `,
    );
    await tx.execute(
      sql`insert into ${sql.identifier(name)} (${columns}) select ${columns} from jsonb_populate_recordset(null::${sql.identifier(name)}, ${JSON.stringify(rows)}::jsonb)`,
    );
  }
}

/**
 * Replaces all household data with a backup's.
 *
 * Checked in this order, so a refusal costs nothing: the file is a backup, its
 * schema isn't newer than this build's, a safety backup of the current state
 * is on disk, and only then is anything touched. The swap is one transaction —
 * any failure leaves the data exactly as it was.
 *
 * Users, devices (sessions and device requests), invites and the audit log are never part of it.
 *
 * @param {Db} db
 * @param {{ dir: string, appVersion: string, bytes: Buffer, now?: Date }} options
 * @returns {Promise<{ restored: { kind: string, takenAt: string }, safetyBackup: import("./backup.js").BackupEntry }>}
 */
export async function restoreBackup(db, { dir, appVersion, bytes, now = new Date() }) {
  const backup = await decodeBackup(bytes);
  const comparison = compareSchemaVersion(backup.header);
  if (comparison === "newer") {
    throw new BackupError(
      "backup_too_new",
      "This backup was taken by a newer version of the app. Update the app first, then restore it.",
      409,
    );
  }

  const safetyBackup = await createBackup(db, { dir, appVersion, kind: "before-restore", now });

  try {
    await db.transaction((tx) => replaceHouseholdData(tx, backup.tables));
  } catch (err) {
    console.error(`Restore failed and was rolled back: ${describeError(err)}`);
    throw new BackupError(
      "restore_failed",
      comparison === "older"
        ? "This backup predates a change that can't be mapped automatically. Nothing was changed."
        : "The backup couldn't be restored, and nothing was changed. The file may be damaged.",
      422,
    );
  }

  return { restored: { kind: backup.header.kind, takenAt: backup.header.takenAt }, safetyBackup };
}
