import { billStepChanges, updateBillStepChangeSchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { isUniqueViolation } from "../lib/db-errors.js";
import { handleValidation } from "../lib/validation.js";

// Top-level, not nested under `/bills/:id` — a step change is edited or
// removed by its own id once created, same pattern as `/balances/:id`
// (created via `POST /accounts/:id/balances`) and `/variant-schedule/:id`.
/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createBillStepChangesRoutes({ db }) {
  const app = new Hono();

  return app
    .patch("/:id", zValidator("json", updateBillStepChangeSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");

      try {
        const [updated] = await db.update(billStepChanges).set(data).where(eq(billStepChanges.id, id)).returning();
        if (!updated) {
          return c.json({ error: { code: "not_found", message: "Step change not found." } }, 404);
        }

        await writeAuditLog(db, {
          actorId: getUserId(c),
          action: "bill_step_change.update",
          entityType: "bill_step_change",
          entityId: id,
          metadata: data,
        });

        return c.json({ stepChange: updated });
      } catch (err) {
        if (isUniqueViolation(err)) {
          return c.json(
            {
              error: {
                code: "duplicate_effective_date",
                message: "This bill already has a step change effective from that date.",
              },
            },
            400,
          );
        }
        throw err;
      }
    })

    // Hard delete — genuinely disposable, same as a balance snapshot or a
    // variant-schedule entry (phases/README.md "Database").
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const [deleted] = await db.delete(billStepChanges).where(eq(billStepChanges.id, id)).returning();
      if (!deleted) {
        return c.json({ error: { code: "not_found", message: "Step change not found." } }, 404);
      }
      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "bill_step_change.delete",
        entityType: "bill_step_change",
        entityId: id,
        metadata: { billId: deleted.billId },
      });
      return c.json({ ok: true });
    });
}
