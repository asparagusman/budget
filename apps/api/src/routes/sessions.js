import { sessions } from "@budget/schema";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getSessionId, getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createSessionsRoutes({ db }) {
  const app = new Hono();

  return app
    .get("/", async (c) => {
      const userId = getUserId(c);
      const currentSessionId = getSessionId(c);
      const rows = await db.query.sessions.findMany({
        where: (s, { eq: eqCol, and: andCol, isNull: isNullCol }) =>
          andCol(eqCol(s.userId, userId), isNullCol(s.revokedAt)),
        orderBy: (s, { desc }) => desc(s.lastSeenAt),
      });
      return c.json({
        sessions: rows.map((s) => ({
          id: s.id,
          userAgent: s.userAgent,
          createdAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          expiresAt: s.expiresAt,
          isCurrent: s.id === currentSessionId,
        })),
      });
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
        .where(and(eq(sessions.id, id), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
        .returning();
      if (!revoked) {
        return c.json({ error: { code: "not_found", message: "Session not found." } }, 404);
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
