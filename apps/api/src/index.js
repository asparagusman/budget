import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createDb } from "@budget/schema";
import { config as loadDotenv } from "dotenv";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { loadEnv } from "./env.js";

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

const routes = app.get("/health", async (c) => {
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch (err) {
    console.error("Health check DB probe failed:", err);
    dbOk = false;
  }
  return c.json({ ok: true, db: dbOk });
});

// Consumed by the Hono RPC client in apps/web. A JSDoc @typedef in a module
// is reachable cross-package as `import("@budget/api").ApiRoutes`, so web
// still pulls types only — never this file's runtime code.
/** @typedef {typeof routes} ApiRoutes */

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
