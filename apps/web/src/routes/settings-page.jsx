import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDaysIso, projectPaydays } from "@budget/engine";
import {
  CalendarClockIcon,
  CheckIcon,
  CopyIcon,
  FileSpreadsheetIcon,
  LogOutIcon,
  PlusIcon,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Switch } from "@/components/ui/switch.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { useAuth } from "@/lib/auth.jsx";
import { registerCommands } from "@/lib/commands.js";
import { CADENCES, CADENCE_LABELS } from "@/lib/constants.js";
import { formatIsoDate, todayIso } from "@/lib/dates.js";
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

/** Shared by the People and Pay schedules panels below. */
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
          {people.map((person) => (
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
                    <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: person.id, name: person.name })}>
                      Rename
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-negative"
                      onClick={() => archiveMutation.mutate(person.id)}
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

/** @typedef {{ id: string, personId: string, anchorDate: string, cadence: import("@budget/engine").Cadence, isPrimary: boolean }} PaySchedule */
/** @typedef {{ personId: string, anchorDate: string, cadence: import("@budget/engine").Cadence, isPrimary: boolean }} PayScheduleFormData */

/**
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   schedule: PaySchedule | null,
 *   people: { id: string, name: string }[],
 *   submitting: boolean,
 *   onSubmit: (data: PayScheduleFormData) => Promise<void>,
 * }} props
 */
