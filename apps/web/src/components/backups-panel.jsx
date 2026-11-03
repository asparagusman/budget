import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackupIcon, MoreVerticalIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.jsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { ListSkeleton } from "@/components/loading.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { Notice } from "@/components/notice.jsx";
import { QueryError } from "@/components/query-error.jsx";
import {
  backupErrorMessage,
  deleteStoredBackup,
  downloadBackup,
  fetchBackups,
  restoreStoredBackup,
  restoreUploadedBackup,
  takeBackup,
} from "@/lib/backups-api.js";
import {
  BACKUP_KIND_LABELS,
  describeBackupStatus,
  formatBackupWhen,
  formatBytes,
  restoreConfirmText,
} from "@/lib/backups.js";
import { registerCommands } from "@/lib/commands.js";
import { useSettings } from "@/lib/settings.jsx";

/** @import { BackupEntry } from "@/lib/backups-api.js" */

/**
 * Admin → Backups: the app's own backups (infra/README.md "Backups").
 *
 * The API takes the weekly ones; this shows how they are going, takes one on
 * demand, and is where a restore happens — from a stored backup, or from a
 * file downloaded earlier, which is how a fresh host gets its data back.
 */
export function BackupsPanel() {
  const confirm = useConfirm();
  const { locale } = useSettings();
  const queryClient = useQueryClient();
  const fileInput = useRef(/** @type {HTMLInputElement | null} */ (null));

  const backupsQuery = useQuery({ queryKey: ["backups"], queryFn: fetchBackups });

  const backUpMutation = useMutation({
    mutationFn: takeBackup,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["backups"] });
      toast.success("Backed up.");
    },
    onError: (err) => toast.error(backupErrorMessage(err, "no backup was taken")),
  });

  // Every query, not just this tab's: a restore replaces the figures on every
  // screen, and any of them still cached would be showing what is now gone.
  const restoreMutation = useMutation({
    mutationFn: (/** @type {{ id: string } | { file: File }} */ source) =>
      "id" in source ? restoreStoredBackup(source.id) : restoreUploadedBackup(source.file),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      toast.success(`Restored the backup from ${formatBackupWhen(locale, result.restored.takenAt)}.`);
    },
    onError: (err) => toast.error(backupErrorMessage(err, "nothing was restored")),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteStoredBackup,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["backups"] });
      toast.success("Backup deleted.");
    },
    onError: (err) => toast.error(backupErrorMessage(err, "nothing was deleted")),
  });

  const downloadMutation = useMutation({
    mutationFn: downloadBackup,
    onError: (err) => toast.error(backupErrorMessage(err, "nothing was downloaded")),
  });

  useEffect(
    () =>
      registerCommands([
        {
          id: "backups:now",
          group: "Actions",
          label: "Back up now",
          keywords: "backup save copy export",
          icon: DatabaseBackupIcon,
          run: () => backUpMutation.mutate(),
        },
      ]),
    // `mutate` is stable; the mutation object is not, and re-registering on
    // every status change would rebuild the palette's list for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** @param {BackupEntry} backup */
  async function restoreStored(backup) {
    const ok = await confirm({
      ...restoreConfirmText(`the backup from ${formatBackupWhen(locale, backup.takenAt)}`),
      confirmLabel: "Restore",
    });
    if (ok) restoreMutation.mutate({ id: backup.id });
  }

  /** @param {File} file */
  async function restoreFile(file) {
    const ok = await confirm({ ...restoreConfirmText(`the backup in ${file.name}`), confirmLabel: "Restore" });
    if (ok) restoreMutation.mutate({ file });
  }

  /** @param {BackupEntry} backup */
  async function deleteStored(backup) {
    const ok = await confirm({
      title: `Delete the backup from ${formatBackupWhen(locale, backup.takenAt)}?`,
      description: "The file is removed from the server and can't be brought back. Download it first if you might need it.",
      confirmLabel: "Delete backup",
    });
    if (ok) deleteMutation.mutate(backup.id);
  }

  const busy =
    backUpMutation.isPending || restoreMutation.isPending || deleteMutation.isPending || downloadMutation.isPending;
  const data = backupsQuery.data;
  const failed = data?.status.lastAttempt && !data.status.lastAttempt.ok ? data.status.lastAttempt : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-text-muted">
          {data ? describeBackupStatus(data.status, new Date()) : backupsQuery.isLoading ? "Loading…" : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          {/* Visually replaced by the Button beside it, but kept in the tab
              order and named, like the importer's. */}
          <input
            ref={fileInput}
            type="file"
            aria-label="Backup file (.json.gz)"
            accept=".gz,application/gzip,application/x-gzip"
            className="sr-only"
            onChange={(e) => {
              const next = e.target.files?.[0];
              // Cleared straight away so choosing the same file again, after
              // a failure, still fires `change`.
              e.target.value = "";
              if (next) restoreFile(next);
            }}
          />
          <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={busy}>
            <UploadIcon aria-hidden="true" />
            Restore from file…
          </Button>
          <Button onClick={() => backUpMutation.mutate()} disabled={busy}>
            {backUpMutation.isPending ? "Backing up…" : "Back up now"}
          </Button>
        </div>
      </div>

      {failed ? (
        <Notice kind="error">
          <p className="font-medium">The last backup didn't work.</p>
          <p className="mt-0.5 text-text-muted">
            {formatBackupWhen(locale, failed.at)}: {failed.error ?? "No reason was given."} Backups already on the
            server are untouched.
          </p>
        </Notice>
      ) : null}

      {backupsQuery.isError ? (
        <QueryError error={backupsQuery.error} onRetry={() => backupsQuery.refetch()} what="your backups" />
      ) : backupsQuery.isLoading ? (
        <ListSkeleton rows={3} label="Loading backups" />
      ) : data && data.backups.length === 0 ? (
        <EmptyState
          icon={DatabaseBackupIcon}
          title="No backups yet"
          description="The server takes one every week, and before every restore and import. Back up now takes one straight away."
        />
      ) : (
        <DataList>
          {data?.backups.map((backup) => (
            <DataListRow
              key={backup.id}
              primary={formatBackupWhen(locale, backup.takenAt)}
              secondary={`${BACKUP_KIND_LABELS[backup.kind]} · ${formatBytes(backup.sizeBytes)}`}
              trailing={
                <>
                  <div className="hidden items-center gap-1 md:flex">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => downloadMutation.mutate(backup.id)}>
                      Download
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => restoreStored(backup)}>
                      Restore
                    </Button>
                    {/* Grey like every other removal. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-text-muted hover:text-text"
                      disabled={busy}
                      onClick={() => deleteStored(backup)}
                    >
                      Delete
                    </Button>
                  </div>
                  {/* Three buttons beside a date and a size don't fit 375px,
                      so on a phone they sit behind a menu on the row. */}
                  <div className="md:hidden">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={busy}
                          aria-label={`Actions for the backup from ${formatBackupWhen(locale, backup.takenAt)}`}
                        >
                          <MoreVerticalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => downloadMutation.mutate(backup.id)}>Download</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => restoreStored(backup)}>Restore</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => deleteStored(backup)}>Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </>
              }
            />
          ))}
        </DataList>
      )}
    </div>
  );
}
