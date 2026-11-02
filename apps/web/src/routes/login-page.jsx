import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button.jsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { InlineError } from "@/components/notice.jsx";
import { Input } from "@/components/ui/input.jsx";
import { apiErrorFrom, readApiError } from "@/lib/api-error.js";
import { api } from "@/lib/api.js";
import { useAuth } from "@/lib/auth.jsx";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  toErrorMessage,
  toJsonBody,
} from "@/lib/passkey.js";

// The API's own wording for a bootstrap that lost the race (auth.js,
// `bootstrap_closed`), reused when the race is lost one step earlier.
const BOOTSTRAP_CLOSED_MESSAGE = "This household is already set up. Ask a member for an invite.";

/**
 * Centred card on the page ground (see AuthLayout). Bootstrap — an empty
 * `users` table — shows the one-time setup form instead of the sign-in
 * button; that switch is driven entirely by `needsBootstrap` from the
 * server, never a client-side flag, since bootstrap must close permanently
 * the moment the first user exists.
 */
export function LoginPage() {
  const { state, loading, refresh } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [usingPassword, setUsingPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  // The router's own beforeLoad (see router.jsx) already redirects away from
  // here once a session exists — <AuthProvider>'s state can lag one tick
  // behind that check, so `needsBootstrap` just falls back to `false`
  // (sign-in) rather than flashing the bootstrap form.
  const needsBootstrap = state?.needsBootstrap ?? false;

  // Whether the household has a recovery password at all. Public, and it
  // says nothing a sign-in screen could not already infer — but the
  // affordance has to know whether to offer itself, and offering a way in
  // that does not exist is worse than not offering one.
  const recoveryQuery = useQuery({
    queryKey: ["recovery-password-status"],
    queryFn: async () => {
      const res = await api.auth["recovery-password"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
  });

  async function withPasskeyGuard(/** @type {() => Promise<void>} */ run) {
    setError(null);
    if (!browserSupportsWebAuthn()) {
      setError("This browser doesn't support passkeys.");
      return;
    }
    setBusy(true);
    try {
      await run();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /** @param {import("react").FormEvent} e */
  function handleRecoveryLogin(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    api.auth.login.password
      .$post({ json: { password } })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readApiError(res));
        await refresh();
        // Never "/" — a recovery session can reach nothing behind the app
        // shell (see router.jsx and the API's own guard).
        navigate({ to: "/recovery", replace: true });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  /** @param {import("react").FormEvent} e */
  function handleBootstrap(e) {
    e.preventDefault();
    if (!displayName.trim()) {
      setError("Enter a display name.");
      return;
    }
    withPasskeyGuard(async () => {
      const optionsRes = await api.auth.register.options.$post({ json: { displayName } });
      if (!optionsRes.ok) {
        const err = await apiErrorFrom(optionsRes);
        // The household was set up from another browser after this screen
        // loaded, so the server now wants an invite this form can't send.
        // Re-read the state — the screen becomes sign-in — and say why,
        // rather than "An invite code is required." on a form with no
        // field for one.
        const next = await refresh().catch(() => null);
        throw next && !next.needsBootstrap ? new Error(BOOTSTRAP_CLOSED_MESSAGE) : err;
      }
      const { flowId, options } = await optionsRes.json();
      const response = await startRegistration({ optionsJSON: options });
      const verifyRes = await api.auth.register.verify.$post({
        json: { flowId, response: toJsonBody(response) },
      });
      if (!verifyRes.ok) {
        const err = await apiErrorFrom(verifyRes);
        // Someone else's bootstrap reached /verify first. Their message says
        // what happened; the refresh swaps this form for sign-in so the
        // screen stops offering a setup that is closed.
        if (err.code === "bootstrap_closed") await refresh().catch(() => null);
        throw err;
      }
      await refresh();
      navigate({ to: "/", replace: true });
    });
  }

  function handleSignIn() {
    withPasskeyGuard(async () => {
      const optionsRes = await api.auth.login.options.$post();
      if (!optionsRes.ok) throw new Error(await readApiError(optionsRes));
      const { flowId, options } = await optionsRes.json();
      const response = await startAuthentication({ optionsJSON: options });
      const verifyRes = await api.auth.login.verify.$post({
        json: { flowId, response: toJsonBody(response) },
      });
      if (!verifyRes.ok) throw new Error(await readApiError(verifyRes));
      await refresh();
      navigate({ to: "/", replace: true });
    });
  }

  if (loading) return null;

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Budget</CardTitle>
        <CardDescription>
          {needsBootstrap
            ? "Set up the first passkey to get started."
            : usingPassword
              ? "The recovery password only lets you register a new passkey."
              : "Sign in with your passkey."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {needsBootstrap ? (
          <form onSubmit={handleBootstrap} className="flex flex-col gap-4">
            <FieldRow label="Your name" htmlFor="display-name">
              <Input
                id="display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoFocus
                autoComplete="name"
              />
            </FieldRow>
            {error ? <InlineError>{error}</InlineError> : null}
            <Button type="submit" disabled={busy}>
              {busy ? "Setting up…" : "Create passkey"}
            </Button>
          </form>
        ) : usingPassword ? (
          <form onSubmit={handleRecoveryLogin} className="flex flex-col gap-4">
            <FieldRow label="Recovery password" htmlFor="recovery-password">
              <Input
                id="recovery-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete="current-password"
              />
            </FieldRow>
            {error ? <InlineError>{error}</InlineError> : null}
            <Button type="submit" disabled={busy || password === ""}>
              {busy ? "Signing in…" : "Continue"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setUsingPassword(false);
                setPassword("");
                setError(null);
              }}
            >
              Back to passkey
            </Button>
          </form>
        ) : (
          <>
            {error ? <InlineError>{error}</InlineError> : null}
            <Button onClick={handleSignIn} disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
            {/* Only where one is actually set. Passkeys stay the way in;
                this is the door for the day they are all gone. */}
            {recoveryQuery.data?.configured ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setUsingPassword(true);
                  setError(null);
                }}
              >
                Lost every passkey?
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
