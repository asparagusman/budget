import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// dotenv's default lookup is relative to process.cwd(), which `pnpm -F`
// sets to this package's directory, not the repo root where .env lives.
// Resolve from this file's own location instead so it works regardless of
// invocation cwd.
loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env at the repo root and fill it in.",
  );
}

export default defineConfig({
  schema: "./src/tables/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
