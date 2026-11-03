import { renameDeviceSchema, sessions } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getSessionId, getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { handleValidation } from "../lib/validation.js";

/**
 * Your signed-in devices. A session IS a device here — approving a device is
 * what creates one — so this list is "My devices", and revoking one signs
 * that device out until it is approved again.
 *
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createSessionsRoutes({ db }) {
  const app = new Hono();

  return app
    .get("/", async (c) => {
      const userId = getUserId(c);
      const currentSessionId = getSessionId(c);
      const rows = await db.query.sessions.findMany({
        where: (s, { eq: eqCol, and: andCol, isNull: isNullCol, gt: gtCol }) =>
          andCol(eqCol(s.userId, userId), isNullCol(s.revokedAt), gtCol(s.expiresAt, new Date())),
        orderBy: (s, { desc }) => desc(s.lastSeenAt),
      });
      return c.json({
        sessions: rows.map((s) => ({
          id: s.id,
          deviceName: s.deviceName,
          authMethod: s.authMethod,
          userAgent: s.userAgent,
          createdAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          expiresAt: s.expiresAt,
          isCurrent: s.id === currentSessionId,
        })),
      });
    })

    .patch("/:id", zValidator("json", renameDeviceSchema, handleValidation), async (c) => {
      const userId = getUserId(c);
      const [updated] = await db
        .update(sessions)
        .set({ deviceName: c.req.valid("json").deviceName })
        .where(and(eq(sessions.id, c.req.param("id")), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
        .returning();
      if (!updated) {
        return c.json({ error: { code: "not_found", message: "Device not found." } }, 404);
      }
      return c.json({ session: { id: updated.id, deviceName: updated.deviceName } });
    })

    // Revoking a session here takes effect on that browser's next request —
    // getSessionFromRequest re-checks revokedAt every time, there's no
    // separate cache to invalidate.
    .delete("/:id", async (c) => {
      const userId = getUserId(c);
      const id = c.req.param("id");
      const [revoked] = await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(sessions.id, id),
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!revoked) {
        return c.json({ error: { code: "not_found", message: "Device not found." } }, 404);
      }
      await writeAuditLog(db, {
        actorId: userId,
        action: "session.revoke",
        entityType: "session",
        entityId: id,
      });
      return c.json({ ok: true });
    });
}
