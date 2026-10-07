import { zValidator } from "@hono/zod-validator";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAccountsRoutes } from "../routes/accounts.js";
import { createTestDb } from "../test/db.js";
import { handleAppError } from "./db-errors.js";
import { handleValidation } from "./validation.js";

/** @import { Db } from "@budget/schema" */

// The app's last-resort error handler, against real Postgres errors. Two
// things are under test: that what a request got wrong answers 4xx rather
// than "Something went wrong", and that what reaches the log never includes
// a query's parameters — in this app those are household figures.

/** @type {Db} */
let db;
/** @type {() => Promise<void>} */
let close;
/** @type {import("hono").Hono} */
let app;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // Throwaway tables, so the foreign-key cases don't depend on which of the
  // app's own constraints happen to be RESTRICT today.
  await db.execute(sql`create table probe_parent (id int primary key)`);
  await db.execute(sql`create table probe_child (parent_id int not null references probe_parent (id))`);
  await db.execute(sql`insert into probe_parent (id) values (1)`);
  await db.execute(sql`insert into probe_child (parent_id) values (1)`);

  app = new Hono()
    // A real route with a path id and no validation in front of it — the
    // case this handler exists for.
    .route("/accounts", createAccountsRoutes({ db }))
    .post("/probe/out-of-range", async (c) => {
      // 424242 is the figure that must not be logged; the second value is
      // the one Postgres rejects.
      await db.execute(sql`select ${"424242"}::int as kept, ${"98765432109876543210"}::int as rejected`);
      return c.json({ ok: true });
    })
    .post("/probe/missing-parent", async (c) => {
      await db.execute(sql`insert into probe_child (parent_id) values (${2})`);
      return c.json({ ok: true });
    })
    .post("/probe/referenced-parent", async (c) => {
      await db.execute(sql`delete from probe_parent where id = ${1}`);
      return c.json({ ok: true });
    })
    // Every body in the app goes through zValidator, which throws an
    // HTTPException on JSON it can't parse.
    .post("/probe/json", zValidator("json", z.object({ a: z.number() }), handleValidation), (c) =>
      c.json({ ok: true }),
    )
    .get("/probe/bug", () => {
      throw new TypeError("a bug");
    })
    .onError(handleAppError);
});

afterAll(async () => {
  await close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Captures what the handler logs, as one string. */
function captureErrorLog() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
}

describe("handleAppError", () => {
  it("answers a non-UUID path id with 400, not 500", async () => {
    const logged = captureErrorLog();
    const res = await app.request("/accounts/not-a-uuid");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_id", message: "That id isn't valid." },
    });
    expect(logged()).toContain("[22P02]");
  });

  it("answers a numeric overflow with 400 and never logs the query's parameters", async () => {
    const logged = captureErrorLog();
    const res = await app.request("/probe/out-of-range", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "out_of_range", message: "A number is out of range." },
    });
    expect(logged()).toContain("[22003]");
    // DrizzleQueryError's own message is "Failed query: … params: 424242,…".
    expect(logged()).not.toContain("424242");
    expect(logged()).not.toContain("params");
  });

  it("answers a reference to a missing row with 400", async () => {
    captureErrorLog();
    const res = await app.request("/probe/missing-parent", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_reference", message: "That refers to something that doesn't exist." },
    });
  });

  it("answers removing a row something still references with 409, not 'doesn't exist'", async () => {
    captureErrorLog();
    const res = await app.request("/probe/referenced-parent", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "still_referenced" } });
  });

  it("answers malformed JSON with 400 in the API's error shape", async () => {
    const logged = captureErrorLog();
    const res = await app.request("/probe/json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_request", message: "Malformed JSON in request body" },
    });
    // The caller's mistake, not the server's: nothing to log.
    expect(logged()).toBe("");
  });

  it("keeps a plain bug a 500, with its stack in the log", async () => {
    const logged = captureErrorLog();
    const res = await app.request("/probe/bug");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "internal_error", message: "Something went wrong." },
    });
    expect(logged()).toMatch(/GET \/probe\/bug failed: TypeError: a bug\n\s+at /);
  });
});
