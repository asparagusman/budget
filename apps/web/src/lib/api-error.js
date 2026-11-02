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

/**
 * An error response, keeping what `readApiError` throws away: the status and
 * the API's machine-readable `code`. For the few callers that act on WHICH
 * error it was — an autosave deciding whether retrying can help, a page
 * telling "no income-landing account yet" from a failed request — rather than
 * only showing the message.
 */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, code: string | null }} details
   */
  constructor(message, { status, code }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * `readApiError`, as an `ApiError` carrying the status and code.
 *
 * @param {Response} res
 */
export async function apiErrorFrom(res) {
  try {
    const body = await res.json();
    const code = body?.error?.code;
    return new ApiError(body?.error?.message || "Something went wrong.", {
      status: res.status,
      code: typeof code === "string" ? code : null,
    });
  } catch {
    return new ApiError("Something went wrong.", { status: res.status, code: null });
  }
}

/**
 * The API could not be reached at all — `fetch` rejected instead of
 * resolving, so there is no status and no body. In dev that is nearly always
 * the api dev server being down; in production it is the network.
 *
 * Kept distinct from an HTTP error response on purpose. The two need
 * different words ("can't reach the server" vs whatever the server said) and
 * different remedies, and collapsing them is why a stopped api used to
 * surface as an unexplained blank page.
 */
export class ApiUnreachableError extends Error {
  /** @param {unknown} [cause] */
  constructor(cause) {
    super("Can't reach the server.");
    this.name = "ApiUnreachableError";
    this.cause = cause;
  }
}

/**
 * Runs a request and converts the one way `fetch` signals failure by
 * rejecting — a bare TypeError, with the real reason left in the browser
 * console — into an error the UI can branch on.
 *
 * @template T
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withUnreachable(run) {
  try {
    return await run();
  } catch (err) {
    // Anything already meaningful (an abort, an error we threw ourselves)
    // passes through untouched; only a genuine transport failure is
    // reclassified.
    if (err instanceof ApiUnreachableError) throw err;
    if (err instanceof TypeError) throw new ApiUnreachableError(err);
    throw err;
  }
}
