import { api } from "@/lib/api.js";
import { ApiUnreachableError, readApiError, withUnreachable } from "@/lib/api-error.js";

/** @import { InferResponseType } from "hono/client" */
/** @import { ImportCommitSelection, ImportDestination } from "@budget/api" */

// The importer's two endpoints, through the same typed client as everything
// else.
//
// They used to be the one exception: `hc` types a route from its zValidator,
// a multipart upload had none, and so both the request and the whole response
// shape were hand-written here — around eighty lines of typedef restating
// what the server already knew, free to drift from it silently (todo.md
// `[P11-14]`). The routes validate their multipart body now, which is all
// `hc` needed; every type below is read back off the server's own handler.
//
// The functions remain because the page wants a promise that either resolves
// with the payload or throws the API's own message, not a `Response` — and
// because `res.ok` is where the union of success and error bodies gets
// narrowed, which is worth doing once rather than at each call site.
//
// Both requests go through `withUnreachable`: offline, `fetch` rejects with
// a bare TypeError whose message is the browser's "Failed to fetch", and
// that is what the page used to print. An `ApiUnreachableError` lets it say
// what actually happened instead.

/** @typedef {InferResponseType<typeof api.import.preview.$post, 200>} ImportPreviewResponse */
/** @typedef {ImportPreviewResponse["preview"]} ImportPreview */
/** @typedef {InferResponseType<typeof api.import.commit.$post, 200>} ImportResult */
/** @typedef {ImportDestination} DestinationChoice */

/**
 * @param {File} file
 * @returns {Promise<ImportPreviewResponse>}
 */
export async function fetchImportPreview(file) {
  const res = await withUnreachable(() => api.import.preview.$post({ form: { file } }));
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/**
 * `selection` is JSON in a multipart string field: a part carries no type of
 * its own, and the workbook has to travel alongside it because commit
 * re-parses the file rather than trusting numbers that took a round trip
 * through the browser.
 *
 * @param {File} file
 * @param {ImportCommitSelection} selection
 * @returns {Promise<ImportResult>}
 */
export async function commitImport(file, selection) {
  const res = await withUnreachable(() =>
    api.import.commit.$post({
      form: { file, selection: JSON.stringify(selection) },
    }),
  );
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/**
 * What to tell the operator when either request failed. Offline gets its own
 * words — "Failed to fetch" is the browser talking to a developer — and says
 * the import did not happen, which is the thing they need to know.
 *
 * @param {unknown} err
 * @param {string} fallback
 */
export function importErrorMessage(err, fallback) {
  if (err instanceof ApiUnreachableError) {
    return "Can't reach the server, so nothing was read or imported. Check the connection, then try again.";
  }
  return err instanceof Error ? err.message : fallback;
}
