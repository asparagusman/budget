import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/lib/api.js";
import { readApiError, withUnreachable } from "@/lib/api-error.js";

/** @typedef {{ id: string, displayName: string, email: string | null }} AuthUser */
/**
 * @typedef {{
 *   needsBootstrap: boolean,
 *   user: AuthUser | null,
 *   authMethod?: import("@budget/api").SessionAuthMethod,
 * }} AuthState
 *
 * `authMethod` says HOW this browser signed in, and the app has to know
 * before it renders: a session opened with the recovery password reaches
 * only the screens that get a passkey back, so rendering the shell for one
 * would produce a wall of 403s instead of the one sentence that helps
 * (see apps/api/src/middleware/auth.js, and /recovery).
 *
 * Optional because the field is absent whenever `user` is null.
 */

/** @type {Promise<AuthState> | null} */
let statePromise = null;

async function fetchAuthState() {
  const res = await withUnreachable(() => api.auth.state.$get());
  if (!res.ok) throw new Error(await readApiError(res));
  return /** @type {Promise<AuthState>} */ (res.json());
}

/**
 * Lazily fetches and caches auth state; concurrent callers share one
 * in-flight request. Deliberately not a React hook — the router's
 * `beforeLoad` guards (see router.jsx) call this directly, outside any
 * component tree, so the redirect decision and `<AuthProvider>`'s own state
 * always agree on the same underlying fetch.
 *
 * Only *successful* state is cached. Memoising the promise itself meant a
 * single failed request — the api not up yet, one dropped connection — was
 * remembered forever: every later caller got the same rejected promise back,
 * so the app stayed broken until a full page reload no matter how quickly
 * the server recovered. Retry has to be able to actually retry.
 */
export function ensureAuthState() {
  if (!statePromise) {
    statePromise = fetchAuthState().catch((err) => {
      statePromise = null;
      throw err;
    });
  }
  return statePromise;
}

/** Forces the next `ensureAuthState()` call to hit the network again — call after bootstrap, login or logout. */
export function invalidateAuthState() {
  statePromise = null;
}

/** @typedef {{ state: AuthState | null, loading: boolean, error: Error | null, refresh: () => Promise<AuthState> }} AuthContextValue */

const AuthContext = createContext(/** @type {AuthContextValue | null} */ (null));

/** @param {{ children: import("react").ReactNode }} props */
export function AuthProvider({ children }) {
  const [state, setState] = useState(/** @type {AuthState | null} */ (null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(/** @type {Error | null} */ (null));
  const queryClient = useQueryClient();

  const refresh = useCallback(async () => {
    invalidateAuthState();
    // Rethrows on failure — callers (LoginPage, the error screen's retry)
    // handle it themselves — but a success has to clear any earlier failure,
    // or the app stays in its error state after recovering.
    const next = await ensureAuthState();
    setError(null);
    setState(next);
    // GET /settings sits behind the same auth guard as everything else, so
    // it 401s (and settles into DEFAULT_SETTINGS) whenever this fires
    // signed-out — refetch for real now that login/bootstrap/logout just
    // changed whether there's a session (see settings.jsx).
    queryClient.invalidateQueries({ queryKey: ["settings"] });
    return next;
  }, [queryClient]);

  useEffect(() => {
    let cancelled = false;
    ensureAuthState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      // Without this the rejection was unhandled: it surfaced as a bare
      // "Uncaught (in promise)" in the console, and `state` stayed null with
      // nothing anywhere recording *why* — `.finally` cleared `loading`, so
      // consumers saw "loaded, no user" and could not tell a signed-out
      // visitor from an api that never answered.
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AuthContext.Provider value={{ state, loading, error, refresh }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider.");
  return ctx;
}

/**
 * Ends this browser's session and lands on /login. Shared by the two places
 * the shell offers it — the desktop sidebar's account menu and the mobile
 * menu — so they cannot drift into signing out differently.
 */
export function useSignOut() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  return useCallback(async () => {
    await api.auth.logout.$post();
    await refresh();
    navigate({ to: "/login", replace: true });
  }, [refresh, navigate]);
}
