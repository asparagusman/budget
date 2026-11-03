import { describe, expect, it, vi } from "vitest";
import { createExpiryRedirect, isSignedOutScreen, withSessionExpiry } from "./session-expiry.js";

// A session that ends under an open tab — 30 days up, or revoked from the
// other phone — has to land the operator on the sign-in screen, once. Before
// this, every query on the screen failed separately and each rendered its own
// error or empty state, and nothing said "you've been signed out".

/** @param {number} status */
function respondWith(status) {
  return vi.fn(async () => new Response("{}", { status }));
}

describe("withSessionExpiry", () => {
  it("reports a 401 from an ordinary API request", async () => {
    const onUnauthorized = vi.fn();
    const wrapped = withSessionExpiry({
      fetch: respondWith(401),
      apiBase: "http://localhost:3000",
      origin: "http://localhost:5173",
      onUnauthorized,
    });
    const res = await wrapped("http://localhost:3000/dashboard?on=2026-10-07");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    // The caller still gets its own failure to handle.
    expect(res.status).toBe(401);
  });

  it("leaves /auth/* alone, where a 401 is an answer rather than an expiry", async () => {
    // A wrong recovery password, a turned-down device, the signed-out
    // probe of /auth/state: none of these mean "your session just ended".
    const onUnauthorized = vi.fn();
    const wrapped = withSessionExpiry({
      fetch: respondWith(401),
      apiBase: "http://localhost:3000",
      origin: "http://localhost:5173",
      onUnauthorized,
    });
    await wrapped("http://localhost:3000/auth/state");
    await wrapped("http://localhost:3000/auth/login/verify", { method: "POST" });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("reads paths relative to an API mounted under a prefix", async () => {
    // Production serves the API at /api behind nginx, so /api/auth/state is
    // the auth probe and /api/goals is not.
    const onUnauthorized = vi.fn();
    const wrapped = withSessionExpiry({
      fetch: respondWith(401),
      apiBase: "/api",
      origin: "https://budget.example.ts.net",
      onUnauthorized,
    });
    await wrapped("/api/auth/state");
    expect(onUnauthorized).not.toHaveBeenCalled();
    await wrapped(new URL("https://budget.example.ts.net/api/goals"));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("ignores every other status, a 403 included", async () => {
    // 403 is a recovery-password session reaching past its one screen — still
    // signed in, so sending it to /login would be wrong.
    const onUnauthorized = vi.fn();
    for (const status of [200, 400, 403, 404, 500]) {
      const wrapped = withSessionExpiry({
        fetch: respondWith(status),
        apiBase: "http://localhost:3000",
        origin: "http://localhost:5173",
        onUnauthorized,
      });
      await wrapped("http://localhost:3000/goals");
    }
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("createExpiryRedirect", () => {
  it("redirects once however many requests fail together", async () => {
    let resolve = () => {};
    const redirect = vi.fn(() => new Promise((r) => (resolve = () => r(undefined))));
    const handle = createExpiryRedirect({ currentPath: () => "/goals", isSignedIn: () => true, redirect });
    // Every query on a screen fails at the same moment.
    handle();
    handle();
    handle();
    expect(redirect).toHaveBeenCalledTimes(1);

    // Once that navigation has settled, a later expiry is news again.
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    handle();
    expect(redirect).toHaveBeenCalledTimes(2);
  });

  it("stays put on the screens that need no session", () => {
    const redirect = vi.fn();
    for (const path of ["/login", "/invite/abc123"]) {
      createExpiryRedirect({ currentPath: () => path, isSignedIn: () => true, redirect })();
    }
    // An invitee with no account yet 401s on /settings; bouncing them to
    // /login would make the invite impossible to redeem.
    expect(redirect).not.toHaveBeenCalled();
  });

  it("leaves a visitor who was never signed in to the router", () => {
    // A cookie that lapsed between monthly visits: /settings 401s before the
    // router's own check answers, and "you've been signed out" would be news
    // about a session this page never had.
    const redirect = vi.fn();
    createExpiryRedirect({ currentPath: () => "/", isSignedIn: () => false, redirect })();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("isSignedOutScreen", () => {
  it("does not mistake an app page for one", () => {
    expect(isSignedOutScreen("/")).toBe(false);
    expect(isSignedOutScreen("/admin/invites")).toBe(false);
    expect(isSignedOutScreen("/invite")).toBe(false);
    // A recovery session runs out after an hour; a 401 there is real.
    expect(isSignedOutScreen("/recovery")).toBe(false);
  });
});
