import { credentials, renameCredentialSchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { handleValidation } from "../lib/validation.js";

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createCredentialsRoutes({ db }) {
  const app = new Hono();

  return app
    .get("/", async (c) => {
      const userId = getUserId(c);
      const rows = await db.query.credentials.findMany({
        where: (cred, { eq: eqCol }) => eqCol(cred.userId, userId),
        orderBy: (cred, { asc }) => asc(cred.createdAt),
      });
      return c.json({
        credentials: rows.map((cred) => ({
          id: cred.id,
          deviceName: cred.deviceName,
          createdAt: cred.createdAt,
          lastUsedAt: cred.lastUsedAt,
        })),
      });
    })

    .patch("/:id", zValidator("json", renameCredentialSchema, handleValidation), async (c) => {
      const userId = getUserId(c);
      const id = c.req.param("id");
      const data = c.req.valid("json");

      const [updated] = await db
        .update(credentials)
        .set({ deviceName: data.deviceName })
        .where(and(eq(credentials.id, id), eq(credentials.userId, userId)))
        .returning();
      if (!updated) {
        return c.json({ error: { code: "not_found", message: "Device not found." } }, 404);
      }
      return c.json({ credential: { id: updated.id, deviceName: updated.deviceName } });
    })

    // A user may not delete their own last credential — that's a
    // self-lockout (phases/03-auth.md).
    .delete("/:id", async (c) => {
      const userId = getUserId(c);
      const id = c.req.param("id");

      const remaining = await db.$count(credentials, eq(credentials.userId, userId));
      if (remaining <= 1) {
        return c.json(
          {
            error: {
              code: "last_credential",
              message: "You can't remove your last passkey — add another device first.",
            },
          },
          400,
        );
      }

      const [deleted] = await db
        .delete(credentials)
        .where(and(eq(credentials.id, id), eq(credentials.userId, userId)))
        .returning();
      if (!deleted) {
        return c.json({ error: { code: "not_found", message: "Device not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: userId,
        action: "credential.remove",
        entityType: "credential",
        entityId: id,
      });
      return c.json({ ok: true });
    });
}
