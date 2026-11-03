import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.jsx";
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
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { InlineError, Notice } from "@/components/notice.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";

/** @typedef {{ id: string, code: string, deviceName: string, createdAt: string, expiresAt: string }} WaitingDevice */

const NEW_PERSON = "__new__";

/**
 * Devices asking to be let in (see the sign-in screen). Polled while `poll`
 * is set, so a request made on the phone in someone's hand shows up on the
 * screen beside it without a reload.
 *
 * @param {{ poll?: boolean }} [options]
 */
export function useWaitingDevices({ poll = false } = {}) {
  return useQuery({
    queryKey: ["device-requests"],
    queryFn: async () => {
      const res = await api["device-requests"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {WaitingDevice[]} */ ((await res.json()).requests);
    },
    refetchInterval: poll ? 10_000 : false,
  });
}

/**
 * Approve or turn down one waiting device. The approver says whose device it
 * is — any member, or someone new to the household — and checks the code on
 * the waiting screen matches the one here, which is what tells two waiting
 * phones apart.
 *
 * @param {{ request: WaitingDevice | null, onOpenChange: (open: boolean) => void }} props
 */
export function ApproveDeviceDialog({ request, onOpenChange }) {
  const queryClient = useQueryClient();
  const [owner, setOwner] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const res = await api.users.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).users;
    },
    enabled: request !== null,
  });
  // A deactivated member can't be given a device (the API refuses with
  // `inactive_user`), so offering them would only lead to an error.
  const members = (usersQuery.data ?? []).filter((user) => user.isActive);

  function close() {
    setOwner("");
    setNewName("");
    setError(null);
    onOpenChange(false);
  }

  const approveMutation = useMutation({
    mutationFn: async () => {
      if (!request) return;
      const json = owner === NEW_PERSON ? { newUserDisplayName: newName } : { userId: owner };
      const res = await api["device-requests"][":id"].approve.$post({ param: { id: request.id }, json });
      if (!res.ok) throw new Error(await readApiError(res));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["device-requests"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success(`Approved. ${request?.deviceName ?? "The device"} signs itself in within a few seconds.`);
      close();
    },
    onError: (err) => setError(err.message),
  });

  const denyMutation = useMutation({
    mutationFn: async () => {
      if (!request) return;
      const res = await api["device-requests"][":id"].$delete({ param: { id: request.id } });
      if (!res.ok) throw new Error(await readApiError(res));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["device-requests"] });
      toast.success(`Turned down ${request?.deviceName ?? "the device"}.`);
      close();
    },
    onError: (err) => setError(err.message),
  });

  const busy = approveMutation.isPending || denyMutation.isPending;
  const ready = owner !== "" && (owner !== NEW_PERSON || newName.trim() !== "");

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Let {request?.deviceName ?? "this device"} in?</DialogTitle>
          <DialogDescription>
            Check the waiting screen shows the same code. Once approved, that device stays signed in until it's
            signed out from Admin → My devices.
          </DialogDescription>
        </DialogHeader>
        <p className="text-center font-mono text-3xl font-semibold tracking-[0.3em] text-text" aria-label="Code">
          {request?.code}
        </p>
        <form
          id="approve-device"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) approveMutation.mutate();
          }}
        >
          <FieldRow label="Whose device is it?" htmlFor="device-owner">
            <Select value={owner} onValueChange={setOwner}>
              <SelectTrigger id="device-owner" className="w-full">
                <SelectValue placeholder="Choose a person" />
              </SelectTrigger>
              <SelectContent>
                {members.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.displayName}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_PERSON}>Someone new to the household</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          {owner === NEW_PERSON ? (
            <FieldRow label="Their name" htmlFor="new-member-name">
              <Input
                id="new-member-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoComplete="off"
                autoFocus
              />
            </FieldRow>
          ) : null}
          {error ? <InlineError>{error}</InlineError> : null}
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className="text-text-muted hover:text-text"
            onClick={() => denyMutation.mutate()}
            disabled={busy}
          >
            Turn down
          </Button>
          <Button type="submit" form="approve-device" disabled={busy || !ready}>
            {approveMutation.isPending ? "Approving…" : "Approve"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The waiting devices as a list, each opening the approval dialog. Renders
 * nothing when no one is waiting.
 *
 * @param {{ poll?: boolean }} props
 */
export function WaitingDevicesList({ poll = false }) {
  const waitingQuery = useWaitingDevices({ poll });
  const [reviewing, setReviewing] = useState(/** @type {WaitingDevice | null} */ (null));
  const waiting = waitingQuery.data ?? [];
  if (waiting.length === 0) return null;

  return (
    <section className="flex flex-col gap-2" aria-labelledby="waiting-devices-heading">
      <h3 id="waiting-devices-heading" className="text-sm font-semibold text-text">
        Waiting to join
      </h3>
      <DataList>
        {waiting.map((request) => (
          <DataListRow
            key={request.id}
            primary={request.deviceName}
            secondary={`Code ${request.code}`}
            trailing={
              <Button size="sm" onClick={() => setReviewing(request)}>
                Review
              </Button>
            }
          />
        ))}
      </DataList>
      <ApproveDeviceDialog request={reviewing} onOpenChange={(open) => !open && setReviewing(null)} />
    </section>
  );
}

/**
 * The app-wide nudge: a device somewhere in the house is waiting for someone
 * signed in to let it in. Shown on every page, because the approver is
 * whoever is holding a signed-in phone, wherever in the app they are.
 */
export function WaitingDevicesNotice() {
  const waitingQuery = useWaitingDevices({ poll: true });
  const [reviewing, setReviewing] = useState(/** @type {WaitingDevice | null} */ (null));
  const waiting = waitingQuery.data ?? [];
  if (waiting.length === 0) return null;

  return (
    <div className="mb-6 flex flex-col gap-2 md:mb-8">
      {waiting.map((request) => (
        <Notice key={request.id}>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p>
              <strong className="font-medium">{request.deviceName}</strong> is asking to join · code{" "}
              <span className="font-mono">{request.code}</span>
            </p>
            <Button size="sm" variant="outline" onClick={() => setReviewing(request)}>
              Review
            </Button>
          </div>
        </Notice>
      ))}
      <ApproveDeviceDialog request={reviewing} onOpenChange={(open) => !open && setReviewing(null)} />
    </div>
  );
}
