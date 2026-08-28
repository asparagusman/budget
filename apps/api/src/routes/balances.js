import { balanceSnapshots } from "@budget/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";

// A mis-entered balance snapshot is genuinely disposable — hard delete, not
// an archive (phases/README.md "Database"). Lives at the top level
// (`/balances/:id`, not `/accounts/:id/balances/:id`) per
// phases/04-accounts-people.md's own API table.
/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createBalancesRoutes({ db }) {
  const app = new Hono();

  return app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const [deleted] = await db.delete(balanceSnapshots).where(eq(balanceSnapshots.id, id)).returning();
    if (!deleted) {
      return c.json({ error: { code: "not_found", message: "Balance not found." } }, 404);
    }
    await writeAuditLog(db, {
      actorId: getUserId(c),
      action: "balance_snapshot.delete",
      entityType: "balance_snapshot",
      entityId: id,
      metadata: { accountId: deleted.accountId, asAt: deleted.asAt },
    });
    return c.json({ ok: true });
  });
}
