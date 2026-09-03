import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, KeyRoundIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.jsx";
import { Input } from "@/components/ui/input.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { useAuth } from "@/lib/auth.jsx";

/**
 * Where a recovery-password session lands, and the only screen it can use.
 *
 * The password exists for exactly one situation: every passkey is gone, and
 * somebody needs to get a new one registered without shell access to the box.
 * So this screen is that errand and nothing else — mint a new-device invite,
 * open it, and remove the passkey that was lost. The API enforces the same
 * boundary independently (apps/api/src/middleware/auth.js); this is what it
 * looks like from the front, not what makes it true.
 *
 * See todo.md #17 for why the password is confined rather than simply being
 * a second way in.
 */
export function RecoveryPage() {
  const { state, refresh } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [targetUserId, setTargetUserId] = useState(/** @type {string} */ (state?.user?.id ?? ""));
  const [link, setLink] = useState(/** @type {string | null} */ (null));
  const [copied, setCopied] = useState(false);

  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const res = await api.users.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).users;
    },
  });

  const credentialsQuery = useQuery({
    queryKey: ["credentials"],
    queryFn: async () => {
      const res = await api.credentials.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).credentials;
    },
  });

  const inviteMutation = useMutation({
    mutationFn: async (/** @type {string} */ userId) => {
      const res = await api.invites.$post({ json: { purpose: "new_device", targetUserId: userId } });
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).invite;
    },
    // The raw code is shown exactly once — only its hash is stored — so it
    // goes straight into a field the operator can copy rather than a toast
    // they might miss (phases/03-auth.md "Schema").
    onSuccess: (invite) => setLink(`${window.location.origin}/invite/${invite.code}`),
    onError: (err) => toast.error(err.message),
  });

  const removeCredential = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api.credentials[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credentials"] });
      toast.success("Passkey removed.");
    },
    onError: (err) => toast.error(err.message),
  });

  async function signOut() {
    await api.auth.logout.$post();
    await refresh();
    navigate({ to: "/login", replace: true });
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — select and copy the link manually.");
    }
  }

  const users = usersQuery.data ?? [];
  const credentials = credentialsQuery.data ?? [];

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-4" />
          Recovery
        </CardTitle>
        <CardDescription>
          You are signed in with the recovery password, {state?.user?.displayName}. It opens this screen and
          nothing else — create a device link, open it on the device you want to use, and register a passkey
          there. This session expires in an hour.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-text">New device link</h3>
          <div className="flex items-center gap-2">
            <Select value={targetUserId} onValueChange={setTargetUserId}>
              <SelectTrigger className="w-full" aria-label="Who the passkey is for">
                <SelectValue placeholder="Who is it for?" />
              </SelectTrigger>
              <SelectContent>
                {users.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => inviteMutation.mutate(targetUserId)}
              disabled={!targetUserId || inviteMutation.isPending}
            >
              Create
            </Button>
          </div>
          {link ? (
            <div className="flex items-center gap-2">
              <Input readOnly value={link} onFocus={(e) => e.target.select()} />
              <Button type="button" size="icon" variant="outline" onClick={copy} aria-label="Copy link">
                {copied ? <CheckIcon className="text-positive" /> : <CopyIcon />}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-text-muted">
              The link works once and expires in 24 hours. It is shown here only — it cannot be looked up again.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-text">Your passkeys</h3>
          {credentials.length === 0 ? (
            <p className="text-sm text-text-muted">None registered — the link above is how you add one.</p>
          ) : (
            <DataList>
              {credentials.map((credential) => (
                <DataListRow
                  key={credential.id}
                  primary={credential.deviceName}
                  secondary={credential.lastUsedAt ? "Used before" : "Never used"}
                  trailing={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-negative"
                      aria-label={`Remove ${credential.deviceName}`}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Remove ${credential.deviceName}?`,
                          description:
                            "That device will no longer be able to sign in. Remove a passkey you have lost, not the one you are about to create.",
                          confirmLabel: "Remove",
                        });
                        if (ok) removeCredential.mutate(credential.id);
                      }}
                    >
                      <Trash2Icon />
                    </Button>
                  }
                />
              ))}
            </DataList>
          )}
        </div>

        <Button variant="outline" onClick={signOut}>
          Sign out
        </Button>
      </CardContent>
    </Card>
  );
}
