import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DatabaseBackupIcon,
  FileSpreadsheetIcon,
  LogOutIcon,
  MoreVerticalIcon,
  SmartphoneIcon,
  UsersIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge.jsx";
import { ListSkeleton } from "@/components/loading.jsx";
import { Button } from "@/components/ui/button.jsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.jsx";
import { Input } from "@/components/ui/input.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { BackupsPanel } from "@/components/backups-panel.jsx";
import { WaitingDevicesList } from "@/components/device-approvals.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { QueryError } from "@/components/query-error.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { ReorderControls } from "@/components/reorder-controls.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { useAuth, useSignOut } from "@/lib/auth.jsx";
import { registerCommands } from "@/lib/commands.js";
import { moveInList } from "@/lib/reorder.js";
import { useSettings } from "@/lib/settings.jsx";
import { getDateFormat } from "@/lib/dates.js";
import { ScrollArea } from "@/components/scroll-area.jsx";

/** @param {string} locale @param {string} iso */
function formatDateTime(locale, iso) {
  return getDateFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

/** @typedef {{ id: string, displayName: string, email: string | null, isActive: boolean, deviceCount: number }} AdminUser */

/**
 * What can be done to one member, as menu items for the phone and as the
 * same actions as buttons on the desktop table — one list, so the two layouts
 * can't offer different things. Deactivate never appears on your own row (the
 * API refuses it: a lockout one click wide) and never on an inactive one.
 *
 * @param {{ user: AdminUser, isSelf: boolean }} args
 */
function userActions({ user, isSelf }) {
  /** @type {{ key: "deactivate" | "reactivate", label: string }[]} */
  const actions = [];
  if (!user.isActive) {
    actions.push({ key: "reactivate", label: "Reactivate" });
    return actions;
  }
  if (!isSelf) actions.push({ key: "deactivate", label: "Deactivate" });
  return actions;
}

function UsersPanel() {
  const confirm = useConfirm();
  const { state } = useAuth();
  const myId = state?.user?.id ?? null;
  const queryClient = useQueryClient();

  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const res = await api.users.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).users;
    },
  });

  const setActiveMutation = useMutation({
    mutationFn: async (/** @type {{ user: AdminUser, isActive: boolean }} */ { user, isActive }) => {
      const res = await api.users[":id"].$patch({ param: { id: user.id }, json: { isActive } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: (_result, { user, isActive }) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      // Deactivation ends their sessions and withdraws their unused invites
      // server-side, so both lists are stale the moment this lands.
      queryClient.invalidateQueries({ queryKey: ["invites"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      toast.success(
        isActive
          ? `${user.displayName} can be approved on a device again.`
          : `${user.displayName} is deactivated and signed out everywhere.`,
      );
    },
    onError: (err) => toast.error(err.message),
  });

  /**
   * @param {AdminUser} user
   * @param {"deactivate" | "reactivate"} action
   */
  async function runAction(user, action) {
    if (action === "reactivate") {
      setActiveMutation.mutate({ user, isActive: true });
      return;
    }
    const ok = await confirm({
      title: `Deactivate ${user.displayName}?`,
      description:
        "They're signed out on every device straight away, and any invite they made — or one waiting for them — is withdrawn. Reactivating them later means approving their devices again.",
      confirmLabel: "Deactivate",
    });
    if (ok) setActiveMutation.mutate({ user, isActive: false });
  }

  const busy = setActiveMutation.isPending;
  const users = usersQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* There is no "invite" button: a new person joins by asking from their
          own device, and whoever approves it chooses "someone new". */}
      <p className="text-sm text-text-muted">
        To add someone, have them open {window.location.host} on their phone and ask to join, then approve it
        and choose “Someone new to the household”.
      </p>

      <WaitingDevicesList />

      {usersQuery.isError ? (
        <QueryError error={usersQuery.error} onRetry={() => usersQuery.refetch()} what="the household's users" />
      ) : usersQuery.isLoading ? (
        <ListSkeleton rows={2} label="Loading users" />
      ) : users.length === 0 ? (
        <EmptyState icon={UsersIcon} title="No users yet" description="Approve the first device to add someone." />
      ) : (
        <>
          <ScrollArea axis="x" className="hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card) md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-text-muted">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Devices</th>
                  <th className="px-4 py-3 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="px-4 py-3 text-text">
                      {user.displayName}
                      {user.id === myId ? <span className="ml-2 text-xs text-text-subtle">you</span> : null}
                    </td>
                    <td className="px-4 py-3 text-text-muted">{user.email ?? "—"}</td>
                    <td className="px-4 py-3">
                      <Badge variant={user.isActive ? "secondary" : "outline"}>
                        {user.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-muted">{user.deviceCount}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {userActions({ user, isSelf: user.id === myId }).map((action) => (
                          <Button
                            key={action.key}
                            size="sm"
                            // Deactivate is grey like every other removal.
                            variant={action.key === "deactivate" ? "ghost" : "outline"}
                            className={action.key === "deactivate" ? "text-text-muted hover:text-text" : undefined}
                            disabled={busy}
                            onClick={() => runAction(user, action.key)}
                          >
                            {action.label}
                          </Button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>

          {/* On a phone the actions sit behind a menu on each row, so a row
              that can't fit a button still keeps Deactivate reachable. */}
          <DataList className="md:hidden">
            {users.map((user) => {
              const actions = userActions({ user, isSelf: user.id === myId });
              return (
                <DataListRow
                  key={user.id}
                  primary={user.id === myId ? `${user.displayName} (you)` : user.displayName}
                  secondary={`${user.isActive ? "Active" : "Inactive"} · ${user.deviceCount} device${user.deviceCount === 1 ? "" : "s"}${user.email ? ` · ${user.email}` : ""}`}
                  trailing={
                    actions.length === 0 ? null : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            disabled={busy}
                            aria-label={`Actions for ${user.displayName}`}
                          >
                            <MoreVerticalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {actions.map((action) => (
                            <DropdownMenuItem key={action.key} onSelect={() => runAction(user, action.key)}>
                              {action.label}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )
                  }
                />
              );
            })}
          </DataList>
        </>
      )}
    </div>
  );
}

/**
 * The household's one recovery password.
 *
 * Approved devices are the way in, and this is not a second one: a session
 * opened with this password reaches only the recovery screen, which can do
 * nothing but get a device approved (apps/api/src/middleware/auth.js). See
 * todo.md #17.
 *
 * It lives beside the device list because that is the question it answers:
 * what happens when every one of those is gone. The CLI path
 * (`node dist/scripts/auth-invite.js --user X --purpose new_device`) still
 * exists and still works; this is the same recovery without shell access to
 * the box.
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
          One password, for the day every signed-in device is gone. It only lets you sign a device back in —
          it cannot see or change anything in the app.
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
                className="text-text-muted hover:text-text"
                onClick={async () => {
                  const ok = await confirm({
                    title: "Remove the recovery password?",
                    description:
                      "Getting back in after losing every device will need shell access to the server again. Anything it signed in with is signed out immediately.",
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

/**
 * Your signed-in devices. Approving a device is what signs it in, so this
 * list is the whole of "where am I signed in": rename one, or sign out one
 * that was lost — it has to ask to join again before it can be used.
 */
function DevicesPanel() {
  const confirm = useConfirm();
  const { locale } = useSettings();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(/** @type {{ id: string, deviceName: string } | null} */ (null));

  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const res = await api.sessions.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).sessions;
    },
  });

  const renameMutation = useMutation({
    mutationFn: async (/** @type {{ id: string, deviceName: string }} */ { id, deviceName }) => {
      const res = await api.sessions[":id"].$patch({ param: { id }, json: { deviceName } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setRenaming(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const signOutMutation = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api.sessions[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const devices = (sessionsQuery.data ?? []).filter((s) => s.authMethod === "device");
  const others = devices.filter((s) => !s.isCurrent);

  async function signOutAllOthers() {
    const ok = await confirm({
      title: `Sign out ${others.length} other ${others.length === 1 ? "device" : "devices"}?`,
      description: "Each one has to ask to join again before it can be used. This one stays signed in.",
      confirmLabel: "Sign out all",
    });
    if (!ok) return;
    await Promise.all(others.map((s) => signOutMutation.mutateAsync(s.id)));
    toast.success("Other devices signed out.");
  }

  return (
    <div className="flex flex-col gap-4">
      <WaitingDevicesList />

      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="text-sm text-text-muted">
          To add a device, open {window.location.host} on it and ask to join, then approve it here or from the
          notice at the top of any page.
        </p>
        {others.length > 0 ? (
          <Button variant="outline" onClick={signOutAllOthers}>
            Sign out all other devices
          </Button>
        ) : null}
      </div>

      {sessionsQuery.isError ? (
        <QueryError error={sessionsQuery.error} onRetry={() => sessionsQuery.refetch()} what="your devices" />
      ) : sessionsQuery.isLoading ? (
        <ListSkeleton rows={2} label="Loading your devices" />
      ) : devices.length === 0 ? (
        <EmptyState icon={SmartphoneIcon} title="No devices" description="This shouldn't happen — you're signed in on one." />
      ) : (
        <DataList>
          {devices.map((device) => (
            <DataListRow
              key={device.id}
              primary={
                renaming?.id === device.id ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      renameMutation.mutate({ id: device.id, deviceName: renaming.deviceName });
                    }}
                  >
                    <Input
                      autoFocus
                      value={renaming.deviceName}
                      onChange={(e) => setRenaming({ id: device.id, deviceName: e.target.value })}
                      className="h-7"
                      aria-label="Device name"
                    />
                    <Button type="submit" size="sm" disabled={renameMutation.isPending}>
                      Save
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <span className="flex items-center gap-2">
                    {device.deviceName ?? "Unnamed device"}
                    {device.isCurrent ? <Badge variant="secondary">This device</Badge> : null}
                  </span>
                )
              }
              secondary={`Last used ${formatDateTime(locale, device.lastSeenAt)}`}
              trailing={
                renaming?.id === device.id ? null : (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRenaming({ id: device.id, deviceName: device.deviceName ?? "" })}
                    >
                      Rename
                    </Button>
                    {device.isCurrent ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-text-muted hover:text-text"
                        disabled={signOutMutation.isPending}
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Sign out ${device.deviceName ?? "this device"}?`,
                            description:
                              "It has to ask to join again, and be approved, before it can be used. Do this for a device that's lost or given away.",
                            confirmLabel: "Sign out",
                          });
                          if (ok) signOutMutation.mutate(device.id);
                        }}
                      >
                        Sign out
                      </Button>
                    )}
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

      {peopleQuery.isError ? (
        <QueryError error={peopleQuery.error} onRetry={() => peopleQuery.refetch()} what="the people in your household" />
      ) : peopleQuery.isLoading ? (
        <ListSkeleton rows={2} label="Loading people" />
      ) : people.length === 0 ? (
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
                      className="text-text-muted hover:text-text"
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
  { value: "people", path: "/admin/people", label: "People" },
  { value: "backups", path: "/admin/backups", label: "Backups" },
]);

/**
 * One page, four tabs, each with its own route so every sub-screen is
 * directly linkable — People is phase 04's; Users and My devices are phase
 * 03's, reworked for device approval (a session is a device now, and invites
 * are break-glass only, so neither keeps a tab of its own); Backups is the
 * pre-deploy plan's phase C.
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
  // The sidebar's and the phone menu's sign-out, so all three behave alike.
  const signOut = useSignOut();
  const activeTab = ADMIN_TABS.find((t) => t.path === pathname)?.value ?? "users";

  useEffect(
    () =>
      registerCommands([
        {
          id: "backups:open",
          group: "Navigation",
          label: "Backups",
          keywords: "backup restore download export",
          icon: DatabaseBackupIcon,
          run: () => navigate({ to: "/admin/backups" }),
        },
      ]),
    [navigate],
  );

  return (
    <>
      <PageHeader
        title="Admin"
        description="Users, devices, the people in your household, and backups."
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
      {/* No card around the tabs: every panel already draws its own
          surfaces (a table, a list), and inside a card each of those was a
          card in a card. */}
      <Tabs
        className="gap-4"
        value={activeTab}
        onValueChange={(value) => {
          const tab = ADMIN_TABS.find((t) => t.value === value);
          if (tab) navigate({ to: tab.path });
        }}
      >
        <TabsList className="md:self-start">
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
        <TabsContent value="people">
          <PeoplePanel />
        </TabsContent>
        <TabsContent value="backups">
          <BackupsPanel />
        </TabsContent>
      </Tabs>
    </>
  );
}
