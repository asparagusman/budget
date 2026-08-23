import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createDb } from "./client.js";
import { settings } from "./tables/settings.js";

// See drizzle.config.js for why this isn't a plain `import "dotenv/config"`.
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env at the repo root and fill it in.",
  );
}

// Seed rows are infrastructure bookkeeping, never household data — no
// paydays, bills or balances belong here (see phases/README.md "The one
// rule"). Later phases append their own idempotent upserts below; this is
// the no-op stub that proves the pattern end to end.
/** @type {(typeof settings.$inferInsert)[]} */
const seedRows = [{ key: "schema_seed_version", value: 1 }];

/**
 * Takes the URL as a parameter rather than closing over it: the guard above
 * narrows `databaseUrl` to a string at the call site, but that narrowing does
 * not reach inside a function body.
 *
 * @param {string} databaseUrl
 */
async function seed(databaseUrl) {
  const db = createDb(databaseUrl);
  for (const row of seedRows) {
    await db
      .insert(settings)
      .values(row)
      .onConflictDoUpdate({ target: settings.key, set: { value: row.value } });
  }
  console.log(`Seed complete: ${seedRows.length} row(s) upserted.`);
}

seed(databaseUrl)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
