import { accounts, people } from "@budget/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { createAccountsRoutes } from "./accounts.js";
import { createPeopleRoutes } from "./people.js";

/** @import { Db } from "@budget/schema" */

// Reordering is the one write in the app that is about the list rather than
// about a row, and that is what makes it worth testing: every row created
// through the API takes the column default of 0, so the interesting cases are
// "the list has never been ordered" and "the request does not describe the
// whole list".

/** @type {Db} */
let db;
/** @type {() => Promise<void>} */
let close;
/** @type {import("hono").Hono} */
let app;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  app = new Hono().route("/people", createPeopleRoutes({ db })).route("/accounts", createAccountsRoutes({ db }));
});

afterEach(async () => {
  await close();
});

/**
 * `app.request()` on a bare Hono instance types its body as `unknown` — the
 * route generics that make `hc` typed are not in play here. These tests are
 * about the order that comes back, so the body is read as-is.
 *
 * @param {Response} res
 * @returns {Promise<any>}
 */
function body(res) {
  return res.json();
}

/**
 * @param {string} path
 * @param {string[]} ids
 */
function reorder(path, ids) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

describe("POST /people/reorder", () => {
  /** @type {string[]} */
  let ids;

  beforeEach(async () => {
    // Every one at sortOrder 0, which is what the API's own POST produces —
    // the state a swap-two-neighbours implementation would be unable to
    // change at all.
    const rows = await db
      .insert(people)
      .values([{ name: "Ada" }, { name: "Ben" }, { name: "Cass" }])
      .returning();
    ids = rows.map((row) => row.id);
    expect(rows.map((row) => row.sortOrder)).toEqual([0, 0, 0]);
  });

  /** @param {string[]} order */
  async function namesAfter(order) {
    const res = await reorder("/people/reorder", order);
    expect(res.status).toBe(200);
    const listed = await app.request("/people");
    return (await body(listed)).people.map((/** @type {any} */ p) => p.name);
  }

  it("renumbers the whole list from a flat zero", async () => {
    const [ada, ben, cass] = ids;
    expect(await namesAfter([/** @type {string} */ (cass), /** @type {string} */ (ada), /** @type {string} */ (ben)])).toEqual([
      "Cass",
      "Ada",
      "Ben",
    ]);
    const rows = await db.query.people.findMany({ orderBy: (p, { asc }) => [asc(p.sortOrder)] });
    expect(rows.map((r) => r.sortOrder)).toEqual([0, 1, 2]);
  });

  it("is what GET /people then reports, not just what the column holds", async () => {
    const reversed = [...ids].reverse();
    expect(await namesAfter(/** @type {string[]} */ (reversed))).toEqual(["Cass", "Ben", "Ada"]);
  });

  it("refuses a list that leaves someone out", async () => {
    // The omitted person would keep whatever position they had, which is now
    // someone else's — and the list would come back in an order nobody chose.
    const res = await reorder("/people/reorder", [/** @type {string} */ (ids[0]), /** @type {string} */ (ids[1])]);
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("incomplete_order");
  });

  it("refuses a list that names someone twice", async () => {
    const res = await reorder("/people/reorder", [
      /** @type {string} */ (ids[0]),
      /** @type {string} */ (ids[0]),
      /** @type {string} */ (ids[1]),
    ]);
    expect(res.status).toBe(400);
  });

  it("refuses a list containing someone who is not in it", async () => {
    const res = await reorder("/people/reorder", [
      /** @type {string} */ (ids[0]),
      /** @type {string} */ (ids[1]),
      "00000000-0000-4000-8000-00000000dead",
    ]);
    expect(res.status).toBe(400);
  });

  it("ignores archived people on both sides", async () => {
    await db.update(people).set({ archivedAt: new Date() }).where(eq(people.id, /** @type {string} */ (ids[1])));
    // An archived person is not in the list the operator can see, so the
    // complete order is the two who remain — and sending them must succeed.
    const res = await reorder("/people/reorder", [/** @type {string} */ (ids[2]), /** @type {string} */ (ids[0])]);
    expect(res.status).toBe(200);
    const listed = await app.request("/people");
    expect((await body(listed)).people.map((/** @type {any} */ p) => p.name)).toEqual(["Cass", "Ada"]);
  });
});

describe("POST /accounts/reorder", () => {
  it("renumbers accounts and leaves everything else about them alone", async () => {
    const rows = await db
      .insert(accounts)
      .values([
        { name: "Everyday", type: "transaction", isIncomeLanding: true },
        { name: "Savings", type: "savings" },
        { name: "Mojo", type: "savings" },
      ])
      .returning();
    const ids = rows.map((row) => row.id);

    const res = await reorder("/accounts/reorder", [
      /** @type {string} */ (ids[2]),
      /** @type {string} */ (ids[0]),
      /** @type {string} */ (ids[1]),
    ]);
    expect(res.status).toBe(200);

    const listed = await app.request("/accounts");
    const listedBody = await body(listed);
    expect(listedBody.accounts.map((/** @type {any} */ a) => a.name)).toEqual(["Mojo", "Everyday", "Savings"]);
    // The income-landing flag is guarded by a partial unique index; a
    // reorder that touched it would fail loudly, but one that silently
    // cleared it would not.
    expect(listedBody.accounts.find((/** @type {any} */ a) => a.name === "Everyday").isIncomeLanding).toBe(true);
  });
});
