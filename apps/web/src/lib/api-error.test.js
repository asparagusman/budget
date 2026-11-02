import { describe, expect, it } from "vitest";
import { ApiError, ApiUnreachableError, apiErrorFrom, readApiError, withUnreachable } from "./api-error.js";

// The two ways a request fails, kept apart on purpose: the server answered
// and said no, or nothing answered at all. They need different words on
// screen and different remedies, and collapsing them is why a stopped API
// dev server used to surface as an unexplained blank page.

describe("readApiError", () => {
  it("uses the message the API sent", async () => {
    const res = new Response(JSON.stringify({ error: { code: "not_found", message: "Bill not found." } }), {
      status: 404,
    });
    expect(await readApiError(res)).toBe("Bill not found.");
  });

  it("falls back when the body is not our error shape at all", async () => {
    // A proxy's own HTML error page, or an empty 502 — there is no message to
    // read, and showing "undefined" is worse than showing nothing specific.
    expect(await readApiError(new Response("<html>502</html>", { status: 502 }))).toBe("Something went wrong.");
    expect(await readApiError(new Response(JSON.stringify({ oops: true })))).toBe("Something went wrong.");
    expect(await readApiError(new Response(JSON.stringify({ error: { code: "x" } })))).toBe(
      "Something went wrong.",
    );
  });
});

describe("apiErrorFrom", () => {
  it("keeps the status and code a caller may need to act on", async () => {
    const err = await apiErrorFrom(
      new Response(
        JSON.stringify({ error: { code: "no_income_landing_account", message: "Mark an account first." } }),
        { status: 400 },
      ),
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("Mark an account first.");
    expect(err.status).toBe(400);
    expect(err.code).toBe("no_income_landing_account");
  });

  it("still carries the status when the body is not our error shape", async () => {
    const err = await apiErrorFrom(new Response("<html>502</html>", { status: 502 }));
    expect(err.message).toBe("Something went wrong.");
    expect(err.status).toBe(502);
    expect(err.code).toBeNull();
  });
});

describe("withUnreachable", () => {
  it("passes a successful result straight through", async () => {
    expect(await withUnreachable(async () => 42)).toBe(42);
  });

  it("turns fetch's bare TypeError into something the UI can branch on", async () => {
    const cause = new TypeError("Failed to fetch");
    await expect(
      withUnreachable(async () => {
        throw cause;
      }),
    ).rejects.toBeInstanceOf(ApiUnreachableError);
    // The real reason is kept, so the console still shows what actually
    // happened rather than only our friendlier sentence.
    await withUnreachable(async () => {
      throw cause;
    }).catch((err) => expect(err.cause).toBe(cause));
  });

  it("leaves an error that already means something alone", async () => {
    // An abort, or an error we threw ourselves, is not a transport failure —
    // reclassifying it would hide the real problem behind "can't reach the
    // server".
    const meaningful = new Error("Version was already applied.");
    await expect(
      withUnreachable(async () => {
        throw meaningful;
      }),
    ).rejects.toBe(meaningful);

    const alreadyUnreachable = new ApiUnreachableError();
    await expect(
      withUnreachable(async () => {
        throw alreadyUnreachable;
      }),
    ).rejects.toBe(alreadyUnreachable);
  });
});
