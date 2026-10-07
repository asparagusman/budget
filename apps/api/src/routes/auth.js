import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  credentials as credentialsTable,
  invites as invitesTable,
  loginVerifySchema,
  passwordLoginSchema,
  registerOptionsSchema,
  registerVerifySchema,
  sessions as sessionsTable,
  setRecoveryPasswordSchema,
  users as usersTable,
} from "@budget/schema";
import { mustAt } from "@budget/engine";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { writeAuditLog } from "../lib/audit.js";
import { putChallenge, takeChallenge } from "../lib/challenge-store.js";
import { guessDeviceName } from "../lib/device-name.js";
import { hashInviteCode } from "../lib/invite.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { rateLimit } from "../lib/rate-limit.js";
import {
  clearSessionCookie,
  createSession,
  getSessionFromRequest,
  sessionTtlMs,
  setSessionCookie,
} from "../lib/session.js";
import { handleValidation } from "../lib/validation.js";
import { getRpConfig } from "../lib/webauthn.js";

// User verification (a PIN, a fingerprint, a face) is REQUIRED, and asked for
// as such. @simplewebauthn/server's verify calls require it by default, so
// asking for only "preferred" let an authenticator skip it — a security key
// with no PIN set — and then fail at /verify with a generic "could not
// verify". Asking for what is checked makes the browser and authenticator
// deal with it up front, where they can prompt for a PIN. The verify calls
// below pass `requireUserVerification: true` explicitly so the two halves
// cannot drift apart again on a library default.
/** @type {import("@simplewebauthn/server").AuthenticatorSelectionCriteria} */
const AUTHENTICATOR_SELECTION = { residentKey: "required", userVerification: "required" };

const INVALID_INVITE = {
  code: "invalid_invite",
  message: "This invite is invalid, expired or already used.",
};

/**
 * Thrown inside registration's transaction to roll it back and answer 400:
 * the passkey verified, but what authorized the ceremony at /options no
 * longer holds by /verify.
 */
class RegistrationRefused extends Error {
  /** @param {{ code: string, message: string }} error */
  constructor(error) {
    super(error.message);
    this.error = error;
  }
}

/**
 * @param {import("@budget/schema").Db | import("@budget/schema").Tx} db
 */
async function countUsers(db) {
  const [row] = await db.select({ value: count() }).from(usersTable);
  return row?.value ?? 0;
}

/**
 * A valid, unconsumed, unexpired invite for `code`, or null. Used to
 * authorize registration; the finer-grained expired/consumed/unknown
 * distinction the `/invite/:code` screen needs lives in `inviteStatus`
 * below.
 *
 * @param {import("@budget/schema").Db} db
 * @param {string} code
 */
async function findValidInvite(db, code) {
  const invite = await db.query.invites.findFirst({
    where: (inv, { eq: eqCol }) => eqCol(inv.codeHash, hashInviteCode(code)),
  });
  if (!invite || invite.consumedAt || invite.expiresAt <= new Date()) return null;
  return invite;
}

/**
 * @param {import("@budget/schema").Db} db
 * @param {string} code
 */
async function inviteStatus(db, code) {
  const invite = await db.query.invites.findFirst({
    where: (inv, { eq: eqCol }) => eqCol(inv.codeHash, hashInviteCode(code)),
  });
  if (!invite) return { status: /** @type {const} */ ("unknown") };
  if (invite.consumedAt) return { status: /** @type {const} */ ("consumed") };
  if (invite.expiresAt <= new Date()) return { status: /** @type {const} */ ("expired") };
  return { status: /** @type {const} */ ("valid"), purpose: invite.purpose };
}

/**
 * @param {{ db: import("@budget/schema").Db, env: import("../env.js").Env }} deps
 */
