import { mustAt } from "@budget/engine";
import { approveDeviceRequestSchema, deviceRequests, users } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { describeDeviceRequest } from "../lib/device-request.js";
import { handleValidation } from "../lib/validation.js";

const GONE = {
  code: "not_found",
  message: "That device stopped waiting — it may have given up or timed out. Ask it to try again.",
};

/** Thrown inside the approval's transaction to roll it back. */
class RequestGone extends Error {}

/**
 * Devices waiting to be let in, and the approve/deny that answers them. Any
 * signed-in member may answer for any device, choosing whose it is: two
 * people, no roles, and "approve Grace's new phone" from either phone is the
 * ordinary way a device joins (see /auth/device-requests for the asking side).
 *
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createDeviceRequestsRoutes({ db }) {
  const app = new Hono();

  return app
    .get("/", async (c) => {
      const rows = await db.query.deviceRequests.findMany({
        where: (r, { and: andCol, gt: gtCol, isNull: isNullCol }) =>
          andCol(isNullCol(r.approvedUserId), gtCol(r.expiresAt, new Date())),
        orderBy: (r, { asc }) => asc(r.createdAt),
      });
      return c.json({ requests: rows.map(describeDeviceRequest) });
    })

    .post("/:id/approve", zValidator("json", approveDeviceRequestSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");
      const actorId = getUserId(c);

      if ("userId" in data) {
        const target = await db.query.users.findFirst({ where: (u, { eq: eqCol }) => eqCol(u.id, data.userId) });
        if (!target) return c.json({ error: { code: "not_found", message: "User not found." } }, 404);
        if (!target.isActive) {
          return c.json(
            {
              error: {
                code: "inactive_user",
                message: `${target.displayName} is deactivated. Reactivate them before approving a device for them.`,
              },
            },
            400,
          );
        }
      }

      let approved;
      try {
        approved = await db.transaction(async (tx) => {
          const userId =
            "userId" in data
              ? data.userId
              : mustAt(
                  await tx.insert(users).values({ displayName: data.newUserDisplayName }).returning(),
                  0,
                  "created user",
                ).id;
          // Only a request still waiting: approving one twice, or one that
          // expired while the dialog was open, changes nothing.
          const [row] = await tx
            .update(deviceRequests)
            .set({ approvedUserId: userId, approvedBy: actorId, approvedAt: new Date() })
            .where(
              and(
                eq(deviceRequests.id, id),
                isNull(deviceRequests.approvedUserId),
                gt(deviceRequests.expiresAt, new Date()),
              ),
            )
            .returning();
          // Rolls back the new user too: nobody to sign in, nobody to create.
          if (!row) throw new RequestGone();
          return { row, userId, createdUser: !("userId" in data) };
        });
      } catch (err) {
        if (err instanceof RequestGone) return c.json({ error: GONE }, 404);
        throw err;
      }

      if (approved.createdUser) {
        await writeAuditLog(db, {
          actorId,
          action: "user.create",
          entityType: "user",
          entityId: approved.userId,
          metadata: { via: "device_approval" },
        });
      }
      await writeAuditLog(db, {
        actorId,
        action: "device_request.approve",
        entityType: "device_request",
        entityId: id,
        metadata: { userId: approved.userId, deviceName: approved.row.deviceName },
      });
      return c.json({ ok: true });
    })

    // Deny: the waiting device's next poll finds nothing and says so.
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const [deleted] = await db
        .delete(deviceRequests)
        .where(and(eq(deviceRequests.id, id), isNull(deviceRequests.approvedUserId)))
        .returning();
      if (!deleted) return c.json({ error: GONE }, 404);
      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "device_request.deny",
        entityType: "device_request",
        entityId: id,
        metadata: { deviceName: deleted.deviceName },
      });
      return c.json({ ok: true });
    });
}
