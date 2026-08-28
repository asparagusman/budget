import { mustAt } from "@budget/engine";
import { createVariantScheduleSchema, updateVariantScheduleSchema, variantSchedule } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { handleValidation } from "../lib/validation.js";

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createVariantScheduleRoutes({ db }) {
  const app = new Hono();

  return app
    .get("/", async (c) => {
      const rows = await db.query.variantSchedule.findMany({
        orderBy: (s, { asc }) => [asc(s.startsOn)],
      });
      return c.json({ variantSchedule: rows });
    })

    .post("/", zValidator("json", createVariantScheduleSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");

      const variant = await db.query.incomeVariants.findFirst({
        where: (v, { eq: eqCol }) => eqCol(v.id, data.variantId),
      });
      if (!variant) {
        return c.json({ error: { code: "not_found", message: "Income variant not found." } }, 404);
      }

      const created = await db.insert(variantSchedule).values(data).returning();
      const entry = mustAt(created, 0, "created schedule entry");

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "variant_schedule.create",
        entityType: "variant_schedule",
        entityId: entry.id,
        metadata: data,
      });

      return c.json({ scheduleEntry: entry }, 201);
    })

    // No `variantId` here — see zod/variant-schedule.js.
    .patch("/:id", zValidator("json", updateVariantScheduleSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");

      const [updated] = await db.update(variantSchedule).set(data).where(eq(variantSchedule.id, id)).returning();
      if (!updated) {
        return c.json({ error: { code: "not_found", message: "Schedule entry not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "variant_schedule.update",
        entityType: "variant_schedule",
        entityId: id,
        metadata: data,
      });

      return c.json({ scheduleEntry: updated });
    })

    // Hard delete — a schedule entry is genuinely disposable, same as a
    // balance snapshot (phases/README.md "Database").
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const [deleted] = await db.delete(variantSchedule).where(eq(variantSchedule.id, id)).returning();
      if (!deleted) {
        return c.json({ error: { code: "not_found", message: "Schedule entry not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "variant_schedule.delete",
        entityType: "variant_schedule",
        entityId: id,
      });

      return c.json({ ok: true });
    });
}
