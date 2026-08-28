import { mustAt, projectPaydays } from "@budget/engine";
import { listVariableActualsQuerySchema, upsertVariableActualsSchema, variableActuals } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { getPrimaryPaySchedule } from "../lib/income.js";
import { handleValidation } from "../lib/validation.js";

/**
 * Groups `entries` by `categoryId`, preserving input order within each
 * group — used only to give the bulk upsert below one audit-log row per
 * affected category rather than one per cell.
 *
 * @param {{ categoryId: string }[]} entries
 */
function groupByCategory(entries) {
  /** @type {Map<string, typeof entries>} */
  const map = new Map();
  for (const entry of entries) {
    const group = map.get(entry.categoryId);
    if (group) group.push(entry);
    else map.set(entry.categoryId, [entry]);
  }
  return map;
}

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createVariableActualsRoutes({ db }) {
  const app = new Hono();

  return app
    // Stored rows in `[from, to)`, each flagged `isOrphanCycle: true` when
    // its `cycleStart` no longer lands on a payday under the *current*
    // primary pay schedule — never dropped or remapped, only flagged
    // (phases/07-variable-costs.md "Schema"). With no primary schedule set
    // at all, nothing can be an orphan yet.
    .get("/", zValidator("query", listVariableActualsQuerySchema, handleValidation), async (c) => {
      const { from, to } = c.req.valid("query");
      const rows = await db.query.variableActuals.findMany();
      const inWindow = rows.filter((r) => r.cycleStart >= from && r.cycleStart < to);

      const primary = await getPrimaryPaySchedule(db);
      const validCycleStarts = new Set(primary ? projectPaydays(primary, { from, to }) : []);

      return c.json({
        variableActuals: inWindow.map((r) => ({
          ...r,
          isOrphanCycle: primary ? !validCycleStarts.has(r.cycleStart) : false,
        })),
      });
    })

    // One bulk upsert across every category and cycle entered on the grid —
    // a single transaction so a failure partway through never leaves some
    // cells saved and others not (phases/07-variable-costs.md "Actuals
    // entry": "Single bulk upsert on save."). `amountCents: null` deletes
    // the row instead of storing a null, since this table's `amount_cents`
    // is NOT NULL — a cleared cell has no row at all.
    .put("/", zValidator("json", upsertVariableActualsSchema, handleValidation), async (c) => {
      const { entries } = c.req.valid("json");

      const saved = await db.transaction(async (tx) => {
        /** @type {(typeof variableActuals.$inferSelect)[]} */
        const written = [];
        for (const entry of entries) {
          if (entry.amountCents === null) {
            await tx
              .delete(variableActuals)
              .where(and(eq(variableActuals.categoryId, entry.categoryId), eq(variableActuals.cycleStart, entry.cycleStart)));
            continue;
          }
          const [row] = await tx
            .insert(variableActuals)
            .values({ categoryId: entry.categoryId, cycleStart: entry.cycleStart, amountCents: entry.amountCents })
            .onConflictDoUpdate({
              target: [variableActuals.categoryId, variableActuals.cycleStart],
              set: { amountCents: entry.amountCents },
            })
            .returning();
          written.push(mustAt([row], 0, "variable actual"));
        }
        return written;
      });

      for (const [categoryId, categoryEntries] of groupByCategory(entries)) {
        await writeAuditLog(db, {
          actorId: getUserId(c),
          action: "variable_actuals.upsert",
          entityType: "variable_actual",
          entityId: categoryId,
          metadata: { entries: categoryEntries },
        });
      }

      return c.json({ variableActuals: saved });
    })

    // Not in the phase doc's own route table, but needed for its "let the
    // operator remap or keep" orphan action — same precedent as
    // DELETE /bill-instances/:id (phases/06-fixed-costs.md "Orphaned
    // instances"). A deliberate, operator-initiated discard of one row they
    // no longer want; the system itself still never drops an orphan on its
    // own.
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const [deleted] = await db.delete(variableActuals).where(eq(variableActuals.id, id)).returning();
      if (!deleted) {
        return c.json({ error: { code: "not_found", message: "Variable actual not found." } }, 404);
      }
      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "variable_actual.delete",
        entityType: "variable_actual",
        entityId: id,
        metadata: { categoryId: deleted.categoryId, cycleStart: deleted.cycleStart },
      });
      return c.json({ ok: true });
    });
}
