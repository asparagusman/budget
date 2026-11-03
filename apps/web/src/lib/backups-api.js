import { api } from "@/lib/api.js";
import { ApiUnreachableError, readApiError, withUnreachable } from "@/lib/api-error.js";

/** @import { InferResponseType } from "hono/client" */

// The backups endpoints, through the same typed client as everything else —
// as promises that resolve with the payload or throw the API's own message,
// like import-api.js, so the panel doesn't narrow a `Response` at every call.

/** @typedef {InferResponseType<typeof api.backups.$get, 200>} BackupsResponse */
/** @typedef {BackupsResponse["backups"][number]} BackupEntry */
/** @typedef {BackupsResponse["status"]} BackupStatus */
/** @typedef {BackupEntry["kind"]} BackupKind */
/** @typedef {InferResponseType<(typeof api.backups)[":id"]["restore"]["$post"], 200>} RestoreResult */

/** @returns {Promise<BackupsResponse>} */
export async function fetchBackups() {
  const res = await withUnreachable(() => api.backups.$get());
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

export async function takeBackup() {
  const res = await withUnreachable(() => api.backups.$post());
  if (!res.ok) throw new Error(await readApiError(res));
  return (await res.json()).backup;
}

/** @param {string} id */
export async function restoreStoredBackup(id) {
  const res = await withUnreachable(() => api.backups[":id"].restore.$post({ param: { id } }));
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/** @param {File} file */
export async function restoreUploadedBackup(file) {
  const res = await withUnreachable(() => api.backups.restore.$post({ form: { file } }));
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/** @param {string} id */
export async function deleteStoredBackup(id) {
  const res = await withUnreachable(() => api.backups[":id"].$delete({ param: { id } }));
  if (!res.ok) throw new Error(await readApiError(res));
}

/**
 * Fetches the file through the client, so the session cookie goes with it, and
 * hands it to the browser as a save. A plain link to the API wouldn't work in
 * dev, where web and api are on different origins.
 *
 * @param {string} id
 */
export async function downloadBackup(id) {
  const res = await withUnreachable(() => api.backups[":id"].download.$get({ param: { id } }));
  if (!res.ok) throw new Error(await readApiError(res));
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = id;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * What to tell the operator when a request failed. Offline gets its own
 * words, and says the thing they need to know: whether anything changed.
 *
 * @param {unknown} err
 * @param {string} didNot What didn't happen, e.g. "nothing was restored".
 */
export function backupErrorMessage(err, didNot) {
  if (err instanceof ApiUnreachableError) {
    return `Can't reach the server, so ${didNot}. Check the connection, then try again.`;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
