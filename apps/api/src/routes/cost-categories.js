import { mustAt } from "@budget/engine";
import { bills, costCategories, createCostCategorySchema, listCostCategoriesQuerySchema, updateCostCategorySchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { handleValidation } from "../lib/validation.js";

// Shared by fixed costs (this phase) and variable costs (phase 07) — one
// table, `?kind=` narrows the list each phase's own screen wants.
/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createCostCategoriesRoutes({ db }) {
  const app = new Hono();

  return app
    .get("/", zValidator("query", listCostCategoriesQuerySchema, handleValidation), async (c) => {
      const { kind } = c.req.valid("query");
      const rows = await db.query.costCategories.findMany({
        where: (cat, { and: andCol, eq: eqCol, isNull: isNullCol }) =>
          kind ? andCol(isNullCol(cat.archivedAt), eqCol(cat.kind, kind)) : isNullCol(cat.archivedAt),
        orderBy: (cat, { asc }) => [asc(cat.sortOrder), asc(cat.name)],
      });
      return c.json({ costCategories: rows });
    })

    .post("/", zValidator("json", createCostCategorySchema, handleValidation), async (c) => {
      const data = c.req.valid("json");
      const created = await db.insert(costCategories).values(data).returning();
      const category = mustAt(created, 0, "created cost category");

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "cost_category.create",
        entityType: "cost_category",
        entityId: category.id,
        metadata: data,
      });

      return c.json({ costCategory: category }, 201);
    })

    .patch("/:id", zValidator("json", updateCostCategorySchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");
      const [updated] = await db.update(costCategories).set(data).where(eq(costCategories.id, id)).returning();
      if (!updated) {
        return c.json({ error: { code: "not_found", message: "Cost category not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "cost_category.update",
        entityType: "cost_category",
        entityId: id,
        metadata: data,
      });

      return c.json({ costCategory: updated });
    })

    // Archive, never a hard delete. Refused with a message naming what
    // references it — same pattern as income-variants.js's schedule check —
    // since a category's subtotal is derived from bill membership at read
    // time (phases/06-fixed-costs.md "Category subtotals are derived"); a
    // bill left pointing at an archived category would silently vanish from
    // every subtotal instead of erroring loudly.
    .delete("/:id", async (c) => {
      const id = c.req.param("id");

      const billCount = await db.$count(bills, and(eq(bills.categoryId, id), isNull(bills.archivedAt)));
      if (billCount > 0) {
        return c.json(
          {
            error: {
              code: "referenced",
              message: `This category is used by ${billCount} bill${billCount === 1 ? "" : "s"} — move or archive ${billCount === 1 ? "it" : "them"} first.`,
            },
          },
          400,
        );
      }

      const [archived] = await db
        .update(costCategories)
        .set({ archivedAt: new Date() })
        .where(and(eq(costCategories.id, id), isNull(costCategories.archivedAt)))
        .returning();
      if (!archived) {
        return c.json({ error: { code: "not_found", message: "Cost category not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "cost_category.archive",
        entityType: "cost_category",
        entityId: id,
      });

      return c.json({ ok: true });
    });
}
