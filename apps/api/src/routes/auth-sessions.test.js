import { mustAt } from "@budget/engine";
import { auditLog, credentials, invites, sessions, users } from "@budget/schema";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_COOKIE } from "../lib/session.js";
import { requireAuth } from "../middleware/auth.js";
import { createTestDb } from "../test/db.js";
import { createAuthRoutes } from "./auth.js";
import { createCredentialsRoutes } from "./credentials.js";
import { createInvitesRoutes } from "./invites.js";
import { createSessionsRoutes } from "./sessions.js";
import { createUsersRoutes } from "./users.js";

/** @import { Db } from "@budget/schema" */

// Who can still get in after the household changes its mind: a deactivated
// user, a removed passkey, a registration that half-happened, an invite
// opened twice. Each of these was a way to stay signed in, or to be locked
// out, that the screens said could not happen.
//
// The WebAuthn verify calls are mocked. What they check (signatures,
// attestation) is the library's job and needs a real authenticator; what
// these tests check is what the routes DO with a verified ceremony, and what
// they ask the library to require. Options generation stays real.

vi.mock(import("@simplewebauthn/server"), async (importOriginal) => ({
  ...(await importOriginal()),
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

// A test file fires far more ceremonies a minute than any person could, and
// the limiter is not what is under test here.
vi.mock(import("../lib/rate-limit.js"), async (importOriginal) => {
  /** @type {import("hono").MiddlewareHandler} */
  const passThrough = async (_c, next) => {
    await next();
  };
  return { ...(await importOriginal()), rateLimit: () => passThrough };
});

/** @type {Db} */
let db;
/** @type {() => Promise<void>} */
let close;
/** @type {import("hono").Hono} */
let app;

// The auth surface as index.js mounts it, behind the same middleware, plus
// one ordinary protected route standing in for "the rest of the app".
function createApp() {
  const guarded = new Hono();
  guarded.use("*", requireAuth(db));
  return guarded
    .route("/auth", createAuthRoutes({ db, env: /** @type {any} */ ({ PUBLIC_ORIGIN: "https://budget.test" }) }))
    .route("/users", createUsersRoutes({ db }))
    .route("/invites", createInvitesRoutes({ db }))
    .route("/credentials", createCredentialsRoutes({ db }))
    .route("/sessions", createSessionsRoutes({ db }))
    .get("/dashboard", (c) => c.json({ ok: true }));
}

// One migrated database for the file, emptied between tests: migrating
// PGlite costs seconds, truncating costs nothing.
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  app = createApp();
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.execute(sql`truncate table users, sessions, credentials, invites, audit_log cascade`);
  vi.mocked(verifyRegistrationResponse).mockReset();
  vi.mocked(verifyAuthenticationResponse).mockReset();
});

/**
 * @param {string} path
 * @param {{ method?: string, token?: string, json?: unknown }} [options]
 */
function request(path, { method = "GET", token, json } = {}) {
  return app.request(path, {
    method,
    headers: {
      ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
      ...(json === undefined ? {} : { "content-type": "application/json" }),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

/** @param {Response} res @returns {Promise<any>} */
const body = (res) => res.json();

/** @param {Response} res */
function cookieToken(res) {
  const token = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(res.headers.get("set-cookie") ?? "")?.[1];
  if (!token) throw new Error("No session cookie was set.");
  return token;
}

/** @param {string} displayName @param {{ isActive?: boolean }} [options] */
async function addUser(displayName, { isActive = true } = {}) {
  return mustAt(await db.insert(users).values({ displayName, isActive }).returning(), 0, "user");
}

/** @param {string} userId @param {string} credentialId */
async function addCredential(userId, credentialId) {
  const rows = await db
    .insert(credentials)
    .values({ userId, credentialId, publicKey: Buffer.from([1, 2, 3]), deviceName: "Phone" })
    .returning();
  return mustAt(rows, 0, "credential");
}

/**
 * @param {string} userId
 * @param {"passkey" | "recovery_password"} [authMethod]
 */
async function signIn(userId, authMethod = "passkey") {
  const { token, session } = await createSession(db, { userId, userAgent: "test", authMethod });
  return { token, sessionId: session.id };
}

/** @param {string} token */
const canReachApp = async (token) => (await request("/dashboard", { token })).status === 200;

/** @param {Record<string, unknown>} json */
async function registerOptions(json) {
  const res = await request("/auth/register/options", { method: "POST", json });
  expect(res.status).toBe(200);
  return body(res);
}

/**
 * Finishes a registration ceremony as though the authenticator produced
 * `credentialId`. `counter` exists to break the credential insert on purpose.
 *
 * @param {string} flowId
 * @param {string} credentialId
 * @param {number} [counter]
 */
function registerVerify(flowId, credentialId, counter = 0) {
  vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce(
    /** @type {any} */ ({
      verified: true,
      registrationInfo: {
        credential: { id: credentialId, publicKey: new Uint8Array([1, 2, 3]), counter, transports: ["internal"] },
      },
    }),
  );
  return request("/auth/register/verify", { method: "POST", json: { flowId, response: { id: credentialId } } });
}

/** @param {string} credentialId */
async function login(credentialId) {
  const { flowId } = await body(await request("/auth/login/options", { method: "POST" }));
  vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce(
    /** @type {any} */ ({ verified: true, authenticationInfo: { newCounter: 1 } }),
  );
  return request("/auth/login/verify", { method: "POST", json: { flowId, response: { id: credentialId } } });
}

/**
 * @param {string} token
 * @param {{ purpose: "new_user" } | { purpose: "new_device", targetUserId: string }} json
 */
function mintInvite(token, json) {
  return request("/invites", { method: "POST", token, json });
}

/** @param {string} userId */
const sessionsOf = (userId) => db.select().from(sessions).where(eq(sessions.userId, userId));

describe("user verification", () => {
  it("is asked for as required, and verified as required, at registration and sign-in", async () => {
    // Asking for "preferred" while the library verifies "required" is how a
    // security key with no PIN got as far as /verify and then failed with
    // nothing more useful than "could not verify".
    const { flowId, options } = await registerOptions({ displayName: "Ada" });
    expect(options.authenticatorSelection.userVerification).toBe("required");
    expect((await registerVerify(flowId, "cred-ada")).status).toBe(200);
    expect(verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({ requireUserVerification: true }),
    );

    const loginOptions = await body(await request("/auth/login/options", { method: "POST" }));
    expect(loginOptions.options.userVerification).toBe("required");
    expect((await login("cred-ada")).status).toBe(200);
    expect(verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({ requireUserVerification: true }),
    );
  });
});

describe("bootstrap", () => {
  it("leaves the household set-up-able when the passkey fails to save", async () => {
    const { flowId } = await registerOptions({ displayName: "Ada" });
    // A counter that is not an integer is refused by the bigint column, so
    // the credential insert fails after the user insert has run.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await registerVerify(flowId, "cred-ada", 1.5)).status).toBe(500);
    quiet.mockRestore();

    // Before: a user with no passkey, which closed bootstrap and let nobody
    // in. Now the user row went with the credential.
    expect(await db.$count(users)).toBe(0);
    expect(await db.$count(sessions)).toBe(0);
    expect((await body(await request("/auth/state"))).needsBootstrap).toBe(true);

    const retry = await registerOptions({ displayName: "Ada" });
    expect((await registerVerify(retry.flowId, "cred-ada")).status).toBe(200);
    expect(await db.$count(users)).toBe(1);
    expect(await db.$count(credentials)).toBe(1);
  });

  it("lets only the first of two bootstrap ceremonies finish", async () => {
    const first = await registerOptions({ displayName: "Ada" });
    const second = await registerOptions({ displayName: "Mallory" });

    expect((await registerVerify(first.flowId, "cred-ada")).status).toBe(200);
    const late = await registerVerify(second.flowId, "cred-mallory");
    expect(late.status).toBe(400);
    expect((await body(late)).error.code).toBe("bootstrap_closed");
    expect(late.headers.get("set-cookie")).toBeNull();

    expect((await db.select().from(users)).map((u) => u.displayName)).toEqual(["Ada"]);
    expect(await db.$count(credentials)).toBe(1);
  });
});

describe("redeeming an invite", () => {
  it("registers once, however many times the link was opened", async () => {
    const ada = await addUser("Ada");
    const { token } = await signIn(ada.id);
    const { invite } = await body(await mintInvite(token, { purpose: "new_user" }));

    // Both ceremonies start while the invite is still good.
    const first = await registerOptions({ inviteCode: invite.code, displayName: "Ben" });
    const second = await registerOptions({ inviteCode: invite.code, displayName: "Eve" });

    expect((await registerVerify(first.flowId, "cred-ben")).status).toBe(200);
    const late = await registerVerify(second.flowId, "cred-eve");
    expect(late.status).toBe(400);
    expect((await body(late)).error).toEqual({
      code: "invalid_invite",
      message: "This invite is invalid, expired or already used.",
    });

    expect((await db.select().from(users)).map((u) => u.displayName).sort()).toEqual(["Ada", "Ben"]);
    expect(await db.$count(credentials)).toBe(1);
  });

  it("refuses one that expired mid-ceremony, and writes nothing", async () => {
    const ada = await addUser("Ada");
    const { token } = await signIn(ada.id);
    const { invite } = await body(await mintInvite(token, { purpose: "new_user" }));
    const { flowId } = await registerOptions({ inviteCode: invite.code, displayName: "Ben" });

    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, invite.id));

    expect((await registerVerify(flowId, "cred-ben")).status).toBe(400);
    expect(await db.$count(users)).toBe(1);
    expect(await db.$count(credentials)).toBe(0);
    expect(await db.$count(sessions)).toBe(1);
  });
});

describe("deactivating a user", () => {
  it("ends every session they have, there and then", async () => {
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    const admin = await signIn(ada.id);
    const benPhone = await signIn(ben.id);
    const benRecovery = await signIn(ben.id, "recovery_password");
    expect(await canReachApp(benPhone.token)).toBe(true);

    const res = await request(`/users/${ben.id}`, { method: "PATCH", token: admin.token, json: { isActive: false } });
    expect(res.status).toBe(200);
    expect((await body(res)).user.isActive).toBe(false);

    // The confirm dialog promises "every session of theirs is ended".
    expect((await sessionsOf(ben.id)).every((s) => s.revokedAt !== null)).toBe(true);
    expect((await request("/dashboard", { token: benPhone.token })).status).toBe(401);
    expect((await request("/invites", { token: benRecovery.token })).status).toBe(401);
    expect((await body(await request("/auth/state", { token: benPhone.token }))).user).toBeNull();

    expect(await canReachApp(admin.token)).toBe(true);

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.entityId, ben.id));
    expect(entry).toMatchObject({
      actorId: ada.id,
      action: "user.update",
      metadata: { isActive: false, revokedSessions: 2, revokedInvites: 0 },
    });
  });

  it("refuses an inactive user's session even if nothing revoked it", async () => {
    // The `is_active` flag flipped some other way — psql, a future route
    // that forgets to revoke. The session lookup is the backstop.
    const ben = await addUser("Ben");
    const { token } = await signIn(ben.id);
    await db.update(users).set({ isActive: false }).where(eq(users.id, ben.id));

    expect((await request("/dashboard", { token })).status).toBe(401);
    expect((await request("/sessions", { token })).status).toBe(401);
  });

  it("will not deactivate yourself", async () => {
    const ada = await addUser("Ada");
    await addUser("Ben");
    const { token } = await signIn(ada.id);

    const res = await request(`/users/${ada.id}`, { method: "PATCH", token, json: { isActive: false } });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toEqual({
      code: "cannot_deactivate_self",
      message: "You can't deactivate yourself.",
    });
    expect(await canReachApp(token)).toBe(true);
  });

  it("withdraws the invites they could come back through", async () => {
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    const admin = await signIn(ada.id);
    const benSession = await signIn(ben.id);
    // One Ben minted himself, one Ada minted for him, one that is neither.
    await mintInvite(benSession.token, { purpose: "new_user" });
    await mintInvite(admin.token, { purpose: "new_device", targetUserId: ben.id });
    const { invite: unrelated } = await body(
      await mintInvite(admin.token, { purpose: "new_device", targetUserId: ada.id }),
    );

    await request(`/users/${ben.id}`, { method: "PATCH", token: admin.token, json: { isActive: false } });

    expect((await db.select().from(invites)).map((i) => i.id)).toEqual([unrelated.id]);
  });

  it("registers no device for them, even from a link minted beforehand", async () => {
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    const admin = await signIn(ada.id);
    const { invite } = await body(await mintInvite(admin.token, { purpose: "new_device", targetUserId: ben.id }));
    const { flowId } = await registerOptions({ inviteCode: invite.code });

    // Deactivated between /options and /verify, by a path that leaves the
    // invite standing — so it is the user check that has to say no.
    await db.update(users).set({ isActive: false }).where(eq(users.id, ben.id));

    const res = await registerVerify(flowId, "cred-ben");
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("invalid_invite");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await sessionsOf(ben.id)).toHaveLength(0);
    expect(await db.$count(credentials, eq(credentials.userId, ben.id))).toBe(0);
    // Rolled back with everything else, not burnt.
    const [row] = await db.select().from(invites).where(eq(invites.id, invite.id));
    expect(row?.consumedAt).toBeNull();

    // And neither end of the link will start a new ceremony for them.
    const again = await request("/auth/register/options", { method: "POST", json: { inviteCode: invite.code } });
    expect(again.status).toBe(400);
    const mint = await mintInvite(admin.token, { purpose: "new_device", targetUserId: ben.id });
    expect(mint.status).toBe(400);
    expect((await body(mint)).error).toEqual({
      code: "inactive_user",
      message: "Ben is deactivated. Reactivate them before adding a device.",
    });
  });

  it("can be undone, and the undoing is logged the same way", async () => {
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    await addCredential(ben.id, "cred-ben");
    const admin = await signIn(ada.id);
    const benOld = await signIn(ben.id);

    await request(`/users/${ben.id}`, { method: "PATCH", token: admin.token, json: { isActive: false } });
    expect((await login("cred-ben")).status).toBe(400);

    const res = await request(`/users/${ben.id}`, { method: "PATCH", token: admin.token, json: { isActive: true } });
    expect(res.status).toBe(200);
    expect((await body(res)).user.isActive).toBe(true);

    // Back in with his passkey; the sessions deactivation ended stay ended.
    const signedIn = await login("cred-ben");
    expect(signedIn.status).toBe(200);
    expect(await canReachApp(cookieToken(signedIn))).toBe(true);
    expect(await canReachApp(benOld.token)).toBe(false);

    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, ben.id), eq(auditLog.action, "user.update")))
      .orderBy(auditLog.createdAt);
    expect(entries.map((e) => e.metadata)).toEqual([
      { isActive: false, revokedSessions: 1, revokedInvites: 0 },
      { isActive: true },
    ]);
  });
});

