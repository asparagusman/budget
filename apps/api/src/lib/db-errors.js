import { HTTPException } from "hono/http-exception";

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

/**
 * The innermost error in `err`'s cause chain — for a failed query, the
 * node-postgres error rather than drizzle's wrapper around it. Bounded for
 * the same reason as `pgErrorCode`.
 *
 * @param {unknown} err
 * @returns {unknown}
 */
function innermostCause(err) {
  let current = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const cause = /** @type {{ cause?: unknown }} */ (current).cause;
    if (typeof cause !== "object" || cause === null) break;
    current = cause;
  }
  return current;
}

/**
 * One log line about a failed request that is safe to write to disk.
 *
 * drizzle's DrizzleQueryError carries the query's bound parameters — in this
 * app, household figures — in `params`, in its `message`, and so in its
 * `stack`. Logging the error object, or even its message, writes them out.
 * So anything wrapping another error is logged as its code plus the innermost
 * error's message: for a query, Postgres's own text, which names the column or
 * constraint (and at most the one value it rejected), never the parameter
 * list. A plain error with no cause is a bug in this codebase, and its stack
 * is what fixes it, so that is logged whole.
 *
 * @param {unknown} err
 */
export function describeError(err) {
  const code = pgErrorCode(err);
  const prefix = code === null ? "" : `[${code}] `;
  const root = innermostCause(err);
  if (typeof root !== "object" || root === null || "params" in root) {
    return `${prefix}(details withheld: the query's parameters are household data)`;
  }
  if (root === err && err instanceof Error) {
    return `${prefix}${err.stack ?? err.message}`;
  }
  const message = /** @type {{ message?: unknown }} */ (root).message;
  // A refused connection surfaces as an AggregateError with an empty
  // message; the code prefix is the useful part then.
  return `${prefix}${typeof message === "string" && message !== "" ? message : "(no message)"}`;
}

/**
 * The response for a Postgres error a request can provoke without any bug
 * being involved, or null for every other error.
 *
 * Zod validates every body, but nothing validates path params, so a
 * malformed id in a URL reaches Postgres and used to come back as a 500 —
 * "Something went wrong" for what is the caller's mistake.
 *
 * 23503 is two different mistakes. "insert or update on table … violates
 * foreign key constraint" means the row points at something that doesn't
 * exist; "update or delete on table …" means something else still points at
 * the row being removed. Matching on Postgres's message is the only way to
 * tell them apart without per-constraint knowledge, and it's stable: the
 * container runs with Postgres's default English messages.
 *
 * @param {unknown} err
 * @returns {{ status: 400 | 409, code: string, message: string } | null}
 */
export function clientDbError(err) {
  switch (pgErrorCode(err)) {
    case "22P02":
      return { status: 400, code: "invalid_id", message: "That id isn't valid." };
    case "22003":
      return { status: 400, code: "out_of_range", message: "A number is out of range." };
    case "23503": {
      const message = /** @type {{ message?: unknown }} */ (innermostCause(err)).message;
      if (typeof message === "string" && message.startsWith("update or delete on table")) {
        return {
          status: 409,
          code: "still_referenced",
          message: "Something else still uses this, so it can't be removed.",
        };
      }
      return {
        status: 400,
        code: "invalid_reference",
        message: "That refers to something that doesn't exist.",
      };
    }
    default:
      return null;
  }
}

/**
 * The API's last-resort error handler — `app.onError` in src/index.js.
 *
 * What a request got wrong answers 4xx in this API's usual error shape: a
 * request Hono itself couldn't parse (malformed JSON throws an
 * HTTPException from inside zValidator), or one of the Postgres errors in
 * `clientDbError`. Everything else is a 500. Either way the log line comes
 * from `describeError`, never the error object.
 *
 * @param {Error} err
 * @param {import("hono").Context} c
 */
export function handleAppError(err, c) {
  if (err instanceof HTTPException && err.status < 500) {
    return c.json(
      { error: { code: "invalid_request", message: err.message || "Invalid request." } },
      err.status,
    );
  }
  console.error(`${c.req.method} ${c.req.path} failed: ${describeError(err)}`);
  const mapped = clientDbError(err);
  if (mapped) {
    return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status);
  }
  return c.json({ error: { code: "internal_error", message: "Something went wrong." } }, 500);
}
