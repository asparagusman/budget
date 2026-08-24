import { setAuthContext } from "../lib/app-env.js";
import { getSessionFromRequest } from "../lib/session.js";

// Public paths, allowlisted explicitly. Opt-in protection is how an
// unguarded route ships; opt-out (this list) is how it doesn't — see
// phases/03-auth.md "Guard the whole API".
const PUBLIC_PREFIXES = ["/health", "/auth"];

/**
 * @param {string} path
 */
function isPublic(path) {
  return PUBLIC_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Applied to the whole app. Every non-allowlisted route requires a live
 * session; on success it sets `userId`/`sessionId` for downstream handlers.
 * Left untyped (no explicit `MiddlewareHandler<Env>` return annotation) so
 * `app.use("*", requireAuth(db))` contextually types `c`/`next` from the
 * plain, ungenerified app it's registered on — see lib/app-env.js.
 *
 * @param {import("@budget/schema").Db} db
 */
export function requireAuth(db) {
  return async (/** @type {import("hono").Context} */ c, /** @type {import("hono").Next} */ next) => {
    if (isPublic(c.req.path)) {
      return next();
    }

    const session = await getSessionFromRequest(db, c);
    if (!session) {
      return c.json({ error: { code: "unauthenticated", message: "Sign in required." } }, 401);
    }

    setAuthContext(c, { userId: session.userId, sessionId: session.id });
    await next();
  };
}
