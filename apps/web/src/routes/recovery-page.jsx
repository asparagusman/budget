import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { WaitingDevicesList } from "@/components/device-approvals.jsx";
import { InlineError } from "@/components/notice.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { useAuth } from "@/lib/auth.jsx";

/**
 * Where a recovery-password session lands, and the only screen it can use.
 *
 * The password exists for exactly one situation: every approved device is
 * gone, and somebody needs a device let in again without shell access to the
 * box. So this screen is that errand and nothing else — sign this device in
 * (as anyone in the household), approve one that's waiting, and sign out the
 * devices that were lost. The API enforces the same boundary independently
 * (apps/api/src/middleware/auth.js); this is what it looks like from the
 * front, not what makes it true.
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
  const [error, setError] = useState(/** @type {string | null} */ (null));

  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const res = await api.users.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).users;
    },
  });

  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const res = await api.sessions.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).sessions;
    },
  });

  // Ask, approve, collect — the same three steps as a device joining any
  // other way, all from here: this device asks to join, this recovery
  // session approves it, and collecting the approval swaps the hour-long
  // recovery session for an ordinary one.
  const signInHere = useMutation({
    mutationFn: async (/** @type {string} */ userId) => {
      const asked = await api.auth["device-requests"].$post({ json: { deviceName: "Recovered device" } });
      if (!asked.ok) throw new Error(await readApiError(asked));
      const { request } = await asked.json();
      const approved = await api["device-requests"][":id"].approve.$post({
        param: { id: request.id },
        json: { userId },
      });
      if (!approved.ok) throw new Error(await readApiError(approved));
      const collected = await api.auth["device-requests"].current.$get();
      if (!collected.ok) throw new Error(await readApiError(collected));
      if ((await collected.json()).status !== "approved") throw new Error("Couldn't sign this device in. Try again.");
    },
    onSuccess: async () => {
      queryClient.clear();
      await refresh();
      toast.success("This device is signed in. Rename it in Admin → My devices.");
      navigate({ to: "/", replace: true });
    },
    onError: (err) => setError(err.message),
  });

  const signOutDevice = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api.sessions[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    onError: (err) => toast.error(err.message),
  });

  async function signOut() {
    await api.auth.logout.$post();
    await refresh();
    navigate({ to: "/login", replace: true });
  }

  // Active users only: a deactivated member can't be given a device (the API
  // refuses with `inactive_user`), so offering them would only lead to an
  // error after the click.
  const users = (usersQuery.data ?? []).filter((user) => user.isActive);
  const devices = (sessionsQuery.data ?? []).filter((s) => s.authMethod === "device");

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-4" />
          Recovery
        </CardTitle>
        <CardDescription>
          You are signed in with the recovery password, {state?.user?.displayName}. It opens this screen and
          nothing else, and it expires in an hour. Sign this device in properly to use the app.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-text">Sign this device in</h3>
          <div className="flex items-center gap-2">
            <Select value={targetUserId} onValueChange={setTargetUserId}>
              <SelectTrigger className="w-full" aria-label="Whose device this is">
                <SelectValue placeholder="Whose device is it?" />
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
              onClick={() => {
                setError(null);
                signInHere.mutate(targetUserId);
              }}
              disabled={!targetUserId || signInHere.isPending}
            >
              {signInHere.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </div>
          {error ? <InlineError>{error}</InlineError> : null}
        </div>

        <WaitingDevicesList poll />

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-text">Your devices</h3>
          {devices.length === 0 ? (
            <p className="text-sm text-text-muted">None signed in.</p>
          ) : (
            <DataList>
              {devices.map((device) => (
                <DataListRow
                  key={device.id}
                  primary={device.deviceName ?? "Unnamed device"}
                  secondary={`Signed in ${new Date(device.createdAt).toLocaleDateString()}`}
                  trailing={
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-text-muted hover:text-text"
                      disabled={signOutDevice.isPending}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Sign out ${device.deviceName ?? "this device"}?`,
                          description:
                            "Sign out a device you've lost. It has to ask to join again before it can be used.",
                          confirmLabel: "Sign out",
                        });
                        if (ok) signOutDevice.mutate(device.id);
                      }}
                    >
                      Sign out
                    </Button>
                  }
                />
              ))}
            </DataList>
          )}
        </div>

        <Button variant="outline" onClick={signOut}>
          Sign out of recovery
        </Button>
      </CardContent>
    </Card>
  );
}
