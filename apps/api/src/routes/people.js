import { createPersonSchema, people, reorderSchema, updatePersonSchema } from "@budget/schema";
import { mustAt } from "@budget/engine";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { reorderError } from "../lib/reorder.js";
import { handleValidation } from "../lib/validation.js";

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createPeopleRoutes({ db }) {
  const app = new Hono();

  return app
    // Archived people are hidden from this list (and so from pickers) but
    // remain resolvable by id — a pay schedule referencing one still
    // renders a name (phases/04-accounts-people.md "Archiving").
    .get("/", async (c) => {
      const rows = await db.query.people.findMany({
        where: (p, { isNull: isNullCol }) => isNullCol(p.archivedAt),
        orderBy: (p, { asc: ascCol }) => [ascCol(p.sortOrder), ascCol(p.name)],
      });
      return c.json({ people: rows });
    })

    .post("/", zValidator("json", createPersonSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");
      const created = await db.insert(people).values(data).returning();
      const person = mustAt(created, 0, "created person");
      return c.json({ person }, 201);
    })

    // The whole list in its new order, renumbered 0..n-1 in one transaction.
    // See the schema's own comment for why this is not a `sortOrder` field on
    // the edit form: every row starts at the column default of 0, so there is
    // no per-row number to nudge until something has written a real one.
    .post("/reorder", zValidator("json", reorderSchema, handleValidation), async (c) => {
      const { ids } = c.req.valid("json");

      const rows = await db.query.people.findMany({
        where: (p, { isNull: isNullCol }) => isNullCol(p.archivedAt),
        columns: { id: true },
      });
      const problem = reorderError(ids, rows.map((row) => row.id), "people");
      if (problem) {
        return c.json({ error: { code: "incomplete_order", message: problem } }, 400);
      }

      await db.transaction(async (tx) => {
        for (const [index, id] of ids.entries()) {
          await tx.update(people).set({ sortOrder: index }).where(eq(people.id, id));
        }
      });

      return c.json({ ok: true });
    })

    .patch("/:id", zValidator("json", updatePersonSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");
      const [updated] = await db.update(people).set(data).where(eq(people.id, id)).returning();
      if (!updated) {
        return c.json({ error: { code: "not_found", message: "Person not found." } }, 404);
      }
      return c.json({ person: updated });
    })

    // Archive, never a hard delete — a person may already be referenced by
    // a pay schedule (and, from phase 05, income lines).
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const [archived] = await db
        .update(people)
        .set({ archivedAt: new Date() })
        .where(and(eq(people.id, id), isNull(people.archivedAt)))
        .returning();
      if (!archived) {
        return c.json({ error: { code: "not_found", message: "Person not found." } }, 404);
      }
      return c.json({ ok: true });
    });
}
