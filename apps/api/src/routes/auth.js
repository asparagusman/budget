import {
  bootstrapSchema,
  deviceRequests as deviceRequestsTable,
  deviceRequestSchema,
  invites as invitesTable,
  passwordLoginSchema,
  redeemInviteSchema,
  sessions as sessionsTable,
  setRecoveryPasswordSchema,
  users as usersTable,
} from "@budget/schema";
import { mustAt } from "@budget/engine";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq, gt, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { writeAuditLog } from "../lib/audit.js";
import {
  DEVICE_REQUEST_COOKIE,
  DEVICE_REQUEST_TTL_MS,
  describeDeviceRequest,
  findOwnDeviceRequest,
  generateDeviceRequestCode,
  MAX_PENDING_DEVICE_REQUESTS,
} from "../lib/device-request.js";
import { guessDeviceName } from "../lib/device-name.js";
import { hashInviteCode } from "../lib/invite.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { rateLimit } from "../lib/rate-limit.js";
import {
  authCookieOptions,
  clearSessionCookie,
  createSession,
  generateToken,
  getSessionFromRequest,
  hashToken,
  sessionTtlMs,
  setSessionCookie,
} from "../lib/session.js";
import { handleValidation } from "../lib/validation.js";

const INVALID_INVITE = {
  code: "invalid_invite",
  message: "This invite is invalid, expired or already used.",
};

const BOOTSTRAP_CLOSED = {
  code: "bootstrap_closed",
  message: "This household is already set up. Ask to join from this device instead.",
};

/**
 * Thrown inside a transaction to roll it back and answer 400: what
 * authorized the sign-in no longer holds by the time it is written.
 */
