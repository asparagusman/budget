import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  CopyIcon,
  FileSpreadsheetIcon,
  LogOutIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  TicketIcon,
  UsersIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Card, CardContent } from "@/components/ui/card.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";
import { Input } from "@/components/ui/input.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { ReorderControls } from "@/components/reorder-controls.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { useAuth } from "@/lib/auth.jsx";
import { registerCommands } from "@/lib/commands.js";
import { moveInList } from "@/lib/reorder.js";
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
  const confirm = useConfirm();
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
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Deactivate ${user.displayName}?`,
                              description: "They lose access immediately and every session of theirs is ended.",
                              confirmLabel: "Deactivate",
                            });
                            if (ok) deactivateMutation.mutate(user.id);
                          }}
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

/**
 * The household's one recovery password.
 *
 * Passkeys are the way in, and this is not a second one: a session opened
 * with this password reaches only the screen that mints a new-device invite,
 * so the worst a phished copy of it buys an attacker is the ability to ask
 * the household for a passkey (apps/api/src/middleware/auth.js). That
 * confinement is the whole reason the app has a password at all — see
 * todo.md #17.
 *
 * It lives beside the passkey list because that is the question it answers:
 * what happens when every one of those is gone. The CLI path
 * (`pnpm auth:invite --user X --purpose new_device`) still exists and still
 * works; this is the same recovery without shell access to the box.
 */
function RecoveryPasswordPanel() {
  const confirm = useConfirm();
  const { locale } = useSettings();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [editing, setEditing] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["recovery-password-status"],
    queryFn: async () => {
      const res = await api.auth["recovery-password"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
  });

  const setMutation = useMutation({
    mutationFn: async (/** @type {string} */ next) => {
      const res = await api.auth["recovery-password"].$put({ json: { password: next } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recovery-password-status"] });
      setPassword("");
      setEditing(false);
      toast.success("Recovery password saved. Write it down somewhere that is not this app.");
    },
    onError: (err) => toast.error(err.message),
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      const res = await api.auth["recovery-password"].$delete();
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recovery-password-status"] });
      toast.success("Recovery password removed.");
    },
    onError: (err) => toast.error(err.message),
  });

  const status = statusQuery.data;
  const configured = status?.configured === true;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-text">Recovery password</h3>
        <p className="text-xs text-text-muted">
          One password, for the day every passkey is gone. It only lets you register a new passkey — it
          cannot see or change anything in the app.
        </p>
      </div>

      <div className="rounded-(--radius-card) bg-surface-muted p-4">
        <p className="text-sm text-text">
          {configured
            ? `Set by ${status?.holderDisplayName} on ${status?.setAt ? formatDateTime(locale, status.setAt) : "an unknown date"}.`
            : "Not set. Recovery currently needs shell access to the server."}
        </p>

        {editing ? (
          <form
            className="mt-3 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setMutation.mutate(password);
            }}
          >
            <FieldRow
              label="New recovery password"
              htmlFor="new-recovery-password"
              hint="At least 16 characters. Length is what matters — a passphrase beats a short password with symbols in it."
            >
              <Input
                id="new-recovery-password"
                type="password"
                autoFocus
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FieldRow>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={setMutation.isPending || password === ""}>
                {setMutation.isPending ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setPassword("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {configured ? "Replace" : "Set a recovery password"}
            </Button>
            {configured ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-negative"
                onClick={async () => {
                  const ok = await confirm({
                    title: "Remove the recovery password?",
                    description:
                      "Getting back in after losing every passkey will need shell access to the server again. Any session it opened is signed out immediately.",
                    confirmLabel: "Remove",
                  });
                  if (ok) removeMutation.mutate();
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function DevicesPanel() {
  const confirm = useConfirm();
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
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Remove ${cred.deviceName ?? "this passkey"}?`,
                          description:
                            "That device can no longer sign in. This cannot be undone — the device has to be re-registered from an invite.",
                          confirmLabel: "Remove",
                        });
                        if (ok) removeMutation.mutate(cred.id);
                      }}
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
  const confirm = useConfirm();
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
    const ok = await confirm({
      title: `Revoke ${others.length} other ${others.length === 1 ? "session" : "sessions"}?`,
      description: "Every other signed-in device is signed out. This one stays.",
      confirmLabel: "Revoke all",
    });
    if (!ok) return;
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
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Revoke this session?",
                        description: "That device is signed out and has to sign in again.",
                        confirmLabel: "Revoke",
                      });
                      if (ok) revokeMutation.mutate(s.id);
                    }}
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
  const confirm = useConfirm();
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
              onClick={async () => {
                const ok = await confirm({
                  title: "Revoke this invite?",
                  description: "The link stops working. Issue a new one if it's still needed.",
                  confirmLabel: "Revoke",
                });
                if (ok) revokeMutation.mutate(invite.id);
              }}
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

function usePeopleQuery() {
  return useQuery({
    queryKey: ["people"],
    queryFn: async () => {
      const res = await api.people.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).people;
    },
  });
}

