import { billInstances } from "@budget/schema";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { HOUSEHOLD_IDS, seedHousehold } from "../test/household.js";
import { createBillInstancesRoutes } from "./bill-instances.js";

/** @import { Db } from "@budget/schema" */

// The bill detail sheet lists one bill's orphaned rows — stored entries whose
// date the bill's schedule no longer produces — across all time. It used to
// ask for every active bill's instances over 2000–2100 and filter in the
// browser: tens of thousands of projected rows to keep a handful
// (.claude/plans/perf-inp-plan.md, P2 #6). `billId` + `orphansOnly` let the
// server do that narrowing, and leaving them off must change nothing.

/** @type {Db} */
let db;
/** @type {() => Promise<void>} */
let close;
/** @type {import("hono").Hono} */
let app;

const ALL_TIME = "from=2000-01-01&to=2100-01-01";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedHousehold(db);
  // Power and Water are both quarterly, anchored on the 15th and 20th. A row
  // on the 1st matches neither schedule, so each of these is an orphan.
  await db.insert(billInstances).values([
    { billId: HOUSEHOLD_IDS.power, dueDate: "2026-03-01", actualCents: 39_000 },
    { billId: HOUSEHOLD_IDS.water, dueDate: "2026-03-01", actualCents: 17_500 },
  ]);
  app = new Hono().route("/bill-instances", createBillInstancesRoutes({ db }));
});

afterAll(async () => {
  await close();
});

/** @param {string} query */
async function list(query) {
  const res = await app.request(`/bill-instances?${query}`);
  /** @type {any} */
  const body = await res.json();
  return { status: res.status, instances: /** @type {any[]} */ (body.instances) };
}

describe("GET /bill-instances", () => {
  it("returns one bill's orphans and nothing else when asked to", async () => {
    const { status, instances } = await list(`${ALL_TIME}&billId=${HOUSEHOLD_IDS.power}&orphansOnly=true`);

    expect(status).toBe(200);
    expect(instances).toEqual([
      expect.objectContaining({ billId: HOUSEHOLD_IDS.power, dueDate: "2026-03-01", actualCents: 39_000, isOrphan: true }),
    ]);
  });

  it("narrows to one bill while still projecting its schedule", async () => {
    const { instances } = await list(`from=2026-01-01&to=2026-12-31&billId=${HOUSEHOLD_IDS.power}`);

    expect(new Set(instances.map((i) => i.billId))).toEqual(new Set([HOUSEHOLD_IDS.power]));
    expect(instances.filter((i) => !i.isOrphan).map((i) => i.dueDate)).toEqual([
      "2026-01-15",
      "2026-04-15",
      "2026-07-15",
      "2026-10-15",
    ]);
    expect(instances.filter((i) => i.isOrphan)).toHaveLength(1);
  });

  it("still lists every active bill, projected and orphaned, with no filters", async () => {
    const { instances } = await list("from=2026-01-01&to=2026-12-31");

    const billIds = new Set(instances.map((i) => i.billId));
    expect(billIds.has(HOUSEHOLD_IDS.power)).toBe(true);
    expect(billIds.has(HOUSEHOLD_IDS.water)).toBe(true);
    expect(instances.filter((i) => i.isOrphan)).toHaveLength(2);
    expect(instances.some((i) => !i.isOrphan)).toBe(true);
  });

  it("refuses a bill id that isn't a uuid", async () => {
    const { status } = await list(`${ALL_TIME}&billId=power`);
    expect(status).toBe(400);
  });
});
