// Shared "Variables" shape the auth middleware writes and every protected
// route reads (see middleware/auth.js and src/routes/*.js).
//
// Deliberately NOT threaded through `new Hono<AppEnv>()` anywhere — every
// app/sub-app in this codebase is a plain, ungenerified `new Hono()`.
// Parameterizing the instance itself requires casting through `unknown`
// (same situation as `hc<ApiRoutes>` in apps/web/src/lib/api.js), and doing
// that on the apps whose `.get()/.post()/.route()` chains build up
// `ApiRoutes` breaks that chain's literal-path inference — every nested
// property on the resulting RPC client degrades to a generic index
// signature, which `noUncheckedIndexedAccess` then flags as possibly
// `undefined` everywhere in apps/web. Casting only the `Context` value
// inside a handler body, via the helpers below, doesn't touch that chain at
// all: only a route's registered path and its handler's *return* value feed
// `ApiRoutes`, never how the handler happens to read `c` internally.
/** @typedef {{ Variables: { userId: string, sessionId: string } }} AppEnv */

/**
 * @param {import("hono").Context} c
 * @returns {string}
 */
export function getUserId(c) {
  return /** @type {import("hono").Context<AppEnv>} */ (c).get("userId");
}

/**
 * @param {import("hono").Context} c
 * @returns {string}
 */
export function getSessionId(c) {
  return /** @type {import("hono").Context<AppEnv>} */ (c).get("sessionId");
}

/**
 * @param {import("hono").Context} c
 * @param {{ userId: string, sessionId: string }} values
 */
export function setAuthContext(c, { userId, sessionId }) {
  const typed = /** @type {import("hono").Context<AppEnv>} */ (c);
  typed.set("userId", userId);
  typed.set("sessionId", sessionId);
}
