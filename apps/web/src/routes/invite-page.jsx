import { useEffect, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
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
import { readApiError } from "@/lib/api-error.js";
import { api } from "@/lib/api.js";
import { useAuth } from "@/lib/auth.jsx";

// Expired, consumed and unknown invites are three different problems for the
// operator to solve (ask for a new one vs. re-check the link they were
// given) — see phases/03-auth.md, so each gets its own copy rather than one
// "invalid" catch-all.
const STATUS_MESSAGES = {
  unknown: "This invite link doesn't exist. Check you copied it correctly.",
  expired: "This invite has expired. Ask whoever sent it for a new one.",
  consumed: "This invite has already been used. Ask whoever sent it for a new one.",
};

export function InvitePage() {
  // Always present on /invite/$code; `strict: false` just can't promise it.
  // An empty code reads as an unknown invite, which is what it would be.
  const code = useParams({ strict: false }).code ?? "";
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [status, setStatus] = useState(
    /** @type {'loading' | 'valid' | 'unknown' | 'expired' | 'consumed'} */ ("loading"),
  );
  const [purpose, setPurpose] = useState(/** @type {'new_user' | 'new_device' | null} */ (null));
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    let cancelled = false;
    api.auth.invite[":code"].$get({ param: { code } }).then(
      async (res) => {
        const body = await res.json();
        if (cancelled) return;
        setStatus(body.status);
        // The server only ever writes 'new_user' | 'new_device' into this
        // column (createInviteSchema enforces it on the way in) — the
        // column itself is plain `text`, so the type here is just `string`.
        setPurpose(
          body.status === "valid"
            ? /** @type {'new_user' | 'new_device'} */ (body.purpose)
            : null,
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code]);

  /** @param {import("react").FormEvent} [e] */
  async function handleRedeem(e) {
    e?.preventDefault();
    setError(null);
    if (purpose === "new_user" && !displayName.trim()) {
      setError("Enter your name.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.auth.invite[":code"].redeem.$post({
        param: { code },
        json: purpose === "new_user" ? { displayName } : {},
      });
      if (!res.ok) throw new Error(await readApiError(res));
      await refresh();
      navigate({ to: "/", replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Budget</CardTitle>
        <CardDescription>
          {status === "valid"
            ? purpose === "new_device"
              ? "This link signs this device in to your account."
              : "You've been invited."
            : "Invite"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status === "loading" ? null : status !== "valid" ? (
          <p className="text-sm text-text-muted">{STATUS_MESSAGES[status]}</p>
        ) : (
          <form onSubmit={handleRedeem} className="flex flex-col gap-4">
            {purpose === "new_user" ? (
              <FieldRow label="Your name" htmlFor="display-name">
                <Input
                  id="display-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  autoFocus
                  autoComplete="name"
                />
              </FieldRow>
            ) : null}
            {error ? <InlineError>{error}</InlineError> : null}
            <Button type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in on this device"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