describe("removing a passkey", () => {
  it("signs out the user's other sessions, but not the one doing the removing", async () => {
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    await addCredential(ada.id, "cred-laptop");
    const lost = await addCredential(ada.id, "cred-lost-phone");
    const laptop = await signIn(ada.id);
    const lostPhone = await signIn(ada.id);
    const otherBrowser = await signIn(ada.id, "recovery_password");
    const benSession = await signIn(ben.id);

    const res = await request(`/credentials/${lost.id}`, { method: "DELETE", token: laptop.token });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, revokedSessions: 2 });

    // A session doesn't record which passkey opened it, so every other one
    // goes — that's the only way to be sure the lost phone's does.
    expect(await canReachApp(lostPhone.token)).toBe(false);
    expect((await request("/sessions", { token: otherBrowser.token })).status).toBe(401);
    expect(await canReachApp(laptop.token)).toBe(true);
    expect(await canReachApp(benSession.token)).toBe(true);

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.entityId, lost.id));
    expect(entry).toMatchObject({ action: "credential.remove", metadata: { revokedSessions: 2 } });
  });

  it("keeps a recovery session that removes the lost passkey", async () => {
    const ada = await addUser("Ada");
    await addCredential(ada.id, "cred-new-phone");
    const lost = await addCredential(ada.id, "cred-lost-phone");
    const lostPhone = await signIn(ada.id);
    const recovery = await signIn(ada.id, "recovery_password");

    const res = await request(`/credentials/${lost.id}`, { method: "DELETE", token: recovery.token });
    expect(res.status).toBe(200);
    expect(await canReachApp(lostPhone.token)).toBe(false);
    expect((await request("/credentials", { token: recovery.token })).status).toBe(200);
  });
});

describe("a device link for another member", () => {
  it("can be minted by either member, and registers the passkey to the member it names", async () => {
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    await addCredential(ben.id, "cred-ben-old");
    const { token } = await signIn(ada.id);

    const minted = await mintInvite(token, { purpose: "new_device", targetUserId: ben.id });
    expect(minted.status).toBe(200);
    const { invite } = await body(minted);
    expect(invite).toMatchObject({ purpose: "new_device", code: expect.any(String) });

    const { flowId, options } = await registerOptions({ inviteCode: invite.code });
    expect(options.user.name).toBe("Ben");
    const res = await registerVerify(flowId, "cred-ben-new");
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(ben.id);
    expect(await db.$count(credentials, eq(credentials.userId, ben.id))).toBe(2);
    expect((await body(await request("/auth/state", { token: cookieToken(res) }))).user.id).toBe(ben.id);
  });

  it("can be minted for another member from a recovery session, as before", async () => {
    // The recovery screen is "pick a user" by design: the one household
    // password may be the way back for whichever member lost their passkeys.
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    const { token } = await signIn(ada.id, "recovery_password");
    expect((await mintInvite(token, { purpose: "new_device", targetUserId: ben.id })).status).toBe(200);
  });
});
