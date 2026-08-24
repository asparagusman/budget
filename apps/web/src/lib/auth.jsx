import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "@/lib/api.js";

/** @typedef {{ id: string, displayName: string, email: string | null }} AuthUser */
/** @typedef {{ needsBootstrap: boolean, user: AuthUser | null }} AuthState */

/** @type {Promise<AuthState> | null} */
let statePromise = null;

async function fetchAuthState() {
  const res = await api.auth.state.$get();
  if (!res.ok) throw new Error("Failed to load auth state.");
  return /** @type {Promise<AuthState>} */ (res.json());
}

/**
 * Lazily fetches and caches auth state; concurrent callers share one
 * in-flight request. Deliberately not a React hook — the router's
 * `beforeLoad` guards (see router.jsx) call this directly, outside any
 * component tree, so the redirect decision and `<AuthProvider>`'s own state
 * always agree on the same underlying fetch.
 */
export function ensureAuthState() {
  if (!statePromise) statePromise = fetchAuthState();
  return statePromise;
}

/** Forces the next `ensureAuthState()` call to hit the network again — call after bootstrap, login or logout. */
export function invalidateAuthState() {
  statePromise = null;
}

/** @typedef {{ state: AuthState | null, loading: boolean, refresh: () => Promise<AuthState> }} AuthContextValue */

const AuthContext = createContext(/** @type {AuthContextValue | null} */ (null));

/** @param {{ children: import("react").ReactNode }} props */
export function AuthProvider({ children }) {
  const [state, setState] = useState(/** @type {AuthState | null} */ (null));
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    invalidateAuthState();
    const next = await ensureAuthState();
    setState(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    ensureAuthState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <AuthContext.Provider value={{ state, loading, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider.");
  return ctx;
}