function PayScheduleFormDialog({ open, onOpenChange, schedule, people, submitting, onSubmit }) {
  const { locale } = useSettings();
  const [personId, setPersonId] = useState("");
  const [anchorDate, setAnchorDate] = useState(todayIso());
  const [cadence, setCadence] = useState(/** @type {import("@budget/engine").Cadence} */ ("fortnightly"));
  const [isPrimary, setIsPrimary] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setPersonId(schedule?.personId ?? people[0]?.id ?? "");
    setAnchorDate(schedule?.anchorDate ?? todayIso());
    setCadence(schedule?.cadence ?? "fortnightly");
    setIsPrimary(schedule?.isPrimary ?? false);
    setError(null);
  }, [open, schedule, people]);

  // Computed entirely client-side — @budget/engine is pure and zero-I/O, so
  // there's no reason to round-trip to the API just to preview what the
  // operator hasn't saved yet (phases/04-accounts-people.md wants this
  // preview live "as the operator types").
  const preview = useMemo(() => {
    if (!anchorDate) return [];
    try {
      return projectPaydays({ anchorDate, cadence }, { from: anchorDate, to: addDaysIso(anchorDate, 3660) }).slice(
        0,
        6,
      );
    } catch {
      return [];
    }
  }, [anchorDate, cadence]);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!schedule && !personId) {
      setError("Choose a person.");
      return;
    }
    // Always includes `personId`, even when editing — the PATCH schema
    // (zod/pay-schedules.js) has no such field, so Zod's default "strip
    // unknown keys" behaviour drops it there; one uniform shape here instead
    // of a create/update union.
    const data = { personId, anchorDate, cadence, isPrimary };
    try {
      await onSubmit(data);
      onOpenChange(false);
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{schedule ? "Edit pay schedule" : "Add pay schedule"}</DialogTitle>
          <DialogDescription>Any known payday — the rest of the series is derived from it.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {!schedule ? (
            <FieldRow label="Person" htmlFor="schedule-person">
              <Select value={personId} onValueChange={setPersonId}>
                <SelectTrigger id="schedule-person" className="w-full">
                  <SelectValue placeholder="Choose a person" />
                </SelectTrigger>
                <SelectContent>
                  {people.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          ) : null}
          <FieldRow label="Anchor date" htmlFor="schedule-anchor" hint="Any payday you know for certain.">
            <Input
              id="schedule-anchor"
              type="date"
              value={anchorDate}
              onChange={(e) => setAnchorDate(e.target.value)}
            />
          </FieldRow>
          <FieldRow label="Cadence" htmlFor="schedule-cadence">
            <Select value={cadence} onValueChange={(value) => setCadence(/** @type {import("@budget/engine").Cadence} */ (value))}>
              <SelectTrigger id="schedule-cadence" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CADENCES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CADENCE_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow
            label="Primary schedule"
            htmlFor="schedule-primary"
            hint="The schedule that defines your household's transfer cycle. Only one may be set."
          >
            <Switch id="schedule-primary" checked={isPrimary} onCheckedChange={setIsPrimary} />
          </FieldRow>
          {preview.length > 0 ? (
            <FieldRow label="Next paydays">
              <div className="flex flex-wrap gap-1.5">
                {preview.map((d) => (
                  <Badge key={d} variant="outline">
                    {formatIsoDate(d, locale)}
                  </Badge>
                ))}
              </div>
            </FieldRow>
          ) : null}
          {error ? <p className="text-sm text-negative">{error}</p> : null}
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PaySchedulesPanel() {
  const { locale } = useSettings();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(/** @type {PaySchedule | null} */ (null));

  const peopleQuery = usePeopleQuery();
  const schedulesQuery = useQuery({
    queryKey: ["pay-schedules"],
    queryFn: async () => {
      const res = await api["pay-schedules"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).paySchedules;
    },
  });

  const createMutation = useMutation({
    mutationFn: async (/** @type {PayScheduleFormData} */ data) => {
      const res = await api["pay-schedules"].$post({ json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pay-schedules"] });
      toast.success("Pay schedule added.");
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (/** @type {{ id: string, data: PayScheduleFormData }} */ { id, data }) => {
      const res = await api["pay-schedules"][":id"].$patch({ param: { id }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pay-schedules"] });
      toast.success("Pay schedule updated.");
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["pay-schedules"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pay-schedules"] });
      toast.success("Pay schedule archived.");
    },
    onError: (err) => toast.error(err.message),
  });

  useEffect(
    () =>
      registerCommands([
        {
          id: "pay-schedules:add",
          group: "Actions",
          label: "Add pay schedule",
          icon: CalendarClockIcon,
          run: () => {
            setEditing(null);
            setFormOpen(true);
          },
        },
      ]),
    [],
  );

  const people = peopleQuery.data ?? [];
  const schedules = schedulesQuery.data ?? [];

  /** @param {string} personId */
  function personName(personId) {
    return people.find((p) => p.id === personId)?.name ?? "Unknown person";
  }

  /** @param {{ anchorDate: string, cadence: import("@budget/engine").Cadence }} schedule */
  function nextPayday(schedule) {
    try {
      const from = todayIso();
      const [next] = projectPaydays(schedule, { from, to: addDaysIso(from, 400) });
      return next ?? null;
    } catch {
      return null;
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
          disabled={people.length === 0}
          title={people.length === 0 ? "Add a person first." : undefined}
        >
          <PlusIcon />
          Add pay schedule
        </Button>
      </div>

      {schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClockIcon}
          title="No pay schedules yet"
          description="Add one known payday per person — the rest of the series, including any 27-payday years, is derived from it."
        />
      ) : (
        <DataList>
          {schedules.map((schedule) => {
            const next = nextPayday(schedule);
            return (
              <DataListRow
                key={schedule.id}
                primary={
                  <span className="flex items-center gap-2">
                    {personName(schedule.personId)}
                    {schedule.isPrimary ? <Badge variant="secondary">Primary</Badge> : null}
                  </span>
                }
                secondary={`${CADENCE_LABELS[schedule.cadence]} · anchored ${formatIsoDate(schedule.anchorDate, locale)}${next ? ` · next ${formatIsoDate(next, locale)}` : ""}`}
                trailing={
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(schedule);
                        setFormOpen(true);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-negative"
                      onClick={() => archiveMutation.mutate(schedule.id)}
                    >
                      Archive
                    </Button>
                  </div>
                }
              />
            );
          })}
        </DataList>
      )}

      <PayScheduleFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        schedule={editing}
        people={people}
        submitting={createMutation.isPending || updateMutation.isPending}
        onSubmit={async (data) => {
          if (editing) {
            await updateMutation.mutateAsync({ id: editing.id, data });
          } else {
            await createMutation.mutateAsync(data);
          }
        }}
      />
    </div>
  );
}

const SETTINGS_TABS = /** @type {const} */ ([
  { value: "users", path: "/settings/users", label: "Users" },
  { value: "devices", path: "/settings/devices", label: "My devices" },
  { value: "sessions", path: "/settings/sessions", label: "My sessions" },
  { value: "invites", path: "/settings/invites", label: "Pending invites" },
  { value: "people", path: "/settings/people", label: "People" },
  { value: "pay-schedules", path: "/settings/pay-schedules", label: "Pay schedules" },
]);

/**
 * One page, six tabs, each with its own route so every sub-screen is
 * directly linkable — People and Pay schedules are the two phase 04 adds;
 * Users/Devices/Sessions/Invites are phase 03's, moved here unchanged. See
 * the "a later phase may grow a general /settings landing page" comment
 * this replaces in lib/nav.js.
 */
export function SettingsPage() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { refresh } = useAuth();
  const activeTab = SETTINGS_TABS.find((t) => t.path === pathname)?.value ?? "users";

  async function signOut() {
    await api.auth.logout.$post();
    await refresh();
    navigate({ to: "/login", replace: true });
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Users, devices, sessions, people and pay schedules."
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
              const tab = SETTINGS_TABS.find((t) => t.value === value);
              if (tab) navigate({ to: tab.path });
            }}
          >
            <TabsList>
              {SETTINGS_TABS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>
                  {tab.label}
                </TabsTrigger>
              ))}
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
            <TabsContent value="people">
              <PeoplePanel />
            </TabsContent>
            <TabsContent value="pay-schedules">
              <PaySchedulesPanel />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </>
  );
}
