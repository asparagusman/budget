import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { HOUSEHOLD_IDS as ID, ON, seedHousehold } from "../test/household.js";
import { createHouseRoutes } from "./house.js";

/** @import { Db } from "@budget/schema" */

/** @type {Db} */
let db;
/** @type {() => Promise<void>} */
let close;
/** @type {import("hono").Hono} */
let app;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedHousehold(db);
  app = new Hono().route("/house", createHouseRoutes({ db }));
});

afterAll(async () => {
  await close();
});

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [json]
 */
async function send(method, path, json) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  /** @type {any} */
  const body = await res.json();
  return { status: res.status, body };
}

const SETTINGS = {
  incomeVariantId: ID.usual,
  stopCategoryIds: [ID.insurance],
  keepAccountIds: [ID.mojo],
  cashAccountIds: [ID.savings],
  grossByPerson: { [ID.ada]: 100_000_00, [ID.ben]: 80_000_00 },
  ownerCostsPerMonthCents: 500_00,
  otherPurchaseCostsCents: 3_000_00,
};

const SCENARIO = {
  name: "$600k with 5% down",
  scheme: "first_home_guarantee",
  priceCents: 600_000_00,
  purchaseDate: "2027-06-30",
  ratePct: 6.5,
  childcarePerMonthCents: 400_00,
  payChanges: { [ID.ada]: 5_000_00 },
  cashOverrideCents: 90_000_00,
};

describe("GET /house before anything is set", () => {
  it("reads as no income, with a warning saying why, and offers every choice", async () => {
    const { status, body } = await send("GET", `/house?on=${ON}`);
    expect(status).toBe(200);
    expect(body.live.variant).toBeNull();
    expect(body.live.incomePerMonthCents).toBe(0);
    expect(body.warnings.map((/** @type {any} */ w) => w.code)).toContain("no_income_variant");
    expect(body.options.variants.map((/** @type {any} */ v) => v.name)).toEqual(["Usual", "Parental leave"]);
    expect(body.options.fixedCategories.map((/** @type {any} */ c) => c.name)).toEqual(["Utilities", "Insurance"]);
    expect(body.options.cashAccounts.map((/** @type {any} */ a) => a.name)).toEqual(["Savings", "Mojo", "Shares"]);
    expect(body.options.people.map((/** @type {any} */ p) => p.name)).toEqual(["Ada", "Ben"]);
    // With nothing stopping, the bills after buying are the allocation's own figure.
    expect(body.live.billsAfterPerMonthCents).toBe(body.live.billsNowPerMonthCents);
    expect(body.scenarios).toEqual([]);
  });
});

describe("PUT /house/settings", () => {
  it("rejects an id that isn't one", async () => {
    const { status } = await send("PUT", "/house/settings", { ...SETTINGS, cashAccountIds: ["savings"] });
    expect(status).toBe(400);
  });

  it("stores the settings whole and reads them back", async () => {
    const { status, body } = await send("PUT", "/house/settings", SETTINGS);
    expect(status).toBe(200);
    expect(body.settings).toEqual(SETTINGS);
    const read = await send("GET", `/house?on=${ON}`);
    expect(read.body.settings).toEqual(SETTINGS);
  });
});

describe("GET /house with settings", () => {
  it("reads income from the chosen variant's own total", async () => {
    const { body } = await send("GET", `/house?on=${ON}`);
    const usual = body.options.variants.find((/** @type {any} */ v) => v.id === ID.usual);
    expect(body.live.variant.id).toBe(ID.usual);
    expect(body.live.incomePerMonthCents).toBe(usual.perMonthCents);
    expect(body.live.incomePerMonthCents).toBeGreaterThan(0);
  });

  it("drops a stopping category's bills from the allocation's own fixed-cost method", async () => {
    const { body } = await send("GET", `/house?on=${ON}`);
    const insurance = body.options.fixedCategories.find((/** @type {any} */ c) => c.id === ID.insurance);
    expect(insurance.stops).toBe(true);
    expect(insurance.perMonthCents).toBeGreaterThan(0);
    // Pooled versus split, the two figures may differ by a rounding cent.
    expect(
      Math.abs(body.live.billsNowPerMonthCents - insurance.perMonthCents - body.live.billsAfterPerMonthCents),
    ).toBeLessThanOrEqual(1);
  });

  it("lists the plan's Save, Invest & Give lines and marks the kept ones", async () => {
    const { body } = await send("GET", `/house?on=${ON}`);
    expect(body.live.plan.id).toBe(ID.plan);
    const lines = body.options.lines.map((/** @type {any} */ l) => [l.label, l.pct, l.kept]);
    expect(lines).toEqual([
      ["Mojo", 10, true],
      ["House deposit", null, false],
    ]);
    const deposit = body.options.lines.find((/** @type {any} */ l) => l.label === "House deposit");
    expect(deposit.perMonthCents).toBe(80_000);
  });

  it("gives each cash account its balance and what today's allocation sends it", async () => {
    const { body } = await send("GET", `/house?on=${ON}`);
    const savings = body.options.cashAccounts.find((/** @type {any} */ a) => a.id === ID.savings);
    expect(savings).toMatchObject({ balanceCents: 1_280_000, asAt: ON, counted: true });
    expect(savings.contributionPerMonthCents).toBe(80_000);
    const shares = body.options.cashAccounts.find((/** @type {any} */ a) => a.id === ID.unrecorded);
    expect(shares).toMatchObject({ balanceCents: 0, asAt: null, counted: false });
  });
});

describe("scenarios", () => {
  /** @type {string} */
  let id;

  it("creates one and returns it in the list", async () => {
    const { status, body } = await send("POST", "/house/scenarios", SCENARIO);
    expect(status).toBe(201);
    id = body.scenario.id;
    expect(body.scenario).toMatchObject({ ...SCENARIO, extraCashCents: 0, lenderLimitCents: null });
    const list = await send("GET", `/house?on=${ON}`);
    expect(list.body.scenarios.map((/** @type {any} */ s) => s.id)).toEqual([id]);
  });

  it("refuses Help to Buy without a lender limit, on create and on a switch", async () => {
    const created = await send("POST", "/house/scenarios", { ...SCENARIO, scheme: "help_to_buy" });
    expect(created.status).toBe(400);
    const switched = await send("PATCH", `/house/scenarios/${id}`, { scheme: "help_to_buy" });
    expect(switched.status).toBe(400);
    const withLimit = await send("PATCH", `/house/scenarios/${id}`, {
      scheme: "help_to_buy",
      lenderLimitCents: 550_000_00,
    });
    expect(withLimit.status).toBe(200);
  });

  it("leaves untouched fields alone on a single-field update", async () => {
    const { status, body } = await send("PATCH", `/house/scenarios/${id}`, { name: "Renamed" });
    expect(status).toBe(200);
    expect(body.scenario).toMatchObject({
      name: "Renamed",
      scheme: "help_to_buy",
      payChanges: SCENARIO.payChanges,
      cashOverrideCents: SCENARIO.cashOverrideCents,
      childcarePerMonthCents: SCENARIO.childcarePerMonthCents,
    });
  });

  it("deletes, and a second delete is a 404", async () => {
    expect((await send("DELETE", `/house/scenarios/${id}`)).status).toBe(200);
    expect((await send("DELETE", `/house/scenarios/${id}`)).status).toBe(404);
    expect((await send("PATCH", `/house/scenarios/${id}`, { name: "Gone" })).status).toBe(404);
  });
});
