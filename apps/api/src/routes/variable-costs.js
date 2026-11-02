import { mustAt } from "@budget/engine";
import { variableCostsCyclesQuerySchema, variableCostsSummaryQuerySchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getPrimaryPaySchedule } from "../lib/income.js";
import { todayIso } from "../lib/dates.js";
import { buildCycleScaffold, loadActiveVariableCategories, summarizeVariableCosts } from "../lib/variable-costs.js";
import { handleValidation } from "../lib/validation.js";

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createVariableCostsRoutes({ db }) {
  const app = new Hono();

  return app
    // The headline numbers phase 08 consumes (phases/07-variable-costs.md
    // "API") — two named totals, never a single combined `total`. Deducting
    // a non-essential category here would double-count money already
    // accounted for by the prize-pool lines that fund it (same doc, "The
    // trap").
    .get("/summary", zValidator("query", variableCostsSummaryQuerySchema, handleValidation), async (c) => {
      const { on } = c.req.valid("query");
      return c.json(await summarizeVariableCosts(db, on ?? todayIso()));
    })

    // The reverse-sequential entry scaffold, mirroring GET /bills/:id/history
    // so the two entry screens feel like the same tool (phases/
    // 07-variable-costs.md "API").
    .get("/cycles", zValidator("query", variableCostsCyclesQuerySchema, handleValidation), async (c) => {
      const { periods, on } = c.req.valid("query");

      const primary = await getPrimaryPaySchedule(db);
      if (!primary) {
        return c.json(
          { error: { code: "no_primary_schedule", message: "Set a primary pay schedule first." } },
          400,
        );
      }

      const categories = await loadActiveVariableCategories(db);
      const bounds = buildCycleScaffold(primary, on ?? todayIso(), periods);

      const newest = mustAt(bounds, 0, "current cycle bound");
      const earliest = mustAt(bounds, bounds.length - 1, "earliest cycle bound");

      const actualRows = await db.query.variableActuals.findMany();
      const relevant = actualRows.filter((r) => r.cycleStart >= earliest.cycleStart && r.cycleStart <= newest.cycleStart);
      const amountByKey = new Map(relevant.map((r) => [`${r.categoryId}:${r.cycleStart}`, r.amountCents]));

      const cycles = bounds.map((bound) => ({
        ...bound,
        entries: categories.map((cat) => ({
          categoryId: cat.id,
          name: cat.name,
          isEssential: cat.isEssential,
          amountCents: amountByKey.get(`${cat.id}:${bound.cycleStart}`) ?? null,
        })),
      }));

      return c.json({ cycles });
    });
}
