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
  registerOptionsSchema,
  registerVerifySchema,
  sessions as sessionsTable,
  users as usersTable,
} from "@budget/schema";
import { mustAt } from "@budget/engine";
import { zValidator } from "@hono/zod-validator";
import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { writeAuditLog } from "../lib/audit.js";
import { putChallenge, takeChallenge } from "../lib/challenge-store.js";
import { guessDeviceName } from "../lib/device-name.js";
import { hashInviteCode } from "../lib/invite.js";
import { rateLimit } from "../lib/rate-limit.js";
import {
  clearSessionCookie,
  createSession,
  getSessionFromRequest,
  setSessionCookie,
} from "../lib/session.js";
import { handleValidation } from "../lib/validation.js";
import { getRpConfig } from "../lib/webauthn.js";

/** @type {import("@simplewebauthn/server").AuthenticatorSelectionCriteria} */
const AUTHENTICATOR_SELECTION = { residentKey: "required", userVerification: "preferred" };

/**
 * @param {import("@budget/schema").Db} db
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
        const targetUserId = /** @type {string} */ (invite.targetUserId);
        const targetUser = await db.query.users.findFirst({
          where: (u, { eq: eqCol }) => eqCol(u.id, targetUserId),
        });
        if (!targetUser) {
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

      let userId = challenge.targetUserId;
      if (!userId) {
        const createdUsers = await db
          .insert(usersTable)
          .values({ displayName: /** @type {string} */ (challenge.displayName) })
          .returning();
        userId = mustAt(createdUsers, 0, "created user").id;
        await writeAuditLog(db, {
          actorId: userId,
          action: "user.bootstrap",
          entityType: "user",
          entityId: userId,
        });
      }

      await db.insert(credentialsTable).values({
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? null,
        deviceName: guessDeviceName(c.req.header("user-agent")),
      });
      await writeAuditLog(db, {
        actorId: userId,
        action: "credential.register",
        entityType: "credential",
        entityId: credential.id,
      });

      if (challenge.inviteId) {
        await db
          .update(invitesTable)
          .set({ consumedAt: new Date() })
          .where(eq(invitesTable.id, challenge.inviteId));
        await writeAuditLog(db, {
          actorId: userId,
          action: "invite.consume",
          entityType: "invite",
          entityId: challenge.inviteId,
        });
      }

      const { token, session } = await createSession(db, {
        userId,
        userAgent: c.req.header("user-agent"),
      });
      setSessionCookie(c, token);
      await writeAuditLog(db, {
        actorId: userId,
        action: "auth.login",
        entityType: "session",
        entityId: session.id,
      });

      const user = await db.query.users.findFirst({
        where: (u, { eq: eqCol }) => eqCol(u.id, /** @type {string} */ (userId)),
      });
      return c.json({
        user: user ? { id: user.id, displayName: user.displayName, email: user.email } : null,
      });
      },
    )

    .post("/login/options", rateLimit("login"), async (c) => {
      const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
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
