import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as tables from "./tables/index.js";

/**
 * Creates a Drizzle client bound to the given connection string. Callers
 * (apps/api at startup, packages/schema's own scripts) own the URL and pass
 * it in — this module never reads `process.env` itself, so it stays usable
 * from any context.
 */
/**
 * @param {string} databaseUrl
 */
export function createDb(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema: tables });
}

/** @typedef {ReturnType<typeof createDb>} Db */