function PeoplePanel() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(/** @type {{ id: string, name: string } | null} */ (null));
  const newNameRef = useRef(/** @type {HTMLInputElement | null} */ (null));

  const peopleQuery = usePeopleQuery();

  const createMutation = useMutation({
    mutationFn: async (/** @type {string} */ name) => {
      const res = await api.people.$post({ json: { name } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people"] });
      setNewName("");
    },
    onError: (err) => toast.error(err.message),
  });

  const renameMutation = useMutation({
    mutationFn: async (/** @type {{ id: string, name: string }} */ { id, name }) => {
      const res = await api.people[":id"].$patch({ param: { id }, json: { name } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people"] });
      setRenaming(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const archiveMutation = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api.people[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people"] });
      toast.success("Person archived.");
    },
    onError: (err) => toast.error(err.message),
  });

  // `sortOrder` has driven this list's order since phase 04 and nothing has
  // ever been able to change it (todo.md `[P04-12]`), so every row sat at the
  // column default and the list was in insertion order whether that suited
  // the household or not. The whole order goes in one request — see the
  // endpoint's own comment for why a per-row number would not have worked.
  const reorderMutation = useMutation({
    mutationFn: async (/** @type {string[]} */ ids) => {
      const res = await api.people.reorder.$post({ json: { ids } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["people"] }),
    onError: (err) => toast.error(err.message),
  });

  useEffect(
    () =>
      registerCommands([
        {
          id: "people:add",
          group: "Actions",
          label: "Add person",
          icon: UsersIcon,
          run: () => newNameRef.current?.focus(),
        },
      ]),
    [],
  );

  const people = peopleQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (newName.trim()) createMutation.mutate(newName.trim());
        }}
      >
        <Input
          ref={newNameRef}
          placeholder="Add a person…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <Button type="submit" disabled={createMutation.isPending || !newName.trim()}>
          Add
        </Button>
      </form>

      {people.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title="No people yet"
          description="Add each household member — pay schedules, and later income, all hang off a person."
        />
      ) : (
        <DataList>
          {people.map((person, index) => (
            <DataListRow
              key={person.id}
              primary={
                renaming?.id === person.id ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      renameMutation.mutate({ id: person.id, name: renaming.name });
                    }}
                  >
                    <Input
                      autoFocus
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: person.id, name: e.target.value })}
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
                  person.name
                )
              }
              trailing={
                renaming?.id === person.id ? null : (
                  <div className="flex items-center gap-1">
                    <ReorderControls
                      index={index}
                      count={people.length}
                      label={person.name}
                      disabled={reorderMutation.isPending}
                      onMove={(direction) => {
                        const next = moveInList(people, index, direction);
                        if (next !== people) reorderMutation.mutate(next.map((p) => p.id));
                      }}
                    />
                    <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: person.id, name: person.name })}>
                      Rename
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-negative"
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Archive ${person.name}?`,
                          description:
                            "They stop appearing as a bill or income owner. Everything already recorded against them is kept.",
                          confirmLabel: "Archive",
                        });
                        if (ok) archiveMutation.mutate(person.id);
                      }}
                    >
                      Archive
                    </Button>
                  </div>
                )
              }
            />
          ))}
        </DataList>
      )}
    </div>
  );
}

const ADMIN_TABS = /** @type {const} */ ([
  { value: "users", path: "/admin/users", label: "Users" },
  { value: "devices", path: "/admin/devices", label: "My devices" },
  { value: "sessions", path: "/admin/sessions", label: "My sessions" },
  { value: "invites", path: "/admin/invites", label: "Pending invites" },
  { value: "people", path: "/admin/people", label: "People" },
]);

/**
 * One page, five tabs, each with its own route so every sub-screen is
 * directly linkable — People is phase 04's; Users/Devices/Sessions/Invites
 * are phase 03's, moved here unchanged.
 *
 * This was "/settings" for phases 03–04, which was never what it held: it
 * is user and household administration, and the operator-facing preference
 * that "settings" implies (theme) now lives in the sidebar's own Settings
 * menu. Pay schedules were a sixth tab and have moved to /income, where the
 * cadence they define is actually read. Old /settings/* links redirect
 * (see router.jsx).
 */
export function AdminPage() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { refresh } = useAuth();
  const activeTab = ADMIN_TABS.find((t) => t.path === pathname)?.value ?? "users";

  async function signOut() {
    await api.auth.logout.$post();
    await refresh();
    navigate({ to: "/login", replace: true });
  }

  return (
    <>
      <PageHeader
        title="Admin"
        description="Users, devices, sessions, invites and the people in your household."
        actions={
          <>
            {/* The importer is a full-page workflow rather than a seventh
                tab — its preview is a long, deselectable list of every row
                in the workbook and does not belong inside a tabbed card. */}
            <Button asChild variant="outline">
              <Link to="/import">
                <FileSpreadsheetIcon />
                Import spreadsheet
              </Link>
            </Button>
            <Button variant="outline" onClick={signOut}>
              <LogOutIcon />
              Sign out
            </Button>
          </>
        }
      />
      <Card>
        <CardContent>
          <Tabs
            value={activeTab}
            onValueChange={(value) => {
              const tab = ADMIN_TABS.find((t) => t.value === value);
              if (tab) navigate({ to: tab.path });
            }}
          >
            <TabsList>
              {ADMIN_TABS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="users">
              <UsersPanel />
            </TabsContent>
            <TabsContent value="devices">
              <div className="flex flex-col gap-8">
                <DevicesPanel />
                <RecoveryPasswordPanel />
              </div>
            </TabsContent>
            <TabsContent value="sessions">
              <SessionsPanel />
            </TabsContent>
            <TabsContent value="invites">
              <InvitesPanel />
            </TabsContent>
            <TabsContent value="people">
              <PeoplePanel />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </>
  );
}
