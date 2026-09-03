import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import * as tables from "@budget/schema";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

/** @import { Db } from "@budget/schema" */

// The API's own migrations, applied to an in-process Postgres. PGlite is the
// real engine compiled to WASM, not an emulation, so `gen_random_uuid()`,
// `CREATE TYPE ... AS ENUM` and `jsonb` all behave as they do in the
// container — which is the point. A test database that disagrees with
// production about types is a test database that certifies the wrong thing.
//
// It also means these tests need nothing running: no docker, no
// DATABASE_URL, no `describe.skipIf`. That last part is the whole reason to
// prefer it over pointing at a scratch database beside the real one (todo.md
// `[P11-26]`, `[P11-15]`).
const MIGRATIONS = fileURLToPath(new URL("../../../../packages/schema/migrations", import.meta.url));

/**
 * A migrated, empty database for one test file.
 *
 * Drizzle's PGlite driver and its node-postgres driver expose the same query
 * API over the same schema, but their `PgDatabase` generics differ, so the
 * handle is asserted to `Db` once here rather than at every call site. If the
 * two ever diverge in a way that matters, it fails in the assertion's own
 * file instead of scattering casts through the tests.
 *
 * @returns {Promise<{ db: Db, close: () => Promise<void> }>}
 */
export async function createTestDb() {
  const client = new PGlite();
  const pglite = drizzle(client, { schema: tables });
  await migrate(pglite, { migrationsFolder: MIGRATIONS });
  const db = /** @type {Db} */ (/** @type {unknown} */ (pglite));
  return { db, close: () => client.close() };
}
