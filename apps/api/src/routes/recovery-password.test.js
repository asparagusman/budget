import { sessions, users } from "@budget/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE } from "../lib/session.js";
import { requireAuth } from "../middleware/auth.js";
import { createTestDb } from "../test/db.js";
import { createAuthRoutes } from "./auth.js";

/** @import { Db } from "@budget/schema" */

// The recovery password is the one credential in this app that is phishable,
// so what it is ALLOWED to do is the security property — not how well it is
// hashed. These tests are mostly about that boundary: a session opened with
// it can get a device approved and nothing else, it cannot change or
// remove itself, and it expires in an hour.
//
// See todo.md #17: the decision was one password, held by one user, that can
// only ever produce another approved device.

const GOOD_PASSWORD = "correct-horse-battery-staple-42";

/** @type {Db} */
let db;
/** @type {() => Promise<void>} */
let close;
/** @type {import("hono").Hono} */
let app;
/** @type {string} */
let userId;

// A stand-in for the guarded API: the same middleware index.js mounts, over
// routes that answer 200 so a 403 can only have come from the guard.
function createGuardedApp() {
  const guarded = new Hono();
  guarded.use("*", requireAuth(db));
  return guarded
    .route("/auth", createAuthRoutes({ db, env: /** @type {any} */ ({ PUBLIC_ORIGIN: "http://budget.local", APP_VERSION: "test" }) }))
    .get("/invites", (c) => c.json({ ok: true }))
    .post("/invites", (c) => c.json({ ok: true }))
    .get("/users", (c) => c.json({ ok: true }))
    .delete("/users/:id", (c) => c.json({ ok: true }))
    .post("/device-requests/:id/approve", (c) => c.json({ ok: true }))
    .get("/dashboard", (c) => c.json({ ok: true }))
    .post("/allocation-versions", (c) => c.json({ ok: true }));
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const [user] = await db.insert(users).values({ displayName: "Ada" }).returning();
  userId = /** @type {string} */ (user?.id);
  app = createGuardedApp();
});

afterEach(async () => {
  await close();
});

/** @param {string} token */
const cookie = (token) => ({ cookie: `${SESSION_COOKIE}=${token}` });

/** @param {"device" | "recovery_password"} authMethod */
async function signIn(authMethod) {
  const { token } = await createSession(db, { userId, userAgent: "test", authMethod });
  return token;
}

/**
 * @param {string} path
 * @param {{ method?: string, token?: string, json?: unknown }} [options]
 */
