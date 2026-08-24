import { mustAt } from "@budget/engine";
import { createInviteSchema, invites } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { generateInviteCode, hashInviteCode } from "../lib/invite.js";
import { handleValidation } from "../lib/validation.js";

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createInvitesRoutes({ db }) {
  const app = new Hono();

  return app
    // Pending invites list for Settings → Users — not in the phase doc's
    // route table, but needed by the screen it specifies ("Pending
    // invites: purpose, expiry, revoke").
    .get("/", async (c) => {
      const rows = await db.query.invites.findMany({
        where: (inv, { isNull: isNullCol }) => isNullCol(inv.consumedAt),
        orderBy: (inv, { desc }) => desc(inv.expiresAt),
      });
      return c.json({
        invites: rows.map((inv) => ({
          id: inv.id,
          purpose: inv.purpose,
          targetUserId: inv.targetUserId,
          expiresAt: inv.expiresAt,
        })),
      });
    })

    .post("/", zValidator("json", createInviteSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");
      const targetUserId = data.purpose === "new_device" ? data.targetUserId : null;
      if (targetUserId) {
        const target = await db.query.users.findFirst({
          where: (u, { eq: eqCol }) => eqCol(u.id, targetUserId),
        });
        if (!target) {
          return c.json({ error: { code: "not_found", message: "User not found." } }, 404);
        }
      }

      const code = generateInviteCode();
      const actorId = getUserId(c);
      const created = await db
        .insert(invites)
        .values({
          codeHash: hashInviteCode(code),
          purpose: data.purpose,
          targetUserId,
          createdBy: actorId,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        })
        .returning();
      const invite = mustAt(created, 0, "created invite");

      await writeAuditLog(db, {
        actorId,
        action: "invite.create",
        entityType: "invite",
        entityId: invite.id,
        metadata: { purpose: data.purpose },
      });

      // The raw code appears exactly once, right here — only its hash is
      // ever persisted (phases/03-auth.md "Schema").
      return c.json({
        invite: { id: invite.id, purpose: invite.purpose, expiresAt: invite.expiresAt, code },
      });
    })

    // Revoke — only an unconsumed invite can be revoked; a consumed one is
    // just history.
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const [deleted] = await db
        .delete(invites)
        .where(and(eq(invites.id, id), isNull(invites.consumedAt)))
        .returning();
      if (!deleted) {
        return c.json({ error: { code: "not_found", message: "Invite not found." } }, 404);
      }
      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "invite.revoke",
        entityType: "invite",
        entityId: id,
      });
      return c.json({ ok: true });
    });
}
