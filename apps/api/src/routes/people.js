import { createPersonSchema, people, updatePersonSchema } from "@budget/schema";
import { mustAt } from "@budget/engine";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
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
