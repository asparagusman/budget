import { mustAt } from "@budget/engine";
import { createIncomeLineSchema, incomeLines, updateIncomeLineSchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { handleValidation } from "../lib/validation.js";

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createIncomeLinesRoutes({ db }) {
  const app = new Hono();

  return app
    .post("/", zValidator("json", createIncomeLineSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");

      const variant = await db.query.incomeVariants.findFirst({
        where: (v, { eq: eqCol }) => eqCol(v.id, data.variantId),
      });
      if (!variant) {
        return c.json({ error: { code: "not_found", message: "Income variant not found." } }, 404);
      }
      const person = await db.query.people.findFirst({ where: (p, { eq: eqCol }) => eqCol(p.id, data.personId) });
      if (!person) {
        return c.json({ error: { code: "not_found", message: "Person not found." } }, 404);
      }

      const created = await db.insert(incomeLines).values(data).returning();
      const line = mustAt(created, 0, "created income line");

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "income_line.create",
        entityType: "income_line",
        entityId: line.id,
        metadata: data,
      });

      return c.json({ incomeLine: line }, 201);
    })

    // No `variantId` in this schema — see zod/income-lines.js. `personId` can
    // change here (fixing a mis-assigned person on an existing line), unlike
    // `variantId` which defines which card the line belongs to.
    .patch("/:id", zValidator("json", updateIncomeLineSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");

      const personId = data.personId;
      if (personId) {
        // Captured to a local: narrowing a property access doesn't survive
        // into the closure below, since TS can't rule out `data` being
        // mutated before it runs — a plain local does.
        const person = await db.query.people.findFirst({ where: (p, { eq: eqCol }) => eqCol(p.id, personId) });
        if (!person) {
          return c.json({ error: { code: "not_found", message: "Person not found." } }, 404);
        }
      }

      const [updated] = await db.update(incomeLines).set(data).where(eq(incomeLines.id, id)).returning();
      if (!updated) {
        return c.json({ error: { code: "not_found", message: "Income line not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "income_line.update",
        entityType: "income_line",
        entityId: id,
        metadata: data,
      });

      return c.json({ incomeLine: updated });
    })

    // Hard delete — a line is part of shaping its variant, not a record with
    // its own history (phases/05-income.md "Schema" has no archivedAt here).
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const [deleted] = await db.delete(incomeLines).where(eq(incomeLines.id, id)).returning();
      if (!deleted) {
        return c.json({ error: { code: "not_found", message: "Income line not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "income_line.delete",
        entityType: "income_line",
        entityId: id,
        metadata: { variantId: deleted.variantId },
      });

      return c.json({ ok: true });
    });
}
