import { mustAt } from "@budget/engine";
import { createVariableBudgetSchema, updateVariableBudgetSchema, variableBudgets } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { isUniqueViolation } from "../lib/db-errors.js";
import { handleValidation } from "../lib/validation.js";

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createVariableBudgetsRoutes({ db }) {
  const app = new Hono();

  return app
    // Every dated row, every category — the client resolves "current" per
    // category itself via the engine's `resolveVariableBudget`, the same
    // "compute client-side from pure engine output" pattern as fixed-costs-
    // page.jsx's amount-model preview, rather than the server duplicating
    // that resolution for a display figure.
    .get("/", async (c) => {
      const rows = await db.query.variableBudgets.findMany({
        orderBy: (b, { asc }) => [asc(b.categoryId), asc(b.effectiveFrom)],
      });
      return c.json({ variableBudgets: rows });
    })

    // A new dated row — "changing the budget" going forward, never an edit
    // of an earlier row's own amount (phases/07-variable-costs.md "Schema").
    .post("/", zValidator("json", createVariableBudgetSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");

      const category = await db.query.costCategories.findFirst({
        where: (cat, { eq: eqCol }) => eqCol(cat.id, data.categoryId),
      });
      if (!category) {
        return c.json({ error: { code: "not_found", message: "Cost category not found." } }, 404);
      }

      try {
        const created = await db.insert(variableBudgets).values(data).returning();
        const budget = mustAt(created, 0, "created variable budget");

        await writeAuditLog(db, {
          actorId: getUserId(c),
          action: "variable_budget.create",
          entityType: "variable_budget",
          entityId: budget.id,
          metadata: data,
        });

        return c.json({ variableBudget: budget }, 201);
      } catch (err) {
        if (isUniqueViolation(err)) {
          return c.json(
            {
              error: {
                code: "duplicate_effective_date",
                message: "This category already has a budget effective from that date.",
              },
            },
            400,
          );
        }
        throw err;
      }
    })

    // For correcting a mistaken row, not for changing the plan going
    // forward (that's a new POST row) — all fields optional so a caller can
    // send just one.
    .patch("/:id", zValidator("json", updateVariableBudgetSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");

      try {
        const [updated] = await db.update(variableBudgets).set(data).where(eq(variableBudgets.id, id)).returning();
        if (!updated) {
          return c.json({ error: { code: "not_found", message: "Variable budget not found." } }, 404);
        }

        await writeAuditLog(db, {
          actorId: getUserId(c),
          action: "variable_budget.update",
          entityType: "variable_budget",
          entityId: id,
          metadata: data,
        });

        return c.json({ variableBudget: updated });
      } catch (err) {
        if (isUniqueViolation(err)) {
          return c.json(
            {
              error: {
                code: "duplicate_effective_date",
                message: "This category already has a budget effective from that date.",
              },
            },
            400,
          );
        }
        throw err;
      }
    })

    // Hard delete — no `archivedAt` on this table, same "genuinely
    // disposable" reasoning as a bill step change (phases/README.md
    // "Database").
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const [deleted] = await db.delete(variableBudgets).where(eq(variableBudgets.id, id)).returning();
      if (!deleted) {
        return c.json({ error: { code: "not_found", message: "Variable budget not found." } }, 404);
      }
      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "variable_budget.delete",
        entityType: "variable_budget",
        entityId: id,
        metadata: { categoryId: deleted.categoryId },
      });
      return c.json({ ok: true });
    });
}
