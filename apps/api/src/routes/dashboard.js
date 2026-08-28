import { dashboardQuerySchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { loadDashboard } from "../lib/dashboard.js";
import { todayIso } from "../lib/dates.js";
import { handleValidation } from "../lib/validation.js";

/**
 * One aggregate endpoint, so the dashboard is a single request and cannot show
 * internally inconsistent figures assembled from a race between six calls
 * (phases/10-dashboard.md "Data").
 *
 * It is read-only, and it is the only endpoint this phase adds. Every figure
 * comes from the phase that owns it — see `loadDashboard`.
 *
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createDashboardRoutes({ db }) {
  const app = new Hono();

  return app.get("/", zValidator("query", dashboardQuerySchema, handleValidation), async (c) => {
    const on = c.req.valid("query").on ?? todayIso();
    return c.json(await loadDashboard(db, on));
  });
}
