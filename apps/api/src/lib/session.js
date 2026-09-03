import { createHash, randomBytes } from "node:crypto";
import { sessions } from "@budget/schema";
import { eq } from "drizzle-orm";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export const SESSION_COOKIE = "budget_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// A recovery session lives hours, not a month. It exists to get a passkey
// back onto a device; anything still open the next morning is a password
// session nobody is watching.
const RECOVERY_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const TOUCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** @param {string} token */
function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Only the SHA-256 hash of the token is ever persisted — a database dump
 * grants no access on its own (phases/03-auth.md "Schema").
 *
 * `authMethod` is stored rather than inferred later: it decides what the
 * session is allowed to reach on EVERY request, not just at sign-in (see
 * middleware/auth.js), and a recovery session that forgot how it was opened
 * would quietly become a full one.
 *
 * @param {import("@budget/schema").Db} db
 * @param {{
 *   userId: string,
 *   userAgent: string | undefined,
 *   authMethod?: import("@budget/schema").SessionAuthMethod,
 * }} params
 */
export async function createSession(db, { userId, userAgent, authMethod = "passkey" }) {
  const token = randomBytes(32).toString("base64url");
  const [session] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      authMethod,
      userAgent: userAgent ?? null,
      expiresAt: new Date(Date.now() + sessionTtlMs(authMethod)),
    })
    .returning();
  return { token, session: /** @type {typeof sessions.$inferSelect} */ (session) };
}

/**
 * How long the cookie for a session opened this way should live.
 *
 * @param {import("@budget/schema").SessionAuthMethod} authMethod
 */
export function sessionTtlMs(authMethod) {
  return authMethod === "recovery_password" ? RECOVERY_SESSION_TTL_MS : SESSION_TTL_MS;
}

/**
 * @param {import("hono").Context} c
 * @param {string} token
 * @param {import("@budget/schema").SessionAuthMethod} [authMethod]
 */
export function setSessionCookie(c, token, authMethod = "passkey") {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: sessionTtlMs(authMethod) / 1000,
  });
}

/** @param {import("hono").Context} c */
export function clearSessionCookie(c) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/**
 * The live session for this request's cookie, touching `lastSeenAt` at most
 * once an hour to keep writes down. Returns null for no cookie, an unknown
 * token, or an expired/revoked session — the middleware and /auth/state
 * treat all of those identically.
 *
 * @param {import("@budget/schema").Db} db
 * @param {import("hono").Context} c
 */
export async function getSessionFromRequest(db, c) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  const tokenHash = hashToken(token);
  const session = await db.query.sessions.findFirst({
    where: (s, { eq: eqCol }) => eqCol(s.tokenHash, tokenHash),
  });
  if (!session) return null;
  if (session.revokedAt || session.expiresAt <= new Date()) return null;

  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, session.id));
  }

  return session;
}
