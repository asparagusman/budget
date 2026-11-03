import { mustAt } from "@budget/engine";
import { auditLog, deviceRequests, invites, sessions, users } from "@budget/schema";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_REQUEST_COOKIE, MAX_PENDING_DEVICE_REQUESTS } from "../lib/device-request.js";
import { createSession, SESSION_COOKIE, setSecureCookies } from "../lib/session.js";
import { requireAuth } from "../middleware/auth.js";
import { createTestDb } from "../test/db.js";
import { createAuthRoutes } from "./auth.js";
import { createDeviceRequestsRoutes } from "./device-requests.js";
import { createInvitesRoutes } from "./invites.js";
import { createSessionsRoutes } from "./sessions.js";
import { createUsersRoutes } from "./users.js";

/** @import { Db } from "@budget/schema" */

// Who can get in, and who can still get in after the household changes its
// mind: the first device, a device someone approved, a link opened twice, a
// deactivated user, a device that was signed out. Each of these was a way to
// stay signed in, or to be locked out, that the screens say cannot happen.

// A test file asks to join far more often a minute than any person could,
// and the limiter is not what is under test here.
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
    .route("/auth", createAuthRoutes({ db, env: /** @type {any} */ ({ PUBLIC_ORIGIN: "http://budget.local" }) }))
    .route("/users", createUsersRoutes({ db }))
    .route("/invites", createInvitesRoutes({ db }))
    .route("/device-requests", createDeviceRequestsRoutes({ db }))
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
  await db.execute(sql`truncate table users, sessions, device_requests, invites, audit_log cascade`);
});

afterEach(() => {
  setSecureCookies(true);
});

/**
 * @param {string} path
 * @param {{ method?: string, token?: string, requestToken?: string, json?: unknown }} [options]
 */
