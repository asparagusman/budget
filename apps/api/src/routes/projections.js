import { projectionsQuerySchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { todayIso } from "../lib/dates.js";
import { loadProjections } from "../lib/goals.js";
import { handleValidation } from "../lib/validation.js";

/**
 * Compound growth per account at the household's current contributions — the
 * spreadsheet's Projections sheet, with the growth rate visible. One flat rate
 * per account: no Monte Carlo, no scenarios, no variable returns
 * (phases/09-goals-projections.md "Non-goals").
 *
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createProjectionsRoutes({ db }) {
  const app = new Hono();

  return app.get("/", zValidator("query", projectionsQuerySchema, handleValidation), async (c) => {
    const { months } = c.req.valid("query");
    const on = c.req.valid("query").on ?? todayIso();
    return c.json(await loadProjections(db, { months, on }));
  });
}
