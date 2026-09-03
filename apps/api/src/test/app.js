import { Hono } from "hono";
import { createAllocationRoutes } from "../routes/allocation.js";
import { createDashboardRoutes } from "../routes/dashboard.js";
import { createFixedCostsRoutes } from "../routes/fixed-costs.js";
import { createGoalsRoutes } from "../routes/goals.js";
import { createIncomeRoutes } from "../routes/income.js";
import { createNetWorthRoutes } from "../routes/net-worth.js";
import { createVariableCostsRoutes } from "../routes/variable-costs.js";

/** @import { Db } from "@budget/schema" */

// The read side of the API, mounted at the same paths src/index.js mounts it
// at, with no auth middleware — these tests are about what the endpoints
// COMPUTE, and a session cookie proves nothing about that.
//
// Only the routes the dashboard draws from are here. index.js stays the one
// place the whole app is assembled, so a route added there and forgotten
// here fails loudly at the first request rather than being silently
// half-tested.
/** @param {Db} db */
export function createReadApp(db) {
  return new Hono()
    .route("/income", createIncomeRoutes({ db }))
    .route("/fixed-costs", createFixedCostsRoutes({ db }))
    .route("/variable-costs", createVariableCostsRoutes({ db }))
    .route("/allocation", createAllocationRoutes({ db }))
    .route("/goals", createGoalsRoutes({ db }))
    .route("/net-worth", createNetWorthRoutes({ db }))
    .route("/dashboard", createDashboardRoutes({ db }));
}

/**
 * GETs a path and returns the parsed body, failing with the body's own error
 * message rather than a bare status code — a 400 from `handleValidation` says
 * exactly which field it disliked, and swallowing that costs an hour.
 *
 * @param {import("hono").Hono} app
 * @param {string} path
 * @returns {Promise<any>}
 */
export async function get(app, path) {
  const res = await app.request(path);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}
