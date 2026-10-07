import { MIGRATION_JOURNAL, migrationTagFor } from "@budget/schema";
import { sql } from "drizzle-orm";
import { describeError, isUndefinedTable } from "./db-errors.js";

/**
 * What `/health` reports about the database's migration state. `applied` is
 * what the database has actually run; `expected` is what this build of the
 * schema package ships. When they disagree, someone restarted the API
 * without running migrations first — the single most common broken-deploy
 * shape, and the reason this is on /health at all
 * (phases/11-polish-mobile-import.md, "Update procedure: pull, rebuild,
 * migrate, restart — in that order").
 *
 * `pending` is `null`, not `0`, when the probe itself failed: "we could not
 * tell" and "nothing is pending" are different answers and a deploy check
 * must not read the first as the second.
 *
 * A database that has never been migrated is NOT that case. Drizzle's
 * bookkeeping table simply does not exist yet, which is a definite answer —
 * zero applied, everything pending — and reporting it as unknown would let
 * the very worst deployment state (an app running against an empty schema)
 * pass a health check.
 *
 * @typedef {{
 *   applied: number | null,
 *   expected: number,
 *   latest: string | null,
 *   expectedLatest: string | null,
 *   pending: number | null,
 * }} MigrationHealth
 */

const EXPECTED = MIGRATION_JOURNAL.length;
const EXPECTED_LATEST = MIGRATION_JOURNAL.at(-1)?.tag ?? null;

/**
 * Reads drizzle's own bookkeeping table. It lives in the `drizzle` schema and
 * holds `(id, hash, created_at)` where `created_at` is the journal's `when`
 * in epoch milliseconds — the only join back to a readable migration name.
 *
 * Never throws: an unreachable or unmigrated database is a state for this
 * endpoint to describe, not an error to hide behind a 500.
 *
 * @param {import("@budget/schema").Db} db
 * @returns {Promise<MigrationHealth>}
 */
export async function readMigrationHealth(db) {
  try {
    const result = await db.execute(
      sql`select count(*)::int as applied, max(created_at)::bigint as latest_when from drizzle.__drizzle_migrations`,
    );
    const row = result.rows[0];
    const applied = Number(row?.applied ?? 0);
    const latestWhen = row?.latest_when == null ? null : Number(row.latest_when);
    return {
      applied,
      expected: EXPECTED,
      latest: migrationTagFor(latestWhen),
      expectedLatest: EXPECTED_LATEST,
      pending: EXPECTED - applied,
    };
  } catch (err) {
    if (isUndefinedTable(err)) {
      return {
        applied: 0,
        expected: EXPECTED,
        latest: null,
        expectedLatest: EXPECTED_LATEST,
        pending: EXPECTED,
      };
    }
    console.error(`Migration health probe failed: ${describeError(err)}`);
    return {
      applied: null,
      expected: EXPECTED,
      latest: null,
      expectedLatest: EXPECTED_LATEST,
      pending: null,
    };
  }
}
