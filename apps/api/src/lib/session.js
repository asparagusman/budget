import { createHash, randomBytes } from "node:crypto";
import { mustAt } from "@budget/engine";
import { sessions, users } from "@budget/schema";
import { eq } from "drizzle-orm";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export const SESSION_COOKIE = "budget_session";
// An approved device stays signed in for as long as it keeps being used: the
// household opens this app about once a month, and having to be approved
// again every few weeks would make approval a chore rather than a one-off.
// 400 days is the longest cookie lifetime browsers honour; every use pushes
// it out again (see getSessionFromRequest).
const DEVICE_SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000;
// A recovery session lives hours, not a month. It exists to get a device
// approved; anything still open the next morning is a password session
// nobody is watching.
const RECOVERY_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const TOUCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Whether cookies are marked Secure, which browsers only send over https.
// Follows PUBLIC_ORIGIN (index.js): the household app is served over plain
// http://budget.local, where a Secure cookie would simply never come back.
let secureCookies = true;

/** @param {boolean} secure */
export function setSecureCookies(secure) {
  secureCookies = secure;
}

/**
 * The cookie options every auth cookie shares.
 *
 * @param {number} maxAgeMs
 */
export function authCookieOptions(maxAgeMs) {
  return /** @type {const} */ ({
    httpOnly: true,
    secure: secureCookies,
    sameSite: "Strict",
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

/** @param {string} token */
export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** A fresh random token for a cookie. Only its hash is ever stored. */
export function generateToken() {
  return randomBytes(32).toString("base64url");
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
 * Takes a transaction too: bootstrap opens its session in the same
 * transaction that creates the user.
 *
 * @param {import("@budget/schema").Db | import("@budget/schema").Tx} db
 * @param {{
 *   userId: string,
 *   userAgent: string | undefined,
 *   deviceName?: string | null,
 *   authMethod?: import("@budget/schema").SessionAuthMethod,
 * }} params
 */
export async function createSession(db, { userId, userAgent, deviceName = null, authMethod = "device" }) {
  const token = generateToken();
  const created = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      authMethod,
      deviceName,
      userAgent: userAgent ?? null,
      expiresAt: new Date(Date.now() + sessionTtlMs(authMethod)),
    })
    .returning();
  return { token, session: mustAt(created, 0, "created session") };
}

/**
 * How long a session opened this way lives, and its cookie with it.
 *
 * @param {import("@budget/schema").SessionAuthMethod} authMethod
 */
export function sessionTtlMs(authMethod) {
  return authMethod === "recovery_password" ? RECOVERY_SESSION_TTL_MS : DEVICE_SESSION_TTL_MS;
}

/**
 * @param {import("hono").Context} c
 * @param {string} token
 * @param {import("@budget/schema").SessionAuthMethod} [authMethod]
 */
export function setSessionCookie(c, token, authMethod = "device") {
  setCookie(c, SESSION_COOKIE, token, authCookieOptions(sessionTtlMs(authMethod)));
}

/** @param {import("hono").Context} c */
export function clearSessionCookie(c) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/**
 * The live session for this request's cookie, touching `lastSeenAt` at most
 * once an hour to keep writes down. Returns null for no cookie, an unknown
 * token, an expired/revoked session, or a session whose user has been
 * deactivated — the middleware and /auth/state treat all of those
 * identically.
 *
 * A device session's touch also slides its expiry, in the database and in the
 * cookie, so a device in use is never signed out by the calendar. A recovery
 * session's hour is fixed.
 *
 * The user check lives here rather than in the middleware because this is
 * the one place every request passes, /auth/* included (logout, the
 * recovery-password writes). Deactivating a user also revokes their
 * sessions; this is what still holds when `is_active` was flipped some other
 * way, by psql or by a future route that forgets.
 *
 * @param {import("@budget/schema").Db} db
 * @param {import("hono").Context} c
 */
export async function getSessionFromRequest(db, c) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  const tokenHash = hashToken(token);
  const [row] = await db
    .select({ session: sessions, userIsActive: users.isActive })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  if (!row) return null;
  const { session } = row;
  if (session.revokedAt || session.expiresAt <= new Date()) return null;
  if (!row.userIsActive) return null;

  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const now = new Date();
    if (session.authMethod === "device") {
      const expiresAt = new Date(now.getTime() + DEVICE_SESSION_TTL_MS);
      await db.update(sessions).set({ lastSeenAt: now, expiresAt }).where(eq(sessions.id, session.id));
      setSessionCookie(c, token, "device");
      return { ...session, lastSeenAt: now, expiresAt };
    }
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, session.id));
  }

  return session;
}
