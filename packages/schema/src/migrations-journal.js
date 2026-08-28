// drizzle-kit writes this file on every `pnpm db:generate`; importing it at
// build time is what lets /health name the migration it expects rather than
// reporting an opaque SHA. A runtime `fs.readFile` would not survive tsup's
// single-file bundle (there is no migrations/ directory in the API image),
// so this has to be a static import.
import journal from "../migrations/meta/_journal.json" with { type: "json" };

/** @typedef {{ idx: number, tag: string, when: number }} MigrationEntry */

/** Every migration this build of the schema package knows about, in order. */
/** @type {MigrationEntry[]} */
export const MIGRATION_JOURNAL = journal.entries.map((entry) => ({
  idx: entry.idx,
  tag: entry.tag,
  when: entry.when,
}));

/**
 * The tag drizzle-kit gave the migration created at `when`. Drizzle's
 * `drizzle.__drizzle_migrations` table stores only a hash and this epoch-ms
 * timestamp, so the journal is the only way back to a readable name.
 *
 * @param {number | null} when
 */
export function migrationTagFor(when) {
  if (when == null) return null;
  return MIGRATION_JOURNAL.find((entry) => entry.when === when)?.tag ?? null;
}
