import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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

// How often a waiting device asks whether it has been let in. Someone is
// standing at the other phone, so the answer should land within a breath.
const POLL_MS = 2000;

const DEVICE_REQUEST_KEY = ["device-request", "current"];

/**
 * Centred card on the page ground (see AuthLayout). Three screens:
 *
 * - bootstrap (an empty `users` table): the household's first user, signed
 *   straight in. Driven entirely by `needsBootstrap` from the server, never a
 *   client-side flag, since bootstrap must close for good the moment the
 *   first user exists.
 * - ask to join: name this device and ask. A member on a device that's
 *   already signed in approves it (the notice on every page of the app).
 * - waiting: the code to match, until someone answers. It survives a reload —
 *   the request lives in a cookie, and this screen asks the server first.
 */
export function LoginPage() {
  const { state, loading, refresh } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [password, setPassword] = useState("");
  const [usingPassword, setUsingPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  // Set when a request this screen was waiting on stops existing without
  // being approved: someone turned it down, or it ran out.
  const [ended, setEnded] = useState(false);

  // The router's own beforeLoad (see router.jsx) already redirects away from
  // here once a session exists — <AuthProvider>'s state can lag one tick
  // behind that check, so `needsBootstrap` just falls back to `false`
  // (asking to join) rather than flashing the bootstrap form.
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
    enabled: !needsBootstrap,
  });

  const requestQuery = useQuery({
    queryKey: DEVICE_REQUEST_KEY,
    queryFn: async () => {
      const res = await api.auth["device-requests"].current.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    enabled: !loading && !needsBootstrap,
    refetchInterval: (query) => (query.state.data?.status === "pending" ? POLL_MS : false),
    // Coming back to the tab is exactly when an approval may have landed.
    refetchOnWindowFocus: true,
  });
  const current = requestQuery.data;
  const pending = current?.status === "pending" ? current.request : null;

  useEffect(() => {
    if (current?.status !== "approved") return;
    refresh()
      .then(() => navigate({ to: "/", replace: true }))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [current?.status, refresh, navigate]);

  // Pending one poll, gone the next: say so, rather than silently swapping
  // the waiting screen back to the form.
  const wasPending = useRef(false);
  useEffect(() => {
    if (current?.status === "pending") {
      wasPending.current = true;
    } else if (current?.status === "none" && wasPending.current) {
      wasPending.current = false;
      setEnded(true);
    }
  }, [current]);

  /** @param {import("react").FormEvent} e */
  function handleBootstrap(e) {
    e.preventDefault();
    if (!displayName.trim()) {
      setError("Enter your name.");
      return;
    }
    setError(null);
    setBusy(true);
    api.auth.bootstrap
      .$post({ json: { displayName } })
      .then(async (res) => {
        if (!res.ok) {
          const err = await apiErrorFrom(res);
          // Set up from another device after this screen loaded. Re-read the
          // state — the screen becomes "ask to join" — and say why.
          if (err.code === "bootstrap_closed") await refresh().catch(() => null);
          throw err;
        }
        await refresh();
        navigate({ to: "/", replace: true });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  /** @param {import("react").FormEvent} e */
  function handleAsk(e) {
    e.preventDefault();
    if (!deviceName.trim()) {
      setError("Give this device a name, so whoever approves it knows which one it is.");
      return;
    }
    setError(null);
    setEnded(false);
    setBusy(true);
    api.auth["device-requests"]
      .$post({ json: { deviceName } })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readApiError(res));
        const { request } = await res.json();
        queryClient.setQueryData(DEVICE_REQUEST_KEY, { status: "pending", request });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  function handleCancel() {
    wasPending.current = false;
    api.auth["device-requests"].current
      .$delete()
      .catch(() => null)
      .finally(() => queryClient.setQueryData(DEVICE_REQUEST_KEY, { status: "none" }));
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

  if (loading || (!needsBootstrap && requestQuery.isPending)) return null;

  if (needsBootstrap) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Budget</CardTitle>
          <CardDescription>
            Nobody is set up yet. You'll be the first member, signed in on this device. Everyone after you joins
            by asking from their own device, and you approve them.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
              {busy ? "Setting up…" : "Get started"}
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  if (pending) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Waiting for approval</CardTitle>
          <CardDescription>
            On a phone or computer that's already signed in, open Budget and approve{" "}
            <strong className="font-medium text-text">{pending.deviceName}</strong>. Check it shows this code:
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p
            className="py-2 text-center font-mono text-4xl font-semibold tracking-[0.3em] text-text"
            aria-label={`Code ${pending.code.split("").join(" ")}`}
          >
            {pending.code}
          </p>
          <p className="text-center text-xs text-text-muted" aria-live="polite">
            This screen signs in by itself once it's approved.
          </p>
          {error ? <InlineError>{error}</InlineError> : null}
          <Button type="button" variant="ghost" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Budget</CardTitle>
        <CardDescription>
          {usingPassword
            ? "The recovery password only lets you get a device approved."
            : "This device isn't signed in. Ask to join, and someone already signed in approves it."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {usingPassword ? (
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
              Back
            </Button>
          </form>
        ) : (
          <>
            {ended ? (
              <InlineError>That request was turned down or ran out. You can ask again.</InlineError>
            ) : null}
            <form onSubmit={handleAsk} className="flex flex-col gap-4">
              <FieldRow label="Name this device" htmlFor="device-name" hint="For example, Grace's phone.">
                <Input
                  id="device-name"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  autoFocus
                  autoComplete="off"
                />
              </FieldRow>
              {error ? <InlineError>{error}</InlineError> : null}
              <Button type="submit" disabled={busy}>
                {busy ? "Asking…" : "Ask to join"}
              </Button>
            </form>
            {/* Only where one is actually set: the door for the day every
                approved device is gone. */}
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
                Lost every device?
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