function request(path, { method = "GET", token, requestToken, json } = {}) {
  const cookies = [
    ...(token ? [`${SESSION_COOKIE}=${token}`] : []),
    ...(requestToken ? [`${DEVICE_REQUEST_COOKIE}=${requestToken}`] : []),
  ];
  return app.request(path, {
    method,
    headers: {
      "user-agent": "Mozilla/5.0 (iPhone)",
      ...(cookies.length > 0 ? { cookie: cookies.join("; ") } : {}),
      ...(json === undefined ? {} : { "content-type": "application/json" }),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

/** @param {Response} res @returns {Promise<any>} */
const body = (res) => res.json();

/**
 * The value a response set for `name`, or null when it set none (or cleared it).
 *
 * @param {Response} res
 * @param {string} name
 */
function cookieValue(res, name) {
  const value = new RegExp(`${name}=([^;]*)`).exec(res.headers.get("set-cookie") ?? "")?.[1];
  return value ? value : null;
}

/** @param {Response} res */
function sessionToken(res) {
  const token = cookieValue(res, SESSION_COOKIE);
  if (!token) throw new Error("No session cookie was set.");
  return token;
}

/** @param {string} displayName @param {{ isActive?: boolean }} [options] */
async function addUser(displayName, { isActive = true } = {}) {
  return mustAt(await db.insert(users).values({ displayName, isActive }).returning(), 0, "user");
}

/**
 * @param {string} userId
 * @param {"device" | "recovery_password"} [authMethod]
 */
async function signIn(userId, authMethod = "device") {
  const { token, session } = await createSession(db, {
    userId,
    userAgent: "test",
    deviceName: "Laptop",
    authMethod,
  });
  return { token, sessionId: session.id };
}

/** @param {string} token */
const canReachApp = async (token) => (await request("/dashboard", { token })).status === 200;

/**
 * A signed-out device asking to join. Returns its request cookie and what it
 * was shown.
 *
 * @param {string} [deviceName]
 */
async function askToJoin(deviceName = "Ben's phone") {
  const res = await request("/auth/device-requests", { method: "POST", json: { deviceName } });
  expect(res.status).toBe(200);
  const requestToken = cookieValue(res, DEVICE_REQUEST_COOKIE);
  if (!requestToken) throw new Error("No device request cookie was set.");
  return { requestToken, request: (await body(res)).request };
}

/** @param {string} requestToken */
const poll = (requestToken) => request("/auth/device-requests/current", { requestToken });

/**
 * @param {string} token
 * @param {string} id
 * @param {{ userId: string } | { newUserDisplayName: string }} json
 */
const approve = (token, id, json) => request(`/device-requests/${id}/approve`, { method: "POST", token, json });

/**
 * @param {string} token
 * @param {{ purpose: "new_user" } | { purpose: "new_device", targetUserId: string }} json
 */
function mintInvite(token, json) {
  return request("/invites", { method: "POST", token, json });
}

/**
 * @param {string} code
 * @param {{ displayName?: string, deviceName?: string }} [json]
 */
const redeem = (code, json = {}) => request(`/auth/invite/${code}/redeem`, { method: "POST", json });

/** @param {string} userId */
const sessionsOf = (userId) => db.select().from(sessions).where(eq(sessions.userId, userId));

describe("bootstrap", () => {
  it("signs the first user in on this device, and closes for good", async () => {
    const res = await request("/auth/bootstrap", { method: "POST", json: { displayName: "Ada" } });
    expect(res.status).toBe(200);
    expect(await canReachApp(sessionToken(res))).toBe(true);

    const [session] = await db.select().from(sessions);
    expect(session).toMatchObject({ authMethod: "device", deviceName: "iPhone" });
    expect((await body(await request("/auth/state"))).needsBootstrap).toBe(false);

    const late = await request("/auth/bootstrap", { method: "POST", json: { displayName: "Mallory" } });
    expect(late.status).toBe(400);
    expect((await body(late)).error.code).toBe("bootstrap_closed");
    expect(late.headers.get("set-cookie")).toBeNull();
    expect((await db.select().from(users)).map((u) => u.displayName)).toEqual(["Ada"]);
  });

  it("lets only one of two simultaneous first visitors become the first user", async () => {
    const results = await Promise.all([
      request("/auth/bootstrap", { method: "POST", json: { displayName: "Ada" } }),
      request("/auth/bootstrap", { method: "POST", json: { displayName: "Mallory" } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await db.$count(users)).toBe(1);
    expect(await db.$count(sessions)).toBe(1);
  });

  it("uses plain cookies when the household's address is plain http", async () => {
    setSecureCookies(false);
    const res = await request("/auth/bootstrap", { method: "POST", json: { displayName: "Ada" } });
    expect(res.headers.get("set-cookie")).not.toMatch(/Secure/i);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  });
});

describe("asking to join", () => {
  it("has no one to ask before the household is set up", async () => {
    const res = await request("/auth/device-requests", { method: "POST", json: { deviceName: "Phone" } });
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("needs_bootstrap");
  });

  it("waits, shows its code to members, and signs in as whoever an approver chose", async () => {
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    const admin = await signIn(ada.id);
    const { requestToken, request: shown } = await askToJoin("Ben's phone");
    expect(shown.code).toMatch(/^[A-Z2-9]{4}$/);

    // Waiting: nothing yet, and nothing for anyone signed out to see.
    expect(await body(await poll(requestToken))).toMatchObject({ status: "pending", request: { code: shown.code } });
    expect((await request("/device-requests")).status).toBe(401);
    const listed = await body(await request("/device-requests", { token: admin.token }));
    expect(listed.requests).toEqual([expect.objectContaining({ id: shown.id, code: shown.code, deviceName: "Ben's phone" })]);

    expect((await approve(admin.token, shown.id, { userId: ben.id })).status).toBe(200);
    expect((await body(await request("/device-requests", { token: admin.token }))).requests).toEqual([]);

    const collected = await poll(requestToken);
    expect(await body(collected)).toEqual({
      status: "approved",
      user: { id: ben.id, displayName: "Ben", email: null },
    });
    const token = sessionToken(collected);
    expect((await body(await request("/auth/state", { token }))).user.id).toBe(ben.id);
    expect(await sessionsOf(ben.id)).toEqual([expect.objectContaining({ deviceName: "Ben's phone", authMethod: "device" })]);

    // Collected once: the request is gone, and so is its cookie.
    expect(await db.$count(deviceRequests)).toBe(0);
    expect(cookieValue(collected, DEVICE_REQUEST_COOKIE)).toBeNull();
    expect(await body(await poll(requestToken))).toEqual({ status: "none" });
    expect(await sessionsOf(ben.id)).toHaveLength(1);

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "device_request.approve"));
    expect(entry).toMatchObject({ actorId: ada.id, metadata: { userId: ben.id, deviceName: "Ben's phone" } });
  });

  it("can bring someone new into the household", async () => {
    const ada = await addUser("Ada");
    const admin = await signIn(ada.id);
    const { requestToken, request: shown } = await askToJoin("Grace's phone");

    expect((await approve(admin.token, shown.id, { newUserDisplayName: "Grace" })).status).toBe(200);
    const collected = await body(await poll(requestToken));
    expect(collected.user.displayName).toBe("Grace");
    expect((await db.select().from(users)).map((u) => u.displayName).sort()).toEqual(["Ada", "Grace"]);
  });

  it("is told so when it is turned down", async () => {
    const ada = await addUser("Ada");
    const admin = await signIn(ada.id);
    const { requestToken, request: shown } = await askToJoin();

    expect((await request(`/device-requests/${shown.id}`, { method: "DELETE", token: admin.token })).status).toBe(200);
    expect(await body(await poll(requestToken))).toEqual({ status: "none" });
    expect(await db.$count(sessions)).toBe(1);
    // And a refused request can't be approved after the fact.
    expect((await approve(admin.token, shown.id, { userId: ada.id })).status).toBe(404);
  });

  it("cannot be approved twice, or once it has run out", async () => {
    const ada = await addUser("Ada");
    const admin = await signIn(ada.id);
    const first = await askToJoin();
    expect((await approve(admin.token, first.request.id, { userId: ada.id })).status).toBe(200);
    expect((await approve(admin.token, first.request.id, { newUserDisplayName: "Eve" })).status).toBe(404);
    // The second approval's new user was rolled back with it.
    expect(await db.$count(users)).toBe(1);

    const stale = await askToJoin("Old tablet");
    await db
      .update(deviceRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceRequests.id, stale.request.id));
    expect((await approve(admin.token, stale.request.id, { userId: ada.id })).status).toBe(404);
    expect(await body(await poll(stale.requestToken))).toEqual({ status: "none" });
  });

  it("replaces this browser's earlier request when it asks again", async () => {
    await addUser("Ada");
    const first = await askToJoin("Phone");
    const res = await request("/auth/device-requests", {
      method: "POST",
      requestToken: first.requestToken,
      json: { deviceName: "Ben's phone" },
    });
    expect(res.status).toBe(200);
    expect((await db.select().from(deviceRequests)).map((r) => r.deviceName)).toEqual(["Ben's phone"]);
  });

  it("caps how many devices can wait at once", async () => {
    await addUser("Ada");
    for (let i = 0; i < MAX_PENDING_DEVICE_REQUESTS; i += 1) await askToJoin(`Device ${i}`);
    const res = await request("/auth/device-requests", { method: "POST", json: { deviceName: "One more" } });
    expect(res.status).toBe(429);
    expect((await body(res)).error.code).toBe("too_many_requests");
  });

  it("will not sign a device in for a deactivated member", async () => {
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    const admin = await signIn(ada.id);

    const early = await askToJoin();
    await db.update(users).set({ isActive: false }).where(eq(users.id, ben.id));
    const refused = await approve(admin.token, early.request.id, { userId: ben.id });
    expect(refused.status).toBe(400);
    expect((await body(refused)).error.code).toBe("inactive_user");

    // Approved first, deactivated before the device collected it.
    await db.update(users).set({ isActive: true }).where(eq(users.id, ben.id));
    await approve(admin.token, early.request.id, { userId: ben.id });
    await request(`/users/${ben.id}`, { method: "PATCH", token: admin.token, json: { isActive: false } });
    const collected = await poll(early.requestToken);
    expect(await body(collected)).toEqual({ status: "none" });
    expect(collected.headers.get("set-cookie") ?? "").not.toContain(`${SESSION_COOKIE}=`);
    expect(await sessionsOf(ben.id)).toHaveLength(0);
  });

  it("can be answered from a recovery session", async () => {
    const ada = await addUser("Ada");
    const recovery = await signIn(ada.id, "recovery_password");
    const { requestToken, request: shown } = await askToJoin("New phone");

    expect((await approve(recovery.token, shown.id, { userId: ada.id })).status).toBe(200);
    const token = sessionToken(await poll(requestToken));
    expect(await canReachApp(token)).toBe(true);
  });
});

describe("redeeming an invite", () => {
  it("signs in once, however many times the link was opened", async () => {
    const ada = await addUser("Ada");
    const { token } = await signIn(ada.id, "recovery_password");
    const { invite } = await body(await mintInvite(token, { purpose: "new_user" }));

    const first = await redeem(invite.code, { displayName: "Ben" });
    expect(first.status).toBe(200);
    expect(await canReachApp(sessionToken(first))).toBe(true);

    const late = await redeem(invite.code, { displayName: "Eve" });
    expect(late.status).toBe(400);
    expect((await body(late)).error).toEqual({
      code: "invalid_invite",
      message: "This invite is invalid, expired or already used.",
    });
    expect((await db.select().from(users)).map((u) => u.displayName).sort()).toEqual(["Ada", "Ben"]);
  });

  it("refuses one that has expired, and writes nothing", async () => {
    const ada = await addUser("Ada");
    const { token } = await signIn(ada.id);
    const { invite } = await body(await mintInvite(token, { purpose: "new_user" }));
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, invite.id));

    expect((await redeem(invite.code, { displayName: "Ben" })).status).toBe(400);
    expect(await db.$count(users)).toBe(1);
    expect(await db.$count(sessions)).toBe(1);
  });

  it("signs a new_device link in as the member it names", async () => {
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    const { token } = await signIn(ada.id);
    const { invite } = await body(await mintInvite(token, { purpose: "new_device", targetUserId: ben.id }));

    const res = await redeem(invite.code, { deviceName: "Ben's tablet" });
    expect(res.status).toBe(200);
    expect((await body(res)).user.id).toBe(ben.id);
    expect(await sessionsOf(ben.id)).toEqual([expect.objectContaining({ deviceName: "Ben's tablet" })]);
  });

  it("signs nobody in for a deactivated member, and does not burn the link", async () => {
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    const admin = await signIn(ada.id);
    const { invite } = await body(await mintInvite(admin.token, { purpose: "new_device", targetUserId: ben.id }));
    // Deactivated by a path that leaves the invite standing — so it is the
    // user check that has to say no.
    await db.update(users).set({ isActive: false }).where(eq(users.id, ben.id));

    const res = await redeem(invite.code);
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("invalid_invite");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await sessionsOf(ben.id)).toHaveLength(0);
    const [row] = await db.select().from(invites).where(eq(invites.id, invite.id));
    expect(row?.consumedAt).toBeNull();

    const mint = await mintInvite(admin.token, { purpose: "new_device", targetUserId: ben.id });
    expect(mint.status).toBe(400);
    expect((await body(mint)).error).toEqual({
      code: "inactive_user",
      message: "Ben is deactivated. Reactivate them before adding a device.",
    });
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

    // The confirm dialog promises "signed out on every device".
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

  it("can be undone, and the undoing is logged the same way", async () => {
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    const admin = await signIn(ada.id);
    const benOld = await signIn(ben.id);

    await request(`/users/${ben.id}`, { method: "PATCH", token: admin.token, json: { isActive: false } });
    const res = await request(`/users/${ben.id}`, { method: "PATCH", token: admin.token, json: { isActive: true } });
    expect(res.status).toBe(200);
    expect((await body(res)).user.isActive).toBe(true);

    // Back in on a newly approved device; the sessions deactivation ended stay ended.
    const { requestToken, request: shown } = await askToJoin();
    await approve(admin.token, shown.id, { userId: ben.id });
    expect(await canReachApp(sessionToken(await poll(requestToken)))).toBe(true);
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

describe("my devices", () => {
  it("lists only your own signed-in devices, and counts them on the users list", async () => {
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    const laptop = await signIn(ada.id);
    await signIn(ada.id, "recovery_password");
    await signIn(ben.id);

    const { sessions: listed } = await body(await request("/sessions", { token: laptop.token }));
    expect(listed).toHaveLength(2);
    expect(listed.find((/** @type {any} */ s) => s.isCurrent)).toMatchObject({ deviceName: "Laptop" });

    const { users: listedUsers } = await body(await request("/users", { token: laptop.token }));
    expect(listedUsers.map((/** @type {any} */ u) => [u.displayName, u.deviceCount])).toEqual([
      ["Ada", 1],
      ["Ben", 1],
    ]);
  });

  it("renames a device, and signs out one that was lost", async () => {
    const ada = await addUser("Ada");
    const laptop = await signIn(ada.id);
    const lostPhone = await signIn(ada.id);

    const renamed = await request(`/sessions/${laptop.sessionId}`, {
      method: "PATCH",
      token: laptop.token,
      json: { deviceName: "Ada's laptop" },
    });
    expect((await body(renamed)).session.deviceName).toBe("Ada's laptop");

    expect((await request(`/sessions/${lostPhone.sessionId}`, { method: "DELETE", token: laptop.token })).status).toBe(200);
    expect(await canReachApp(lostPhone.token)).toBe(false);
    expect(await canReachApp(laptop.token)).toBe(true);
  });

  it("cannot sign out or rename someone else's device", async () => {
    const ada = await addUser("Ada");
    const ben = await addUser("Ben");
    const mine = await signIn(ada.id);
    const his = await signIn(ben.id);

    expect((await request(`/sessions/${his.sessionId}`, { method: "DELETE", token: mine.token })).status).toBe(404);
    expect(
      (await request(`/sessions/${his.sessionId}`, { method: "PATCH", token: mine.token, json: { deviceName: "x" } }))
        .status,
    ).toBe(404);
    expect(await canReachApp(his.token)).toBe(true);
  });

  it("stays signed in while it keeps being used", async () => {
    const ada = await addUser("Ada");
    const { token, sessionId } = await signIn(ada.id);
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000), expiresAt: soon })
      .where(eq(sessions.id, sessionId));

    const res = await request("/dashboard", { token });
    expect(res.status).toBe(200);
    expect(cookieValue(res, SESSION_COOKIE)).toBe(token);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 300 * 24 * 60 * 60 * 1000);
  });
});
