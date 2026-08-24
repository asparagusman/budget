import { credentials, updateUserSchema, users } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq, ne } from "drizzle-orm";
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

      const [updated] = await db.update(users).set(data).where(eq(users.id, id)).returning();
      if (!updated) {
        return c.json({ error: { code: "not_found", message: "User not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "user.update",
        entityType: "user",
        entityId: id,
        metadata: data,
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
