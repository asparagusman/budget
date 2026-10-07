import { credentials, invites, sessions, updateUserSchema, users } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { handleValidation } from "../lib/validation.js";

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createUsersRoutes({ db }) {
  const app = new Hono();

  return app
    .get("/", async (c) => {
      const rows = await db.query.users.findMany({
        orderBy: (u, { asc }) => asc(u.createdAt),
      });
      const result = [];
      for (const user of rows) {
        const credentialCount = await db.$count(credentials, eq(credentials.userId, user.id));
        result.push({
          id: user.id,
          displayName: user.displayName,
          email: user.email,
          isActive: user.isActive,
          credentialCount,
        });
      }
      return c.json({ users: result });
    })

    .patch("/:id", zValidator("json", updateUserSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");
      const actorId = getUserId(c);

      // Deactivating yourself ends the session making the request, from a
      // row you are looking at — a lockout one click wide. The other member
      // does it, or nobody does.
      if (data.isActive === false && id === actorId) {
        return c.json(
          { error: { code: "cannot_deactivate_self", message: "You can't deactivate yourself." } },
          400,
        );
      }

      // A user may not deactivate the last active user — self-lockout.
      if (data.isActive === false) {
        const otherActive = await db.$count(users, and(eq(users.isActive, true), ne(users.id, id)));
        if (otherActive === 0) {
          return c.json(
            {
              error: {
                code: "last_active_user",
                message: "You can't deactivate the last active user.",
              },
            },
            400,
          );
        }
      }

      const result = await db.transaction(async (tx) => {
        const [updated] = await tx.update(users).set(data).where(eq(users.id, id)).returning();
        if (!updated) return null;
        if (data.isActive !== false) return { updated, ended: null };

        // Deactivation ends access now, not when a 30-day cookie runs out.
        // Session lookup also refuses an inactive user's session, but
        // revoking them here is what makes the Sessions list, and the audit
        // entry, say so.
        const revoked = await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)))
          .returning({ id: sessions.id });
        // And the doors they could still walk back through. An unredeemed
        // invite they minted is a link still in their hands — a fresh account,
        // or a passkey on whoever it names — and a `new_device` invite FOR
        // them would come back to life on reactivation.
        const withdrawn = await tx
          .delete(invites)
          .where(and(isNull(invites.consumedAt), or(eq(invites.createdBy, id), eq(invites.targetUserId, id))))
          .returning({ id: invites.id });
        return { updated, ended: { revokedSessions: revoked.length, revokedInvites: withdrawn.length } };
      });
      if (!result) {
        return c.json({ error: { code: "not_found", message: "User not found." } }, 404);
      }
      const { updated, ended } = result;

      // Deactivation and reactivation are both a `user.update` carrying the
      // new `isActive`, so the log reads the same either way.
      await writeAuditLog(db, {
        actorId,
        action: "user.update",
        entityType: "user",
        entityId: id,
        metadata: { ...data, ...ended },
      });

      return c.json({
        user: {
          id: updated.id,
          displayName: updated.displayName,
          email: updated.email,
          isActive: updated.isActive,
        },
      });
    });
}
