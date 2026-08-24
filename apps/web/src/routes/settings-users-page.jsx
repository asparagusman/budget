import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, LogOutIcon, ShieldCheckIcon, SmartphoneIcon, TicketIcon, UsersIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Card, CardContent } from "@/components/ui/card.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";
import { Input } from "@/components/ui/input.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { useAuth } from "@/lib/auth.jsx";
import { useSettings } from "@/lib/settings.jsx";

/** @param {string} locale @param {string} iso */
function formatDateTime(locale, iso) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

/**
 * A raw invite/device link, shown once and copyable — it is never
 * retrievable again after this dialog closes (phases/03-auth.md "Schema").
 *
 * @param {{ open: boolean, onOpenChange: (open: boolean) => void, title: string, description: string, link: string }} props
 */
function ShareLinkDialog({ open, onOpenChange, title, description, link }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — select and copy the link manually.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input readOnly value={link} onFocus={(e) => e.target.select()} />
          <Button type="button" size="icon" variant="outline" onClick={copy} aria-label="Copy link">
            {copied ? <CheckIcon className="text-positive" /> : <CopyIcon />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UsersPanel() {
  const queryClient = useQueryClient();
  const [shareLink, setShareLink] = useState(/** @type {string | null} */ (null));

  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const res = await api.users.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).users;
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api.users[":id"].$patch({ param: { id }, json: { isActive: false } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success("User deactivated.");
    },
    onError: (err) => toast.error(err.message),
  });

  const inviteMutation = useMutation({
    mutationFn: async () => {
      const res = await api.invites.$post({ json: { purpose: "new_user" } });
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).invite;
    },
    onSuccess: (invite) => {
      setShareLink(`${window.location.origin}/invite/${invite.code}`);
      queryClient.invalidateQueries({ queryKey: ["invites"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const users = usersQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => inviteMutation.mutate()} disabled={inviteMutation.isPending}>
          Invite a user
        </Button>
      </div>

      {users.length === 0 ? (
        <EmptyState icon={UsersIcon} title="No users yet" description="Invite the first user." />
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-(--radius-card) bg-surface shadow-(--shadow-card) md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-text-muted">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Passkeys</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="px-4 py-3 text-text">{user.displayName}</td>
                    <td className="px-4 py-3 text-text-muted">{user.email ?? "—"}</td>
                    <td className="px-4 py-3">
                      <Badge variant={user.isActive ? "default" : "outline"}>
                        {user.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-muted">{user.credentialCount}</td>
                    <td className="px-4 py-3 text-right">
                      {user.isActive ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => deactivateMutation.mutate(user.id)}
                          disabled={deactivateMutation.isPending}
                        >
                          Deactivate
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <DataList className="md:hidden">
            {users.map((user) => (
              <DataListRow
                key={user.id}
                primary={user.displayName}
                secondary={`${user.email ?? "No email"} · ${user.credentialCount} passkey${user.credentialCount === 1 ? "" : "s"}`}
                trailing={
                  <Badge variant={user.isActive ? "default" : "outline"}>
                    {user.isActive ? "Active" : "Inactive"}
                  </Badge>
                }
              />
            ))}
          </DataList>
        </>
      )}

      <ShareLinkDialog
        open={shareLink !== null}
        onOpenChange={(open) => !open && setShareLink(null)}
        title="Invite a user"
        description="Send this link to the person you're inviting. It works once, and expires in 24 hours."
        link={shareLink ?? ""}
      />
    </div>
  );
}

function DevicesPanel() {
  const { state } = useAuth();
  const { locale } = useSettings();
  const queryClient = useQueryClient();
  const [shareLink, setShareLink] = useState(/** @type {string | null} */ (null));
  const [renaming, setRenaming] = useState(/** @type {{ id: string, deviceName: string } | null} */ (null));

  const credentialsQuery = useQuery({
    queryKey: ["credentials"],
    queryFn: async () => {
      const res = await api.credentials.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).credentials;
    },
  });

  const renameMutation = useMutation({
    mutationFn: async (/** @type {{ id: string, deviceName: string }} */ { id, deviceName }) => {
      const res = await api.credentials[":id"].$patch({ param: { id }, json: { deviceName } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credentials"] });
      setRenaming(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const removeMutation = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api.credentials[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credentials"] });
      toast.success("Device removed.");
    },
    onError: (err) => toast.error(err.message),
  });

  const addDeviceMutation = useMutation({
    mutationFn: async () => {
      const res = await api.invites.$post({
        json: { purpose: "new_device", targetUserId: /** @type {string} */ (state?.user?.id) },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).invite;
    },
    onSuccess: (invite) => setShareLink(`${window.location.origin}/invite/${invite.code}`),
    onError: (err) => toast.error(err.message),
  });

  const credentials = credentialsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => addDeviceMutation.mutate()} disabled={addDeviceMutation.isPending}>
          Add another device
        </Button>
      </div>

      {credentials.length === 0 ? (
        <EmptyState icon={SmartphoneIcon} title="No devices" description="This shouldn't happen — you're signed in with one." />
      ) : (
        <DataList>
          {credentials.map((cred) => (
            <DataListRow
              key={cred.id}
              primary={
                renaming?.id === cred.id ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      renameMutation.mutate({ id: cred.id, deviceName: renaming.deviceName });
                    }}
                  >
                    <Input
                      autoFocus
                      value={renaming.deviceName}
                      onChange={(e) => setRenaming({ id: cred.id, deviceName: e.target.value })}
                      className="h-7"
                    />
                    <Button type="submit" size="sm" disabled={renameMutation.isPending}>
                      Save
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  cred.deviceName
                )
              }
              secondary={
                cred.lastUsedAt
                  ? `Last used ${formatDateTime(locale, cred.lastUsedAt)}`
                  : `Added ${formatDateTime(locale, cred.createdAt)}`
              }
              trailing={
                renaming?.id === cred.id ? null : (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRenaming({ id: cred.id, deviceName: cred.deviceName })}
                    >
                      Rename
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-negative"
                      onClick={() => removeMutation.mutate(cred.id)}
                      disabled={removeMutation.isPending || credentials.length <= 1}
                      title={
                        credentials.length <= 1
                          ? "You can't remove your last passkey — add another device first."
                          : undefined
                      }
                    >
                      Remove
                    </Button>
                  </div>
                )
              }
            />
          ))}
        </DataList>
      )}

      <ShareLinkDialog
        open={shareLink !== null}
        onOpenChange={(open) => !open && setShareLink(null)}
        title="Add another device"
        description="Open this link on the new device to register its passkey. It works once, and expires in 24 hours."
        link={shareLink ?? ""}
      />
    </div>
  );
}

function SessionsPanel() {
  const { locale } = useSettings();
  const queryClient = useQueryClient();

  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const res = await api.sessions.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).sessions;
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api.sessions[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    onError: (err) => toast.error(err.message),
  });

  const sessions = sessionsQuery.data ?? [];
  const others = sessions.filter((s) => !s.isCurrent);

  async function revokeAllOthers() {
    await Promise.all(others.map((s) => revokeMutation.mutateAsync(s.id)));
    toast.success("Other sessions revoked.");
  }

  return (
    <div className="flex flex-col gap-4">
      {others.length > 0 ? (
        <div className="flex justify-end">
          <Button variant="outline" onClick={revokeAllOthers}>
            Revoke all other sessions
          </Button>
        </div>
      ) : null}

      {sessions.length === 0 ? (
        <EmptyState icon={ShieldCheckIcon} title="No sessions" description="This shouldn't happen — you're signed in with one." />
      ) : (
        <DataList>
          {sessions.map((s) => (
            <DataListRow
              key={s.id}
              primary={
                <span className="flex items-center gap-2">
                  {s.userAgent ?? "Unknown device"}
                  {s.isCurrent ? <Badge variant="secondary">This device</Badge> : null}
                </span>
              }
              secondary={`Last seen ${formatDateTime(locale, s.lastSeenAt)}`}
              trailing={
                s.isCurrent ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-negative"
                    onClick={() => revokeMutation.mutate(s.id)}
                    disabled={revokeMutation.isPending}
                  >
                    Revoke
                  </Button>
                )
              }
            />
          ))}
        </DataList>
      )}
    </div>
  );
}

