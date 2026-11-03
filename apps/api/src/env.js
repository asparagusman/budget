import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Why `value` can't be PUBLIC_ORIGIN, or null if it can.
 *
 * It is the address the household types — `http://budget.local` — and CORS
 * and the invite CLI's links are built from it, so a near-miss shows up as
 * requests the browser refuses or links that go nowhere. These are the
 * near-misses that actually happen. A trailing slash or an explicit default
 * port isn't one of them — the value is normalised to the bare origin below,
 * which is what the browser compares against anyway.
 *
 * Plain http:// is allowed anywhere: the app is reached only on the home
 * network, and its cookies follow the scheme (lib/session.js).
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
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "must start with http:// or https://";
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return "must be an origin only, with no path, query or #fragment";
  }
  if (url.username !== "" || url.password !== "") {
    return "must not contain a username or password";
  }
  if (url.hostname.endsWith(".")) {
    return "must not end in a dot";
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
  // Where backups are written (lib/backup.js). The api container sets this to
  // /backups, bind-mounted from infra/backups/. The default is that same
  // folder, so `pnpm dev` keeps its backups beside the compose ones; it is
  // resolved from this file's location, which only means anything when running
  // from source — a built image always has the variable set.
  BACKUP_DIR: z
    .string()
    .min(1)
    .default(() => fileURLToPath(new URL("../../../infra/backups", import.meta.url))),
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
