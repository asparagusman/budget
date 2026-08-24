/**
 * Derives the WebAuthn Relying Party ID and origin from `PUBLIC_ORIGIN` —
 * never a hardcoded hostname (see phases/03-auth.md "Why passkeys are
 * viable here"). `tailscale serve` gives a stable HTTPS `*.ts.net` hostname
 * in production; locally it's `http://localhost:5173`, which browsers treat
 * as a secure context for WebAuthn even without HTTPS.
 *
 * @param {import("../env.js").Env} env
 */
export function getRpConfig(env) {
  const url = new URL(env.PUBLIC_ORIGIN);
  return {
    rpName: "Budget",
    rpID: url.hostname,
    origin: url.origin,
  };
}
