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

// The transaction handle `db.transaction(async (tx) => …)` hands its
// callback. A helper that only reads — `linesForVersion`, say — should be
// callable with either, so it can be reused inside a transaction without a
// second copy; derived from `Db` rather than named from drizzle's own
// generics so it can never drift from what `createDb` actually returns.
/** @typedef {Parameters<Parameters<Db["transaction"]>[0]>[0]} Tx */