export function createAuthRoutes({ db, env }) {
  const app = new Hono();
  const { rpID, rpName, origin } = getRpConfig(env);

  const routes = app
    .get("/state", async (c) => {
      const userCount = await countUsers(db);
      if (userCount === 0) {
        return c.json({ needsBootstrap: true, user: null });
      }

      const session = await getSessionFromRequest(db, c);
      if (!session) return c.json({ needsBootstrap: false, user: null });

      const user = await db.query.users.findFirst({
        where: (u, { eq: eqCol }) => eqCol(u.id, session.userId),
      });
      if (!user || !user.isActive) return c.json({ needsBootstrap: false, user: null });

      return c.json({
        needsBootstrap: false,
        user: { id: user.id, displayName: user.displayName, email: user.email },
        // The browser has to know it is on a recovery session BEFORE it
        // renders the app: every screen would 403, and a wall of failed
        // queries is a worse answer than "add a passkey to continue".
        authMethod: session.authMethod,
      });
    })

    // Whether the household has a recovery password at all, and whose it is.
    // Public, like every other /auth route, and deliberately says nothing a
    // sign-in screen could not already infer: the "can't use a passkey?"
    // affordance has to know whether to offer itself.
    .get("/recovery-password", async (c) => {
      const holder = await db.query.users.findFirst({
        where: (u, { isNotNull }) => isNotNull(u.recoveryPasswordHash),
      });
      return c.json({
        configured: holder != null,
        holderDisplayName: holder?.displayName ?? null,
        setAt: holder?.recoveryPasswordSetAt ?? null,
      });
    })

    .get("/invite/:code", async (c) => {
      const result = await inviteStatus(db, c.req.param("code"));
      return c.json(result);
    })

    .post(
      "/register/options",
      rateLimit("register"),
      zValidator("json", registerOptionsSchema, handleValidation),
      async (c) => {
      const { inviteCode, displayName } = c.req.valid("json");

      const userCount = await countUsers(db);
      if (userCount === 0) {
        // Bootstrap — the only registration that needs no invite.
        if (!displayName) {
          return c.json(
            { error: { code: "invalid_request", message: "Display name is required." } },
            400,
          );
        }
        const options = await generateRegistrationOptions({
          rpName,
          rpID,
          userName: displayName,
          userDisplayName: displayName,
          attestationType: "none",
          authenticatorSelection: AUTHENTICATOR_SELECTION,
        });
        const flowId = putChallenge({ kind: "register", challenge: options.challenge, displayName });
        return c.json({ flowId, options });
      }

      if (!inviteCode) {
        return c.json(
          { error: { code: "invalid_request", message: "An invite code is required." } },
          400,
        );
      }
      const invite = await findValidInvite(db, inviteCode);
      if (!invite) {
        return c.json(
          {
            error: {
              code: "invalid_invite",
              message: "This invite is invalid, expired or already used.",
            },
          },
          400,
        );
      }

      if (invite.purpose === "new_device") {
        const targetUserId = invite.targetUserId;
        const targetUser = targetUserId
          ? await db.query.users.findFirst({
              where: (u, { eq: eqCol }) => eqCol(u.id, targetUserId),
            })
          : undefined;
        // A deactivated user gets no new passkey: deactivation has to mean
        // the same thing at the door as it does to a session already inside.
        if (!targetUser || !targetUser.isActive) {
          return c.json({ error: INVALID_INVITE }, 400);
        }
        const existing = await db.query.credentials.findMany({
          where: (cred, { eq: eqCol }) => eqCol(cred.userId, targetUser.id),
        });
        const options = await generateRegistrationOptions({
          rpName,
          rpID,
          userName: targetUser.displayName,
          userDisplayName: targetUser.displayName,
          attestationType: "none",
          excludeCredentials: existing.map((cred) => ({
            id: cred.credentialId,
            transports: /** @type {import("@simplewebauthn/server").AuthenticatorTransportFuture[] | undefined} */ (
              cred.transports ?? undefined
            ),
          })),
          authenticatorSelection: AUTHENTICATOR_SELECTION,
        });
        const flowId = putChallenge({
          kind: "register",
          challenge: options.challenge,
          targetUserId: targetUser.id,
          inviteId: invite.id,
        });
        return c.json({ flowId, options });
      }

      // 'new_user'
      if (!displayName) {
        return c.json(
          { error: { code: "invalid_request", message: "Display name is required." } },
          400,
        );
      }
      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: displayName,
        userDisplayName: displayName,
        attestationType: "none",
        authenticatorSelection: AUTHENTICATOR_SELECTION,
      });
      const flowId = putChallenge({
        kind: "register",
        challenge: options.challenge,
        displayName,
        inviteId: invite.id,
      });
      return c.json({ flowId, options });
      },
    )

    .post(
      "/register/verify",
      rateLimit("register"),
      zValidator("json", registerVerifySchema, handleValidation),
      async (c) => {
      const data = c.req.valid("json");
      const challenge = takeChallenge(data.flowId);
      if (!challenge || challenge.kind !== "register") {
        return c.json(
          {
            error: {
              code: "expired_challenge",
              message: "This registration attempt has expired. Start again.",
            },
          },
          400,
        );
      }

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: /** @type {import("@simplewebauthn/server").RegistrationResponseJSON} */ (
            /** @type {unknown} */ (data.response)
          ),
          expectedChallenge: challenge.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
      } catch (err) {
        console.error("Registration verification failed:", err);
        verification = /** @type {import("@simplewebauthn/server").VerifiedRegistrationResponse} */ ({
          verified: false,
        });
      }
      if (!verification.verified) {
        return c.json(
          { error: { code: "verification_failed", message: "Could not verify this passkey." } },
          400,
        );
      }

      const { credential } = verification.registrationInfo;
      const { inviteId, targetUserId, displayName } = challenge;
      const userAgent = c.req.header("user-agent");

      // Everything the ceremony writes lands together or not at all.
      // Bootstrap is why: the user row is what closes bootstrap (the users
      // table is no longer empty), so a user written without its credential
      // leaves a household nobody can sign in to and nobody can set up again.
      let registered;
      try {
        registered = await db.transaction(async (tx) => {
          if (inviteId) {
            // Consumed in the same statement that checks it. /options only
            // proved the invite was good when the ceremony STARTED; two
            // ceremonies opened on one link must not both finish.
            const consumed = await tx
              .update(invitesTable)
              .set({ consumedAt: sql`now()` })
              .where(
                and(
                  eq(invitesTable.id, inviteId),
                  isNull(invitesTable.consumedAt),
                  gt(invitesTable.expiresAt, sql`now()`),
                ),
              )
              .returning({ id: invitesTable.id });
            if (consumed.length === 0) throw new RegistrationRefused(INVALID_INVITE);
          } else if ((await countUsers(tx)) > 0) {
            // A bootstrap ceremony that someone else's beat to /verify.
            throw new RegistrationRefused({
              code: "bootstrap_closed",
              message: "This household is already set up. Ask a member for an invite.",
            });
          }

          /** @type {typeof usersTable.$inferSelect | undefined} */
          let user;
          if (targetUserId) {
            user = await tx.query.users.findFirst({
              where: (u, { eq: eqCol }) => eqCol(u.id, targetUserId),
            });
          } else if (displayName) {
            const created = await tx.insert(usersTable).values({ displayName }).returning();
            user = mustAt(created, 0, "created user");
          }
          // A `new_device` target deactivated since /options. (A new user was
          // just created active, and /options never pins a register challenge
          // with neither a target nor a display name.)
          if (!user?.isActive) throw new RegistrationRefused(INVALID_INVITE);

          await tx.insert(credentialsTable).values({
            userId: user.id,
            credentialId: credential.id,
            publicKey: Buffer.from(credential.publicKey),
            counter: credential.counter,
            transports: credential.transports ?? null,
            deviceName: guessDeviceName(userAgent),
          });
          const { token, session } = await createSession(tx, { userId: user.id, userAgent });
          return { user, token, session };
        });
      } catch (err) {
        if (err instanceof RegistrationRefused) return c.json({ error: err.error }, 400);
        throw err;
      }
      const { user, token, session } = registered;
      setSessionCookie(c, token);

      if (!targetUserId) {
        await writeAuditLog(db, {
          actorId: user.id,
          action: "user.bootstrap",
          entityType: "user",
          entityId: user.id,
        });
      }
      await writeAuditLog(db, {
        actorId: user.id,
        action: "credential.register",
        entityType: "credential",
        entityId: credential.id,
      });
      if (inviteId) {
        await writeAuditLog(db, {
          actorId: user.id,
          action: "invite.consume",
          entityType: "invite",
          entityId: inviteId,
        });
      }
      await writeAuditLog(db, {
        actorId: user.id,
        action: "auth.login",
        entityType: "session",
        entityId: session.id,
      });

      return c.json({ user: { id: user.id, displayName: user.displayName, email: user.email } });
      },
    )

    .post("/login/options", rateLimit("login"), async (c) => {
      const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
      const flowId = putChallenge({ kind: "login", challenge: options.challenge });
      return c.json({ flowId, options });
    })

    .post(
      "/login/verify",
      rateLimit("login"),
      zValidator("json", loginVerifySchema, handleValidation),
      async (c) => {
      const data = c.req.valid("json");
      const challenge = takeChallenge(data.flowId);
      if (!challenge || challenge.kind !== "login") {
        return c.json(
          {
            error: {
              code: "expired_challenge",
              message: "This sign-in attempt has expired. Try again.",
            },
          },
          400,
        );
      }

      const responseId = /** @type {{ id?: unknown }} */ (data.response).id;
      if (typeof responseId !== "string") {
        return c.json(
          { error: { code: "invalid_request", message: "Invalid sign-in response." } },
          400,
        );
      }
      const credentialRow = await db.query.credentials.findFirst({
        where: (cred, { eq: eqCol }) => eqCol(cred.credentialId, responseId),
      });
      const user = credentialRow
        ? await db.query.users.findFirst({
            where: (u, { eq: eqCol }) => eqCol(u.id, credentialRow.userId),
          })
        : null;
      if (!credentialRow || !user || !user.isActive) {
        return c.json(
          { error: { code: "no_such_passkey", message: "This passkey is not registered here." } },
          400,
        );
      }

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: /** @type {import("@simplewebauthn/server").AuthenticationResponseJSON} */ (
            /** @type {unknown} */ (data.response)
          ),
          expectedChallenge: challenge.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: credentialRow.credentialId,
            // node-postgres decodes bytea into a Buffer; the newer TypeScript
            // lib types Uint8Array as generic over its backing ArrayBuffer
            // type, and Buffer's is wider (ArrayBufferLike) than what
            // WebAuthnCredential wants — copy into a plain Uint8Array rather
            // than cast across the mismatch.
            publicKey: Uint8Array.from(credentialRow.publicKey),
            counter: credentialRow.counter,
            transports: /** @type {import("@simplewebauthn/server").AuthenticatorTransportFuture[] | undefined} */ (
              credentialRow.transports ?? undefined
            ),
          },
          requireUserVerification: true,
        });
      } catch (err) {
        console.error("Authentication verification failed:", err);
        return c.json(
          { error: { code: "verification_failed", message: "Could not verify this passkey." } },
          400,
        );
      }
      if (!verification.verified) {
        return c.json(
          { error: { code: "verification_failed", message: "Could not verify this passkey." } },
          400,
        );
      }

      await db
        .update(credentialsTable)
        .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
        .where(eq(credentialsTable.id, credentialRow.id));

      const { token, session } = await createSession(db, {
        userId: user.id,
        userAgent: c.req.header("user-agent"),
      });
      setSessionCookie(c, token);
      await writeAuditLog(db, {
        actorId: user.id,
        action: "auth.login",
        entityType: "session",
        entityId: session.id,
      });

      return c.json({ user: { id: user.id, displayName: user.displayName, email: user.email } });
      },
    )

    // The break-glass sign-in.
    //
    // Usernameless like the passkey flow: there is at most one recovery
    // password in the household, so the password itself identifies the user.
    // The session it opens is confined to the recovery surface and expires in
    // an hour — see middleware/auth.js and lib/session.js.
    .post(
      "/login/password",
      rateLimit("login-password"),
      zValidator("json", passwordLoginSchema, handleValidation),
      async (c) => {
        const { password } = c.req.valid("json");

        const holder = await db.query.users.findFirst({
          where: (u, { isNotNull }) => isNotNull(u.recoveryPasswordHash),
        });
        // One message for "there is no recovery password", "you typed it
        // wrong" and "that user is deactivated". A caller who can tell those
        // apart can enumerate the household's state without knowing anything.
        const ok = holder?.isActive === true && (await verifyPassword(password, holder.recoveryPasswordHash));
        if (!holder || !ok) {
          if (holder) {
            await writeAuditLog(db, {
              actorId: null,
              action: "auth.recovery_login_failed",
              entityType: "user",
              entityId: holder.id,
            });
          }
          return c.json(
            { error: { code: "invalid_password", message: "That is not the recovery password." } },
            400,
          );
        }

        const { token, session } = await createSession(db, {
          userId: holder.id,
          userAgent: c.req.header("user-agent"),
          authMethod: "recovery_password",
        });
        setSessionCookie(c, token, "recovery_password");
        await writeAuditLog(db, {
          actorId: holder.id,
          action: "auth.recovery_login",
          entityType: "session",
          entityId: session.id,
        });

        return c.json({
          user: { id: holder.id, displayName: holder.displayName, email: holder.email },
          authMethod: /** @type {const} */ ("recovery_password"),
          expiresInSeconds: sessionTtlMs("recovery_password") / 1000,
        });
      },
    )

    // Set or replace the household's one recovery password.
    //
    // Requires a PASSKEY session, checked here rather than by the middleware
    // because /auth/* is public to it. There is no current-password field:
    // holding a passkey is a stronger claim than knowing the password being
    // replaced, and a recovery session must never be able to change the
    // credential that created it.
    .put("/recovery-password", zValidator("json", setRecoveryPasswordSchema, handleValidation), async (c) => {
      const session = await getSessionFromRequest(db, c);
      if (!session) {
        return c.json({ error: { code: "unauthenticated", message: "Sign in required." } }, 401);
      }
      if (session.authMethod !== "passkey") {
        return c.json(
          {
            error: {
              code: "passkey_required",
              message: "Sign in with a passkey to change the recovery password.",
            },
          },
          403,
        );
      }

      const existing = await db.query.users.findFirst({
        where: (u, { isNotNull }) => isNotNull(u.recoveryPasswordHash),
      });
      if (existing && existing.id !== session.userId) {
        return c.json(
          {
            error: {
              code: "recovery_password_exists",
              message: `${existing.displayName} already holds the recovery password. Remove theirs first.`,
            },
          },
          400,
        );
      }

      const hash = await hashPassword(c.req.valid("json").password);
      const setAt = new Date();
      const revokedSessions = await db.transaction(async (tx) => {
        await tx
          .update(usersTable)
          .set({ recoveryPasswordHash: hash, recoveryPasswordSetAt: setAt })
          .where(eq(usersTable.id, session.userId));
        // The old password's sessions go with it, as they do on DELETE: the
        // usual reason to rotate is that the old one got out, and rotating
        // has to shut the door it already opened, not leave it ajar for the
        // rest of its hour. The caller is never one of them — this route
        // answers passkey sessions only.
        const revoked = await tx
          .update(sessionsTable)
          .set({ revokedAt: setAt })
          .where(
            and(
              eq(sessionsTable.userId, session.userId),
              eq(sessionsTable.authMethod, "recovery_password"),
              isNull(sessionsTable.revokedAt),
            ),
          )
          .returning({ id: sessionsTable.id });
        return revoked.length;
      });

      await writeAuditLog(db, {
        actorId: session.userId,
        action: existing ? "auth.recovery_password_replaced" : "auth.recovery_password_set",
        entityType: "user",
        entityId: session.userId,
        metadata: { revokedSessions },
      });

      return c.json({ configured: true, setAt });
    })

    // Remove it. Also passkey-only, for the same reason.
    .delete("/recovery-password", async (c) => {
      const session = await getSessionFromRequest(db, c);
      if (!session) {
        return c.json({ error: { code: "unauthenticated", message: "Sign in required." } }, 401);
      }
      if (session.authMethod !== "passkey") {
        return c.json(
          {
            error: {
              code: "passkey_required",
              message: "Sign in with a passkey to remove the recovery password.",
            },
          },
          403,
        );
      }

      const holder = await db.query.users.findFirst({
        where: (u, { isNotNull }) => isNotNull(u.recoveryPasswordHash),
      });
      if (!holder) return c.json({ configured: false });

      await db
        .update(usersTable)
        .set({ recoveryPasswordHash: null, recoveryPasswordSetAt: null })
        .where(eq(usersTable.id, holder.id));
      // Any session it opened dies with it — otherwise removing the password
      // would leave the door it opened standing ajar for another hour.
      await db
        .update(sessionsTable)
        .set({ revokedAt: new Date() })
        .where(eq(sessionsTable.authMethod, "recovery_password"));

      await writeAuditLog(db, {
        actorId: session.userId,
        action: "auth.recovery_password_removed",
        entityType: "user",
        entityId: holder.id,
      });

      return c.json({ configured: false });
    })

    .post("/logout", async (c) => {
      const session = await getSessionFromRequest(db, c);
      if (session) {
        await db
          .update(sessionsTable)
          .set({ revokedAt: new Date() })
          .where(eq(sessionsTable.id, session.id));
        await writeAuditLog(db, {
          actorId: session.userId,
          action: "auth.logout",
          entityType: "session",
          entityId: session.id,
        });
      }
      clearSessionCookie(c);
      return c.json({ ok: true });
    });

  return routes;
}
