// What happens when a session ends underneath an open tab.
//
// Auth state is fetched once and cached for the life of the page (see
// auth.jsx), and nothing re-asks it while the operator works. A session that
// hard-expires after 30 days, or is revoked from another device — removing a
// passkey or deactivating a user now ends sessions server-side — used to leave
// every screen rendering its error or empty state instead of the sign-in
// screen, with nothing on it saying why. One handler, at the transport, turns
// any 401 into "you're signed out" exactly once, however many queries were in
// flight when it happened.

/** @typedef {() => void} ExpiryListener */

/** @type {ExpiryListener | null} */
let listener = null;

/**
 * Registers what to do when a request comes back 401. One listener: main.jsx
 * owns the router and the query client, so it is the one place that can act on
 * it. Returns the unregister function.
 *
 * @param {ExpiryListener} next
 */
export function onSessionExpired(next) {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

/** Called by the fetch wrapper below; a no-op until something has registered. */
export function notifySessionExpired() {
  listener?.();
}

/**
 * The pathname of a request relative to the API base, so `/auth/state` reads
 * the same whether the API is mounted at the origin root (dev, a separate port)
 * or under a prefix such as `/api` (production, behind nginx).
 *
 * @param {RequestInfo | URL} input
 * @param {string} apiBase
 * @param {string} origin
 */
function apiRelativePath(input, apiBase, origin) {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const pathname = new URL(href, origin).pathname;
  const basePath = new URL(apiBase, origin).pathname.replace(/\/+$/, "");
  return basePath !== "" && pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname;
}

/**
 * `fetch`, reporting a 401 from anything outside `/auth/*`.
 *
 * `/auth/*` is excluded because a 401 there is an answer, not an expiry: a
 * failed passkey assertion, a wrong recovery password, the signed-out probe of
 * `/auth/state` itself. The response is always returned untouched — the
 * caller still sees its own failure — so this only adds the redirect, never
 * changes what a request resolves to.
 *
 * @param {{
 *   fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
 *   apiBase: string,
 *   origin?: string,
 *   onUnauthorized: () => void,
 * }} args `fetch` defaults to the global one, looked up per call rather than
 *   captured, so it is always called unbound from `window` (an "Illegal
 *   invocation" otherwise) and a test can stub it.
 * @returns {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>}
 */
export function withSessionExpiry({ fetch: baseFetch, apiBase, origin, onUnauthorized }) {
  return async (input, init) => {
    const res = await (baseFetch ? baseFetch(input, init) : fetch(input, init));
    if (res.status === 401) {
      const path = apiRelativePath(input, apiBase, origin ?? window.location.origin);
      if (path !== "/auth" && !path.startsWith("/auth/")) onUnauthorized();
    }
    return res;
  };
}

/**
 * Screens that need no session, where a 401 is expected rather than news: the
 * sign-in screen itself, and an invite being redeemed — possibly from a
 * browser that is signed in as someone else, whose session may lapse there.
 * Bouncing an invitee to /login would make the invite impossible to redeem.
 *
 * Not /recovery: that screen runs on a recovery session, which ends after an
 * hour, and a 401 there means exactly what it means anywhere else.
 *
 * @param {string} pathname
 */
export function isSignedOutScreen(pathname) {
  return pathname === "/login" || pathname.startsWith("/invite/");
}

/**
 * The redirect, once. Every query mounted on the screen fails at the same
 * moment when a session ends, so without the guard the operator would be sent
 * to /login — and toasted — once per query.
 *
 * Only while the app believes it is signed in: that is what makes a 401 news.
 * A visitor who never had a session (or whose cookie lapsed between visits)
 * also draws 401s — /settings is asked for before the router's own sign-in
 * check has answered — and the router sends them to /login itself; telling
 * them they've "been signed out" would be wrong.
 *
 * @param {{
 *   currentPath: () => string,
 *   isSignedIn: () => boolean,
 *   redirect: () => Promise<unknown> | void,
 * }} deps
 * @returns {() => void}
 */
export function createExpiryRedirect({ currentPath, isSignedIn, redirect }) {
  /** @type {Promise<unknown> | null} */
  let pending = null;
  return () => {
    if (pending || !isSignedIn() || isSignedOutScreen(currentPath())) return;
    pending = Promise.resolve(redirect()).finally(() => {
      pending = null;
    });
  };
}