function request(path, { method = "GET", token, json } = {}) {
  return app.request(path, {
    method,
    headers: {
      ...(token ? cookie(token) : {}),
      ...(json === undefined ? {} : { "content-type": "application/json" }),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

/** @param {Response} res @returns {Promise<any>} */
const body = (res) => res.json();

async function setPassword(/** @type {string} */ token, password = GOOD_PASSWORD) {
  return request("/auth/recovery-password", { method: "PUT", token, json: { password } });
}

describe("setting the recovery password", () => {
  it("requires an approved device, never a recovery session", async () => {
    expect((await setPassword(await signIn("device"))).status).toBe(200);

    const recoveryToken = await signIn("recovery_password");
    const res = await setPassword(recoveryToken, "another-long-enough-password-1");
    expect(res.status).toBe(403);
    // A credential that can change itself is a credential an attacker can
    // keep — the password's own replacement has to cost an approved device.
    expect((await body(res)).error.code).toBe("device_required");
  });

  it("refuses one that is too short or too simple", async () => {
    const token = await signIn("device");
    expect((await setPassword(token, "short")).status).toBe(400);
    // Sixteen of one character is long enough and still not a password.
    expect((await setPassword(token, "aaaaaaaaaaaaaaaaaa")).status).toBe(400);
    // Length, not symbol soup, is what is actually being asked for.
    expect((await setPassword(token, "a-perfectly-fine-recovery-phrase-1")).status).toBe(200);
  });

  it("does not count padding towards the length", async () => {
    expect((await setPassword(await signIn("device"), `   hunter2   `)).status).toBe(400);
  });

  it("stores a salted hash, never the password", async () => {
    await setPassword(await signIn("device"));
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user?.recoveryPasswordHash).toBeTruthy();
    expect(user?.recoveryPasswordHash).not.toContain(GOOD_PASSWORD);
    expect(user?.recoveryPasswordHash?.startsWith("scrypt$")).toBe(true);
    expect(user?.recoveryPasswordSetAt).toBeInstanceOf(Date);
  });

  it("keeps the household to one, and says who holds it", async () => {
    await setPassword(await signIn("device"));

    const [second] = await db.insert(users).values({ displayName: "Ben" }).returning();
    const { token } = await createSession(db, { userId: /** @type {string} */ (second?.id), userAgent: "test" });
    const res = await request("/auth/recovery-password", {
      method: "PUT",
      token,
      json: { password: "a-different-long-password-1" },
    });
    expect(res.status).toBe(400);
    expect((await body(res)).error.message).toContain("Ada already holds");

    const status = await body(await request("/auth/recovery-password"));
    expect(status).toMatchObject({ configured: true, holderDisplayName: "Ada" });
  });

  it("signs out the sessions the old password opened when it is replaced", async () => {
    const deviceToken = await signIn("device");
    await setPassword(deviceToken);
    const recoveryToken = await signIn("recovery_password");
    expect((await request("/invites", { token: recoveryToken })).status).toBe(200);

    // Rotating because the old one got out has to close the door it already
    // opened, the way removing it does — not leave it ajar for the hour.
    expect((await setPassword(deviceToken, "a-second-long-recovery-phrase-2")).status).toBe(200);
    expect((await request("/invites", { token: recoveryToken })).status).toBe(401);
    expect((await request("/dashboard", { token: deviceToken })).status).toBe(200);

    const rows = await db.select().from(sessions).where(eq(sessions.authMethod, "recovery_password"));
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("replaces the holder's own password without complaint", async () => {
    const token = await signIn("device");
    await setPassword(token);
    expect((await setPassword(token, "a-second-long-recovery-phrase-2")).status).toBe(200);

    expect((await request("/auth/login/password", { method: "POST", json: { password: GOOD_PASSWORD } })).status).toBe(400);
    expect(
      (await request("/auth/login/password", { method: "POST", json: { password: "a-second-long-recovery-phrase-2" } }))
        .status,
    ).toBe(200);
  });
});

describe("signing in with it", () => {
  beforeEach(async () => {
    await setPassword(await signIn("device"));
  });

  /** @param {string} password */
  const login = (password) => request("/auth/login/password", { method: "POST", json: { password } });

  it("opens a session marked as a recovery one", async () => {
    const res = await login(GOOD_PASSWORD);
    expect(res.status).toBe(200);
    const payload = await body(res);
    expect(payload.user.displayName).toBe("Ada");
    expect(payload.authMethod).toBe("recovery_password");
    // An hour, not thirty days.
    expect(payload.expiresInSeconds).toBe(3600);

    const rows = await db.select().from(sessions).where(eq(sessions.authMethod, "recovery_password"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expiresAt.getTime()).toBeLessThan(Date.now() + 2 * 60 * 60 * 1000);
  });

  it("refuses the wrong password, and says nothing else", async () => {
    const res = await login("not-the-recovery-password-at-all");
    expect(res.status).toBe(400);
    // The same message a household with no recovery password at all gets:
    // "wrong password" and "no password set" must not be distinguishable.
    expect((await body(res)).error.message).toBe("That is not the recovery password.");
  });

  it("refuses a deactivated holder", async () => {
    await db.update(users).set({ isActive: false }).where(eq(users.id, userId));
    expect((await login(GOOD_PASSWORD)).status).toBe(400);
  });

  it("cannot be used once it has been removed", async () => {
    const deviceToken = await signIn("device");
    const recoveryToken = await body(await login(GOOD_PASSWORD));
    expect(recoveryToken.authMethod).toBe("recovery_password");

    expect((await request("/auth/recovery-password", { method: "DELETE", token: deviceToken })).status).toBe(200);
    expect((await login(GOOD_PASSWORD)).status).toBe(400);

    // And the session it had already opened is revoked with it, rather than
    // being left ajar for the rest of its hour.
    const rows = await db.select().from(sessions).where(eq(sessions.authMethod, "recovery_password"));
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });
});

describe("what a recovery session may reach", () => {
  /** @type {string} */
  let token;

  beforeEach(async () => {
    await setPassword(await signIn("device"));
    token = await signIn("recovery_password");
  });

  it("can do the things that get a device approved", async () => {
    expect((await request("/invites", { token })).status).toBe(200);
    expect((await request("/invites", { method: "POST", token })).status).toBe(200);
    expect((await request("/users", { token })).status).toBe(200);
    expect((await request("/device-requests/some-id/approve", { method: "POST", token })).status).toBe(200);
  });

  it("cannot reach a single figure in the app", async () => {
    const res = await request("/dashboard", { token });
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("recovery_session_limited");
    expect((await request("/allocation-versions", { method: "POST", token })).status).toBe(403);
  });

  it("cannot deactivate anyone, even though it can list users", async () => {
    // Read to pick whose device it is; nothing more. Otherwise a phished
    // password could lock the household out of its own recovery.
    expect((await request(`/users/${userId}`, { method: "DELETE", token })).status).toBe(403);
  });

  it("lets an approved device through to everything", async () => {
    const device = await signIn("device");
    expect((await request("/dashboard", { token: device })).status).toBe(200);
    expect((await request(`/users/${userId}`, { method: "DELETE", token: device })).status).toBe(200);
  });

  it("tells /auth/state how the browser signed in", async () => {
    expect((await body(await request("/auth/state", { token }))).authMethod).toBe("recovery_password");
    expect((await body(await request("/auth/state", { token: await signIn("device") }))).authMethod).toBe("device");
  });
});