class SignInRefused extends Error {
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

/** @param {{ id: string, displayName: string, email: string | null }} user */
const publicUser = (user) => ({ id: user.id, displayName: user.displayName, email: user.email });

/**
 * @param {{ db: import("@budget/schema").Db, env: import("../env.js").Env }} deps
 */
export function createAuthRoutes({ db }) {
  const app = new Hono();

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
        user: publicUser(user),
        // The browser has to know it is on a recovery session BEFORE it
        // renders the app: every screen would 403, and a wall of failed
        // queries is a worse answer than "approve a device to continue".
        authMethod: session.authMethod,
      });
    })

    // Whether the household has a recovery password at all, and whose it is.
    // Public, like every other /auth route, and deliberately says nothing a
    // sign-in screen could not already infer: the "lost every device?"
    // affordance has to know whether to offer itself.
    .get("/recovery-password", async (c) => {
      const holder = await db.query.users.findFirst({
        where: (u, { isNotNull: isNotNullCol }) => isNotNullCol(u.recoveryPasswordHash),
      });
      return c.json({
        configured: holder != null,
        holderDisplayName: holder?.displayName ?? null,
        setAt: holder?.recoveryPasswordSetAt ?? null,
      });
    })

    // The household's first user, on its first device. Nobody can approve
    // anything yet, so this is the one way in that needs no one's say-so —
    // and it closes for good the moment the users table has a row.
    .post(
      "/bootstrap",
      rateLimit("bootstrap"),
      zValidator("json", bootstrapSchema, handleValidation),
      async (c) => {
        const { displayName, deviceName } = c.req.valid("json");
        const userAgent = c.req.header("user-agent");

        let created;
        try {
          created = await db.transaction(async (tx) => {
            // Two first visitors at once must not both become the first user.
            // The lock makes the second wait, then see the first one's row.
            await tx.execute(sql`lock table ${usersTable} in exclusive mode`);
            if ((await countUsers(tx)) > 0) throw new SignInRefused(BOOTSTRAP_CLOSED);
            const user = mustAt(await tx.insert(usersTable).values({ displayName }).returning(), 0, "created user");
            const { token, session } = await createSession(tx, {
              userId: user.id,
              userAgent,
              deviceName: deviceName ?? guessDeviceName(userAgent),
            });
            return { user, token, session };
          });
        } catch (err) {
          if (err instanceof SignInRefused) return c.json({ error: err.error }, 400);
          throw err;
        }
        const { user, token, session } = created;
        setSessionCookie(c, token);

        await writeAuditLog(db, {
          actorId: user.id,
          action: "user.bootstrap",
          entityType: "user",
          entityId: user.id,
        });
        await writeAuditLog(db, {
          actorId: user.id,
          action: "auth.login",
          entityType: "session",
          entityId: session.id,
          metadata: { via: "bootstrap" },
        });

        return c.json({ user: publicUser(user) });
      },
    )

    // A signed-out device asking to be let in. It gets a short code to show,
    // and a cookie that its polls of /device-requests/current are matched on.
    // Asking again replaces this browser's earlier request.
    .post(
      "/device-requests",
      rateLimit("device-request"),
      zValidator("json", deviceRequestSchema, handleValidation),
      async (c) => {
        if ((await countUsers(db)) === 0) {
          return c.json(
            {
              error: {
                code: "needs_bootstrap",
                message: "Nobody is set up yet, so there is no one to approve this. Set up the household instead.",
              },
            },
            400,
          );
        }

        const now = new Date();
        await db.delete(deviceRequestsTable).where(lte(deviceRequestsTable.expiresAt, now));
        const previous = await findOwnDeviceRequest(db, c);
        if (previous) await db.delete(deviceRequestsTable).where(eq(deviceRequestsTable.id, previous.id));

        const waiting = await db.$count(deviceRequestsTable);
        if (waiting >= MAX_PENDING_DEVICE_REQUESTS) {
          return c.json(
            {
              error: {
                code: "too_many_requests",
                message: "Too many devices are already waiting to be approved. Try again in a few minutes.",
              },
            },
            429,
          );
        }

        const token = generateToken();
        const created = await db
          .insert(deviceRequestsTable)
          .values({
            tokenHash: hashToken(token),
            code: generateDeviceRequestCode(),
            deviceName: c.req.valid("json").deviceName,
            userAgent: c.req.header("user-agent") ?? null,
            expiresAt: new Date(now.getTime() + DEVICE_REQUEST_TTL_MS),
          })
          .returning();
        const request = mustAt(created, 0, "created device request");
        setCookie(c, DEVICE_REQUEST_COOKIE, token, authCookieOptions(DEVICE_REQUEST_TTL_MS));

        return c.json({ request: describeDeviceRequest(request) });
      },
    )

    // Polled by the waiting device. Once someone has approved the request,
    // the first poll after it turns the request into this device's session
    // and deletes it, so it can only ever be redeemed once.
    .get("/device-requests/current", async (c) => {
      const request = await findOwnDeviceRequest(db, c);
      if (!request) {
        deleteCookie(c, DEVICE_REQUEST_COOKIE, { path: "/" });
        return c.json({ status: /** @type {const} */ ("none") });
      }
      if (!request.approvedUserId) {
        return c.json({ status: /** @type {const} */ ("pending"), request: describeDeviceRequest(request) });
      }

      const userAgent = c.req.header("user-agent");
      const signedIn = await db.transaction(async (tx) => {
        const [taken] = await tx
          .delete(deviceRequestsTable)
          .where(and(eq(deviceRequestsTable.id, request.id), isNotNull(deviceRequestsTable.approvedUserId)))
          .returning();
        if (!taken?.approvedUserId) return null;
        const approvedUserId = taken.approvedUserId;
        const user = await tx.query.users.findFirst({
          where: (u, { eq: eqCol }) => eqCol(u.id, approvedUserId),
        });
        // Deactivated between the approval and this poll.
        if (!user?.isActive) return null;
        const { token, session } = await createSession(tx, {
          userId: user.id,
          userAgent,
          deviceName: taken.deviceName,
        });
        return { user, token, session, approvedBy: taken.approvedBy };
      });

      deleteCookie(c, DEVICE_REQUEST_COOKIE, { path: "/" });
      if (!signedIn) return c.json({ status: /** @type {const} */ ("none") });

      setSessionCookie(c, signedIn.token);
      await writeAuditLog(db, {
        actorId: signedIn.user.id,
        action: "auth.login",
        entityType: "session",
        entityId: signedIn.session.id,
        metadata: { via: "device_approval", approvedBy: signedIn.approvedBy },
      });
      return c.json({ status: /** @type {const} */ ("approved"), user: publicUser(signedIn.user) });
    })

    // The waiting device giving up.
    .delete("/device-requests/current", async (c) => {
      const request = await findOwnDeviceRequest(db, c);
      if (request) await db.delete(deviceRequestsTable).where(eq(deviceRequestsTable.id, request.id));
      deleteCookie(c, DEVICE_REQUEST_COOKIE, { path: "/" });
      return c.json({ ok: true });
    })

    .get("/invite/:code", async (c) => {
      const result = await inviteStatus(db, c.req.param("code"));
      return c.json(result);
    })

    // An invite link signs the device straight in. Links are the break-glass
    // path — minted from the recovery screen or the server's shell
    // (scripts/auth-invite.js) — for when there is no signed-in device left
    // to approve a request.
    .post(
      "/invite/:code/redeem",
      rateLimit("invite"),
      zValidator("json", redeemInviteSchema, handleValidation),
      async (c) => {
        const { displayName, deviceName } = c.req.valid("json");
        const codeHash = hashInviteCode(c.req.param("code"));
        const userAgent = c.req.header("user-agent");

        let redeemed;
        try {
          redeemed = await db.transaction(async (tx) => {
            // Consumed in the same statement that checks it, so a link opened
            // on two devices signs in only one of them.
            const [invite] = await tx
              .update(invitesTable)
              .set({ consumedAt: sql`now()` })
              .where(
                and(
                  eq(invitesTable.codeHash, codeHash),
                  isNull(invitesTable.consumedAt),
                  gt(invitesTable.expiresAt, sql`now()`),
                ),
              )
              .returning();
            if (!invite) throw new SignInRefused(INVALID_INVITE);

            /** @type {typeof usersTable.$inferSelect | undefined} */
            let user;
            if (invite.purpose === "new_device") {
              const targetUserId = invite.targetUserId;
              user = targetUserId
                ? await tx.query.users.findFirst({ where: (u, { eq: eqCol }) => eqCol(u.id, targetUserId) })
                : undefined;
              // Deactivation has to mean the same thing at the door as it
              // does to a session already inside.
              if (!user?.isActive) throw new SignInRefused(INVALID_INVITE);
            } else {
              if (!displayName) {
                throw new SignInRefused({ code: "invalid_request", message: "Display name is required." });
              }
              user = mustAt(await tx.insert(usersTable).values({ displayName }).returning(), 0, "created user");
            }

            const { token, session } = await createSession(tx, {
              userId: user.id,
              userAgent,
              deviceName: deviceName ?? guessDeviceName(userAgent),
            });
            return { invite, user, token, session };
          });
        } catch (err) {
          if (err instanceof SignInRefused) return c.json({ error: err.error }, 400);
          throw err;
        }
        const { invite, user, token, session } = redeemed;
        setSessionCookie(c, token);

        await writeAuditLog(db, {
          actorId: user.id,
          action: "invite.consume",
          entityType: "invite",
          entityId: invite.id,
        });
        await writeAuditLog(db, {
          actorId: user.id,
          action: "auth.login",
          entityType: "session",
          entityId: session.id,
          metadata: { via: "invite" },
        });

        return c.json({ user: publicUser(user) });
      },
    )

    // The break-glass sign-in.
    //
    // Usernameless: there is at most one recovery password in the household,
    // so the password itself identifies the user. The session it opens is
    // confined to the recovery surface and expires in an hour — see
    // middleware/auth.js and lib/session.js.
    .post(
      "/login/password",
      rateLimit("login-password"),
      zValidator("json", passwordLoginSchema, handleValidation),
      async (c) => {
        const { password } = c.req.valid("json");

        const holder = await db.query.users.findFirst({
          where: (u, { isNotNull: isNotNullCol }) => isNotNullCol(u.recoveryPasswordHash),
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
          user: publicUser(holder),
          authMethod: /** @type {const} */ ("recovery_password"),
          expiresInSeconds: sessionTtlMs("recovery_password") / 1000,
        });
      },
    )

    // Set or replace the household's one recovery password.
    //
    // Requires an APPROVED DEVICE, checked here rather than by the middleware
    // because /auth/* is public to it. There is no current-password field:
    // holding a device the household let in is a stronger claim than knowing
    // the password being replaced, and a recovery session must never be able
    // to change the credential that created it.
    .put("/recovery-password", zValidator("json", setRecoveryPasswordSchema, handleValidation), async (c) => {
      const session = await getSessionFromRequest(db, c);
      if (!session) {
        return c.json({ error: { code: "unauthenticated", message: "Sign in required." } }, 401);
      }
      if (session.authMethod !== "device") {
        return c.json(
          {
            error: {
              code: "device_required",
              message: "Use an approved device to change the recovery password.",
            },
          },
          403,
        );
      }

      const existing = await db.query.users.findFirst({
        where: (u, { isNotNull: isNotNullCol }) => isNotNullCol(u.recoveryPasswordHash),
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
        // answers approved devices only.
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

    // Remove it. Also approved devices only, for the same reason.
    .delete("/recovery-password", async (c) => {
      const session = await getSessionFromRequest(db, c);
      if (!session) {
        return c.json({ error: { code: "unauthenticated", message: "Sign in required." } }, 401);
      }
      if (session.authMethod !== "device") {
        return c.json(
          {
            error: {
              code: "device_required",
              message: "Use an approved device to remove the recovery password.",
            },
          },
          403,
        );
      }

      const holder = await db.query.users.findFirst({
        where: (u, { isNotNull: isNotNullCol }) => isNotNullCol(u.recoveryPasswordHash),
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
