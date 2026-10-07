import { bills } from "@budget/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { HOUSEHOLD_IDS, seedHousehold } from "../test/household.js";
import { createBillsRoutes } from "./bills.js";

/** @import { Db } from "@budget/schema" */

// An imported bill's due date is a placeholder (the workbook has none), and
// `due_date_confirmed` is how the app keeps saying so until the operator sets
// the real one. The trap this guards: the Fixed Costs table sends the WHOLE
// row on every save, so "the body mentions anchorDate" would confirm every
// placeholder the moment anything else on the row was edited.

/** @type {Db} */
let db;
/** @type {() => Promise<void>} */
let close;
/** @type {import("hono").Hono} */
let app;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedHousehold(db);
  app = new Hono().route("/bills", createBillsRoutes({ db }));
});

afterAll(async () => {
  await close();
});

// Power, as the importer would have left it: dated to a placeholder.
beforeEach(async () => {
  await db
    .update(bills)
    .set({ anchorDate: "2026-01-15", dueDateConfirmed: false, baseAmountCents: 42_000 })
    .where(eq(bills.id, HOUSEHOLD_IDS.power));
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

/** The whole row, the way the Fixed Costs table sends it. */
function wholeRow(/** @type {Record<string, unknown>} */ overrides) {
  return {
    categoryId: HOUSEHOLD_IDS.utilities,
    name: "Power",
    paidFromAccountId: HOUSEHOLD_IDS.everyday,
    baseAmountCents: 42_000,
    frequency: "quarterly",
    anchorDate: "2026-01-15",
    amountModel: "flat",
    ...overrides,
  };
}

describe("a bill's due date being a placeholder", () => {
  it("is exposed on every bill read", async () => {
    const list = await send("GET", "/bills");
    const power = list.body.bills.find((/** @type {any} */ b) => b.id === HOUSEHOLD_IDS.power);
    expect(power.dueDateConfirmed).toBe(false);
    const water = list.body.bills.find((/** @type {any} */ b) => b.id === HOUSEHOLD_IDS.water);
    expect(water.dueDateConfirmed).toBe(true);

    expect((await send("GET", `/bills/${HOUSEHOLD_IDS.power}`)).body.bill.dueDateConfirmed).toBe(false);
  });

  it("is never the case for a bill entered by hand", async () => {
    const created = await send("POST", "/bills", { ...wholeRow({ name: "Gas" }), dueDateConfirmed: false });
    expect(created.status).toBe(201);
    // `dueDateConfirmed` is not part of the create body at all — a bill typed
    // in by hand was typed in with its real date.
    expect(created.body.bill.dueDateConfirmed).toBe(true);
  });

  it("survives a save that changes something else but sends the same date", async () => {
    const res = await send("PATCH", `/bills/${HOUSEHOLD_IDS.power}`, wholeRow({ baseAmountCents: 45_000 }));
    expect(res.status).toBe(200);
    expect(res.body.bill.baseAmountCents).toBe(45_000);
    expect(res.body.bill.dueDateConfirmed).toBe(false);
  });

  it("ends when the date is changed", async () => {
    const res = await send("PATCH", `/bills/${HOUSEHOLD_IDS.power}`, wholeRow({ anchorDate: "2026-02-03" }));
    expect(res.body.bill.anchorDate).toBe("2026-02-03");
    expect(res.body.bill.dueDateConfirmed).toBe(true);
  });

  it("ends when the operator confirms the placeholder was right after all", async () => {
    const res = await send("PATCH", `/bills/${HOUSEHOLD_IDS.power}`, { dueDateConfirmed: true });
    expect(res.status).toBe(200);
    expect(res.body.bill.anchorDate).toBe("2026-01-15");
    expect(res.body.bill.dueDateConfirmed).toBe(true);
  });

  it("is not reinstated by an explicit false alongside a date someone just typed", async () => {
    const res = await send(
      "PATCH",
      `/bills/${HOUSEHOLD_IDS.power}`,
      wholeRow({ anchorDate: "2026-02-03", dueDateConfirmed: false }),
    );
    expect(res.body.bill.dueDateConfirmed).toBe(true);
  });

  it("is left alone by a single-field patch that does not mention it", async () => {
    // The `.partial()`-keeps-`.default()` trap (zod/bills.js): a defaulted
    // `dueDateConfirmed` in the update schema would confirm on every patch.
    const res = await send("PATCH", `/bills/${HOUSEHOLD_IDS.power}`, { notes: "Meter read quarterly" });
    expect(res.body.bill.dueDateConfirmed).toBe(false);
  });
});
