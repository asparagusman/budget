import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { BackupError, restoreBackup } from "../lib/backup-restore.js";
import {
  createBackup,
  deleteBackup,
  exclusively,
  getBackupStatus,
  listBackups,
  readBackupFile,
} from "../lib/backup.js";
import { handleValidation } from "../lib/validation.js";

// A household's backup is well under a megabyte; this is only a ceiling.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// POST /backups/restore. `z.instanceof(File)` for the same reason the import's
// forms use it: Hono parses a multipart field into a string or a File, and a
// string here is a bug in the caller.
const restoreFormSchema = z.object({
  file: z
    .instanceof(File, { message: "Attach a backup file to restore." })
    .refine((file) => file.size > 0, { message: "Attach a backup file to restore." })
    .refine((file) => file.size <= MAX_UPLOAD_BYTES, {
      message: `The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.`,
    }),
});

const NOT_FOUND = { error: { code: "not_found", message: "Backup not found." } };

/**
 * @param {import("hono").Context} c
 * @param {unknown} err
 */
function backupErrorResponse(c, err) {
  if (!(err instanceof BackupError)) throw err;
  return c.json({ error: { code: err.code, message: err.message } }, err.status);
}

/**
 * `backups` is where the files live and which build wrote them; the same pair
 * the scheduler and the import's safety backup are given.
 *
 * @param {{ db: import("@budget/schema").Db, backups: { dir: string, appVersion: string } }} deps
 */
export function createBackupsRoutes({ db, backups }) {
  const app = new Hono();
  const { dir, appVersion } = backups;

  return app
    .get("/", async (c) =>
      c.json({
        backups: await listBackups(dir),
        status: await getBackupStatus(db, new Date(), dir),
      }),
    )

    .post("/", async (c) => {
      const backup = await exclusively(() => createBackup(db, { dir, appVersion, kind: "manual" }));
      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "backup.create",
        entityType: "backup",
        entityId: backup.id,
      });
      return c.json({ backup }, 201);
    })

    // Registered before `/:id/...` only for the reader's sake: `restore` is a
    // different segment count, so nothing could shadow it either way.
    .post("/restore", zValidator("form", restoreFormSchema, handleValidation), async (c) => {
      const { file } = c.req.valid("form");
      const bytes = Buffer.from(await file.arrayBuffer());
      try {
        const result = await exclusively(() => restoreBackup(db, { dir, appVersion, bytes }));
        await writeAuditLog(db, {
          actorId: getUserId(c),
          action: "backup.restore",
          entityType: "backup",
          entityId: file.name || "upload",
          metadata: { source: "upload", takenAt: result.restored.takenAt },
        });
        return c.json(result);
      } catch (err) {
        return backupErrorResponse(c, err);
      }
    })

    .get("/:id/download", async (c) => {
      const id = c.req.param("id");
      const bytes = await readBackupFile(dir, id);
      if (!bytes) return c.json(NOT_FOUND, 404);
      return c.body(new Uint8Array(bytes), 200, {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${id}"`,
      });
    })

    .post("/:id/restore", async (c) => {
      const id = c.req.param("id");
      try {
        const result = await exclusively(async () => {
          const bytes = await readBackupFile(dir, id);
          if (!bytes) throw new BackupError("not_found", "Backup not found.", 404);
          return restoreBackup(db, { dir, appVersion, bytes });
        });
        await writeAuditLog(db, {
          actorId: getUserId(c),
          action: "backup.restore",
          entityType: "backup",
          entityId: id,
          metadata: { source: "stored", takenAt: result.restored.takenAt },
        });
        return c.json(result);
      } catch (err) {
        return backupErrorResponse(c, err);
      }
    })

    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      if (!(await exclusively(() => deleteBackup(dir, id)))) return c.json(NOT_FOUND, 404);
      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "backup.delete",
        entityType: "backup",
        entityId: id,
      });
      return c.body(null, 204);
    });
}
