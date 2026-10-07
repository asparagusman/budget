import { z } from "zod";

// http:// is fine here and nowhere else: browsers treat these as secure
// contexts for WebAuthn, and local dev runs on http://localhost:5173.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/**
 * Why `value` can't be PUBLIC_ORIGIN, or null if it can.
 *
 * Every passkey is bound to this origin's hostname (the WebAuthn RP ID —
 * see lib/webauthn.js), and a near-miss doesn't fail at startup on its own:
 * it fails at the passkey prompt, with a browser error that names nothing.
 * These are the near-misses that actually happen. A trailing slash or an
 * explicit default port isn't one of them — the value is normalised to the
 * bare origin below, which is what the browser compares against anyway.
 *
 * @param {string} value
 */
export function publicOriginProblem(value) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname))) {
    return "must be https:// (http:// only for localhost or 127.0.0.1)";
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return "must be an origin only, with no path, query or #fragment";
  }
  if (url.username !== "" || url.password !== "") {
    return "must not contain a username or password";
  }
  if (url.hostname.endsWith(".")) {
    return "must not end in a dot (tailscale's DNSName does; drop it)";
  }
  return null;
}

// Validated once at startup. A silently-missing SESSION_SECRET is a
// security hole three phases later, so this fails loudly and names exactly
// which variable is wrong instead of throwing a raw connection error later.
export const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(3001),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters"),
  PUBLIC_ORIGIN: z
    .string()
    .min(1, "PUBLIC_ORIGIN is required")
    .superRefine((value, ctx) => {
      // Empty is already reported above; "is not a URL" on top says nothing.
      const problem = value === "" ? null : publicOriginProblem(value);
      if (problem) ctx.addIssue({ code: "custom", message: `"${value}" ${problem}` });
    })
    // CORS compares it to the browser's Origin header and the invite CLI
    // appends a path to it, so both need the bare origin, not what was typed.
    .transform((value) => new URL(value).origin),
  // Stamped at image build time (see apps/api/Dockerfile's APP_VERSION build
  // arg) so /health can say which build is running. Optional on purpose —
  // a `pnpm dev` API has no build to name, and refusing to start over a
  // missing version string would be absurd.
  APP_VERSION: z.string().min(1).default("dev"),
});

/** @typedef {z.infer<typeof envSchema>} Env */

/**
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {Env}
 */
export function loadEnv(source = process.env) {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    console.error("Refusing to start: invalid environment configuration.");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}
