/**
 * The Postgres SQLSTATE behind an error, or null if there isn't one.
 *
 * Two things make this less obvious than it looks:
 *
 *  - node-postgres throws a plain object with a `code` property, not a class,
 *    so this is a property check rather than `instanceof`.
 *  - drizzle-orm 0.45 wraps every query failure in a `DrizzleQueryError` and
 *    hangs the real pg error off `.cause`. Reading `err.code` alone therefore
 *    finds nothing on any error that came through drizzle — which is all of
 *    them — so this walks the cause chain instead.
 *
 * @param {unknown} err
 * @returns {string | null}
 */
export function pgErrorCode(err) {
  let current = err;
  // Bounded rather than `while (current)`: a cause cycle would otherwise
  // hang the request that is already failing.
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const code = /** @type {{ code?: unknown }} */ (current).code;
    if (typeof code === "string") return code;
    current = /** @type {{ cause?: unknown }} */ (current).cause;
  }
  return null;
}

/**
 * True if `err` is a Postgres unique-violation (SQLSTATE 23505).
 *
 * Routes that guard a partial unique index (accounts.is_income_landing,
 * pay_schedules.is_primary) pre-check with a `$count` query for a friendly
 * message, same as the existing "last active user"/"last credential" guards,
 * *and* catch this to stay correct under a race — the pre-check is a nicety,
 * the database constraint is the actual guarantee (phases/README.md
 * "Database", phases/04-accounts-people.md "Constraints to enforce in the
 * database, not just the API").
 *
 * @param {unknown} err
 */
export function isUniqueViolation(err) {
  return pgErrorCode(err) === "23505";
}

/**
 * True if `err` is Postgres `undefined_table` (SQLSTATE 42P01).
 *
 * Used by the health check to tell "this database has never been migrated"
 * — a definite answer worth failing the check over — apart from a probe that
 * failed for some other reason, which is merely unknown.
 *
 * @param {unknown} err
 */
export function isUndefinedTable(err) {
  return pgErrorCode(err) === "42P01";
}
