import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createDb } from "@budget/schema";
import { config as loadDotenv } from "dotenv";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { loadEnv } from "./env.js";
import { readMigrationHealth } from "./lib/health.js";
import { requireAuth } from "./middleware/auth.js";
import { createAccountsRoutes } from "./routes/accounts.js";
import { createAllocationRoutes } from "./routes/allocation.js";
import { createAllocationPlansRoutes } from "./routes/allocation-plans.js";
import { createAllocationVersionsRoutes } from "./routes/allocation-versions.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createBalancesRoutes } from "./routes/balances.js";
import { createBillInstancesRoutes } from "./routes/bill-instances.js";
import { createBillStepChangesRoutes } from "./routes/bill-step-changes.js";
import { createBillsRoutes } from "./routes/bills.js";
import { createCostCategoriesRoutes } from "./routes/cost-categories.js";
import { createCredentialsRoutes } from "./routes/credentials.js";
import { createDashboardRoutes } from "./routes/dashboard.js";
import { createFixedCostsRoutes } from "./routes/fixed-costs.js";
import { createGoalsRoutes } from "./routes/goals.js";
import { createIncomeRoutes } from "./routes/income.js";
import { createIncomeLinesRoutes } from "./routes/income-lines.js";
import { createIncomeVariantsRoutes } from "./routes/income-variants.js";
import { createImportRoutes } from "./routes/import.js";
import { createInvitesRoutes } from "./routes/invites.js";
import { createNetWorthRoutes } from "./routes/net-worth.js";
import { createPaySchedulesRoutes } from "./routes/pay-schedules.js";
import { createPeopleRoutes } from "./routes/people.js";
import { createProjectionsRoutes } from "./routes/projections.js";
import { createSessionsRoutes } from "./routes/sessions.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createUsersRoutes } from "./routes/users.js";
import { createVariableActualsRoutes } from "./routes/variable-actuals.js";
import { createVariableBudgetsRoutes } from "./routes/variable-budgets.js";
import { createVariableCostsRoutes } from "./routes/variable-costs.js";
import { createVariantScheduleRoutes } from "./routes/variant-schedule.js";

// Local/dev only: reads the repo-root .env relative to this file's own
// location (not process.cwd(), which pnpm sets to this package's dir).
// Inside Docker, real env vars are already set by docker-compose and this
// is a no-op since there's no .env file in the image.
loadDotenv({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
  quiet: true,
});

const env = loadEnv();
const db = createDb(env.DATABASE_URL);

const app = new Hono();

// Method, path, status, duration only — request bodies carry financial data
// and must never be logged. hono/logger's default format doesn't touch the
// body at all.
app.use(logger());

// Web and API share an origin in production (both sit behind the same
// tailscale serve hostname), so this is a no-op there. In dev they're on
// different ports, and the session cookie needs to travel with fetches
// between them — hence `credentials: true` and an explicit origin rather
// than "*".
app.use(cors({ origin: env.PUBLIC_ORIGIN, credentials: true }));

// Guards the whole API. Opt-in protection is how an unguarded route ships;
// opt-out is how it doesn't — see phases/03-auth.md "Guard the whole API".
// The middleware itself allowlists /health and /auth/*.
app.use("*", requireAuth(db));

app.onError((err, c) => {
  console.error(err);
  return c.json(
    { error: { code: "internal_error", message: "Something went wrong." } },
    500,
  );
});

app.notFound((c) =>
  c.json({ error: { code: "not_found", message: "Not found." } }, 404),
);

const routes = app
  // Deliberately the whole of this app's observability, alongside the
  // request log above — a two-user household app earns a health endpoint
  // and nothing else (phases/11-polish-mobile-import.md, "Health and
  // observability, kept proportionate").
  //
  // `ok` is false when the database is unreachable OR migrations are
  // behind the running build, because both mean requests will fail in ways
  // that are much harder to read from the symptom than from here.
  .get("/health", async (c) => {
    let dbOk = false;
    try {
      await db.execute(sql`select 1`);
      dbOk = true;
    } catch (err) {
      console.error("Health check DB probe failed:", err);
      dbOk = false;
    }
    const migrations = dbOk
      ? await readMigrationHealth(db)
      : { applied: null, migrationsUnavailable: true };
    const migrationsBehind = dbOk && "pending" in migrations && (migrations.pending ?? 0) > 0;
    return c.json(
      {
        ok: dbOk && !migrationsBehind,
        db: dbOk,
        version: env.APP_VERSION,
        migrations,
      },
      dbOk && !migrationsBehind ? 200 : 503,
    );
  })
  .route("/auth", createAuthRoutes({ db, env }))
  .route("/users", createUsersRoutes({ db }))
  .route("/invites", createInvitesRoutes({ db }))
  .route("/credentials", createCredentialsRoutes({ db }))
  .route("/sessions", createSessionsRoutes({ db }))
  .route("/people", createPeopleRoutes({ db }))
  .route("/accounts", createAccountsRoutes({ db }))
  .route("/balances", createBalancesRoutes({ db }))
  .route("/pay-schedules", createPaySchedulesRoutes({ db }))
  .route("/income-variants", createIncomeVariantsRoutes({ db }))
  .route("/income-lines", createIncomeLinesRoutes({ db }))
  .route("/variant-schedule", createVariantScheduleRoutes({ db }))
  .route("/income", createIncomeRoutes({ db }))
  .route("/settings", createSettingsRoutes({ db }))
  .route("/cost-categories", createCostCategoriesRoutes({ db }))
  .route("/bills", createBillsRoutes({ db }))
  .route("/bill-step-changes", createBillStepChangesRoutes({ db }))
  .route("/bill-instances", createBillInstancesRoutes({ db }))
  .route("/fixed-costs", createFixedCostsRoutes({ db }))
  .route("/variable-budgets", createVariableBudgetsRoutes({ db }))
  .route("/variable-actuals", createVariableActualsRoutes({ db }))
  .route("/variable-costs", createVariableCostsRoutes({ db }))
  .route("/allocation-plans", createAllocationPlansRoutes({ db }))
  .route("/allocation-versions", createAllocationVersionsRoutes({ db }))
  .route("/allocation", createAllocationRoutes({ db }))
  .route("/goals", createGoalsRoutes({ db }))
  .route("/net-worth", createNetWorthRoutes({ db }))
  .route("/projections", createProjectionsRoutes({ db }))
  .route("/dashboard", createDashboardRoutes({ db }))
  .route("/import", createImportRoutes({ db }));

// Consumed by the Hono RPC client in apps/web. A JSDoc @typedef in a module
// is reachable cross-package as `import("@budget/api").ApiRoutes`, so web
// still pulls types only — never this file's runtime code.
/** @typedef {typeof routes} ApiRoutes */

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
