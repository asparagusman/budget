import { useState } from "react";
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
import { Input } from "@/components/ui/input.jsx";
import { readApiError } from "@/lib/api-error.js";
import { api } from "@/lib/api.js";
import { useAuth } from "@/lib/auth.jsx";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  toErrorMessage,
  toJsonBody,
} from "@/lib/passkey.js";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  // The router's own beforeLoad (see router.jsx) already redirects away from
  // here once a session exists — <AuthProvider>'s state can lag one tick
  // behind that check, so `needsBootstrap` just falls back to `false`
  // (sign-in) rather than flashing the bootstrap form.
  const needsBootstrap = state?.needsBootstrap ?? false;

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
  function handleBootstrap(e) {
    e.preventDefault();
    if (!displayName.trim()) {
      setError("Enter a display name.");
      return;
    }
    withPasskeyGuard(async () => {
      const optionsRes = await api.auth.register.options.$post({ json: { displayName } });
      if (!optionsRes.ok) throw new Error(await readApiError(optionsRes));
      const { flowId, options } = await optionsRes.json();
      const response = await startRegistration({ optionsJSON: options });
      const verifyRes = await api.auth.register.verify.$post({
        json: { flowId, response: toJsonBody(response) },
      });
      if (!verifyRes.ok) throw new Error(await readApiError(verifyRes));
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
            {error ? <p className="text-sm text-negative">{error}</p> : null}
            <Button type="submit" disabled={busy}>
              {busy ? "Setting up…" : "Create passkey"}
            </Button>
          </form>
        ) : (
          <>
            {error ? <p className="text-sm text-negative">{error}</p> : null}
            <Button onClick={handleSignIn} disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