function InvitesPanel() {
  const { locale } = useSettings();
  const queryClient = useQueryClient();

  const invitesQuery = useQuery({
    queryKey: ["invites"],
    queryFn: async () => {
      const res = await api.invites.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).invites;
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api.invites[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["invites"] }),
    onError: (err) => toast.error(err.message),
  });

  const invites = invitesQuery.data ?? [];

  return invites.length === 0 ? (
    <EmptyState
      icon={TicketIcon}
      title="No pending invites"
      description="Invites you mint from the Users or My devices tabs show up here until they're used, revoked or expire."
    />
  ) : (
    <DataList>
      {invites.map((invite) => (
        <DataListRow
          key={invite.id}
          primary={invite.purpose === "new_user" ? "New user" : "New device"}
          secondary={`Expires ${formatDateTime(locale, invite.expiresAt)}`}
          trailing={
            <Button
              size="sm"
              variant="ghost"
              className="text-negative"
              onClick={() => revokeMutation.mutate(invite.id)}
              disabled={revokeMutation.isPending}
            >
              Revoke
            </Button>
          }
        />
      ))}
    </DataList>
  );
}

export function SettingsUsersPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();

  async function signOut() {
    await api.auth.logout.$post();
    await refresh();
    navigate({ to: "/login", replace: true });
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Users, devices and sessions."
        actions={
          <Button variant="outline" onClick={signOut}>
            <LogOutIcon />
            Sign out
          </Button>
        }
      />
      <Card>
        <CardContent>
          <Tabs defaultValue="users">
            <TabsList>
              <TabsTrigger value="users">Users</TabsTrigger>
              <TabsTrigger value="devices">My devices</TabsTrigger>
              <TabsTrigger value="sessions">My sessions</TabsTrigger>
              <TabsTrigger value="invites">Pending invites</TabsTrigger>
            </TabsList>
            <TabsContent value="users">
              <UsersPanel />
            </TabsContent>
            <TabsContent value="devices">
              <DevicesPanel />
            </TabsContent>
            <TabsContent value="sessions">
              <SessionsPanel />
            </TabsContent>
            <TabsContent value="invites">
              <InvitesPanel />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </>
  );
}
