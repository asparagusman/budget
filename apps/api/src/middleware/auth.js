import { setAuthContext } from "../lib/app-env.js";
import { getSessionFromRequest } from "../lib/session.js";

// Public paths, allowlisted explicitly. Opt-in protection is how an
// unguarded route ships; opt-out (this list) is how it doesn't — see
// phases/03-auth.md "Guard the whole API".
const PUBLIC_PREFIXES = ["/health", "/auth"];

// What a session opened with the RECOVERY PASSWORD may reach. Everything
// else — every screen with a figure on it, and every write to one — answers
// 403 to it.
//
// The list is exactly the path back to a passkey: see who the household's
// users are, mint a `new_device` invite, remove the passkey that was lost,
// and revoke sessions. That confinement is the whole reason a password
// exists here at all. Passwords are phishable and passkeys are not, so the
// answer to "we need a way in when the passkeys are gone" is a credential
// that can only ever produce another passkey — never a transfer, never an
// allocation, never a balance (todo.md #17).
//
// GET-only on /users: a recovery session picks a target for the invite, it
// does not deactivate anyone.
/** @type {{ prefix: string, methods?: string[] }[]} */
const RECOVERY_ALLOWED = [
  { prefix: "/invites" },
  { prefix: "/credentials" },
  { prefix: "/sessions" },
  { prefix: "/users", methods: ["GET"] },
];

/**
 * @param {string} path
 */
function isPublic(path) {
  return PUBLIC_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * @param {string} path
 * @param {string} method
 */
export function isRecoveryAllowed(path, method) {
  return RECOVERY_ALLOWED.some(
    (rule) =>
      (path === rule.prefix || path.startsWith(`${rule.prefix}/`)) &&
      (!rule.methods || rule.methods.includes(method)),
  );
}

/**
 * Applied to the whole app. Every non-allowlisted route requires a live
 * session belonging to an active user (getSessionFromRequest refuses a
 * deactivated user's); on success it sets `userId`/`sessionId` for
 * downstream handlers.
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

    if (session.authMethod === "recovery_password" && !isRecoveryAllowed(c.req.path, c.req.method)) {
      return c.json(
        {
          error: {
            code: "recovery_session_limited",
            message: "You are signed in with the recovery password. Add a passkey to use the app.",
          },
        },
        403,
      );
    }

    setAuthContext(c, { userId: session.userId, sessionId: session.id });
    await next();
  };
}
