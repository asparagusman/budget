import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";

export { browserSupportsWebAuthn, startAuthentication, startRegistration };

/**
 * The server's Zod schema deliberately treats a WebAuthn response as an
 * opaque passthrough object — shaped by the authenticator, not by us (see
 * `registerVerifySchema`/`loginVerifySchema` in packages/schema/src/zod/
 * auth.js) — so the RPC client's request type is a loose record, not
 * `RegistrationResponseJSON`/`AuthenticationResponseJSON`. This is the one
 * place that crosses from the browser SDK's concrete type into that opaque
 * shape.
 *
 * @param {import("@simplewebauthn/browser").RegistrationResponseJSON | import("@simplewebauthn/browser").AuthenticationResponseJSON} response
 */
export function toJsonBody(response) {
  return /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (response));
}

/** @param {import("@simplewebauthn/browser").WebAuthnError} err */
function describeWebAuthnError(err) {
  switch (err.code) {
    case "ERROR_CEREMONY_ABORTED":
      return "Cancelled.";
    case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
      return "This passkey is already registered on this device.";
    case "ERROR_INVALID_DOMAIN":
    case "ERROR_INVALID_RP_ID":
      return "This device can't reach the right address for passkeys — check you're using the app's usual address.";
    default:
      return "No passkey found, or the request was cancelled.";
  }
}

/**
 * A single place to turn "whatever a passkey attempt threw" into a message
 * fit for the error states the login/invite screens need — browser-side
 * WebAuthn failures (cancelled, no passkey found, unsupported browser) go
 * through `describeWebAuthnError`; anything else (an API error we already
 * threw with a server-provided message) just surfaces that message as-is.
 *
 * @param {unknown} err
 */
export function toErrorMessage(err) {
  if (err instanceof WebAuthnError) return describeWebAuthnError(err);
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}
