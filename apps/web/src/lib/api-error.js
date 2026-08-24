/**
 * Reads the `{ error: { message } }` shape every API error response uses
 * (see phases/README.md "API") and falls back to something generic if the
 * body isn't that shape at all (a network failure, a proxy's own HTML error
 * page, etc).
 *
 * @param {Response} res
 */
export async function readApiError(res) {
  try {
    const body = await res.json();
    return body?.error?.message || "Something went wrong.";
  } catch {
    return "Something went wrong.";
  }
}
