import { netWorthQuerySchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { loadNetWorth } from "../lib/goals.js";
import { handleValidation } from "../lib/validation.js";

/**
 * Balance history across the accounts the household actually owns. Excludes
 * `external` accounts — money sent to a church or a landlord is not net worth
 * — and never interpolates between snapshots: each sample carries the last
 * balance recorded at or before it, with its own `asAt` so the UI can show how
 * old that is (phases/09-goals-projections.md "API").
 *
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createNetWorthRoutes({ db }) {
  const app = new Hono();

  return app.get("/", zValidator("query", netWorthQuerySchema, handleValidation), async (c) => {
    const window = c.req.valid("query");
    return c.json(await loadNetWorth(db, window));
  });
}
