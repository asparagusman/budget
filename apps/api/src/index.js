import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createDb } from "@budget/schema";
import { config as loadDotenv } from "dotenv";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { loadEnv } from "./env.js";
import { requireAuth } from "./middleware/auth.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createCredentialsRoutes } from "./routes/credentials.js";
import { createInvitesRoutes } from "./routes/invites.js";
import { createSessionsRoutes } from "./routes/sessions.js";
import { createUsersRoutes } from "./routes/users.js";

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
  .get("/health", async (c) => {
    let dbOk = false;
    try {
      await db.execute(sql`select 1`);
      dbOk = true;
    } catch (err) {
      console.error("Health check DB probe failed:", err);
      dbOk = false;
    }
    return c.json({ ok: true, db: dbOk });
  })
  .route("/auth", createAuthRoutes({ db, env }))
  .route("/users", createUsersRoutes({ db }))
  .route("/invites", createInvitesRoutes({ db }))
  .route("/credentials", createCredentialsRoutes({ db }))
  .route("/sessions", createSessionsRoutes({ db }));

// Consumed by the Hono RPC client in apps/web. A JSDoc @typedef in a module
// is reachable cross-package as `import("@budget/api").ApiRoutes`, so web
// still pulls types only — never this file's runtime code.
/** @typedef {typeof routes} ApiRoutes */

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
