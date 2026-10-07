import { bills, paySchedules } from "@budget/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { HOUSEHOLD_IDS as ID, ON, seedHousehold } from "../test/household.js";
import { createAllocationPlansRoutes } from "./allocation-plans.js";
import { createAllocationVersionsRoutes } from "./allocation-versions.js";
import { createAllocationRoutes } from "./allocation.js";
import { createDashboardRoutes } from "./dashboard.js";

/** @import { Db } from "@budget/schema" */

// A version stores rules (basis + value), so every figure it resolves to moves
// when a bill does — and the bank does not. These tests follow one household
// through the whole story: a version applied before amounts were recorded,
// an apply that records them, a bill that moves underneath them, the
// unchanged draft that names the standing orders to edit, and the re-apply
// that records the new amounts. The steps share one database and run in
// order; each `it` is the next thing the operator does.

/** @type {Db} */
let db;
/** @type {() => Promise<void>} */
let close;
/** @type {import("hono").Hono} */
let app;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedHousehold(db);
  app = new Hono()
    .route("/allocation-plans", createAllocationPlansRoutes({ db }))
    .route("/allocation-versions", createAllocationVersionsRoutes({ db }))
    .route("/allocation", createAllocationRoutes({ db }))
    .route("/dashboard", createDashboardRoutes({ db }));
});

afterAll(async () => {
  await close();
});

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [json]
 * @returns {Promise<any>}
 */
async function send(method, path, json) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const dashboard = () => send("GET", `/dashboard?on=${ON}`);
const preview = () => send("GET", `/allocation/preview?planId=${ID.plan}&on=${ON}`);

/**
 * @param {any} payload
 * @param {string} accountId
 */
const transferTo = (payload, accountId) =>
  payload.transfers.find((/** @type {any} */ t) => t.accountId === accountId);

/** @param {any} dash @param {string} code */
const warning = (dash, code) => dash.warnings.find((/** @type {any} */ w) => w.code === code) ?? null;

// The fixture's plan, except the leftover sweeps into Shares rather than the
// income-landing account — so a bill that moves shows up in a real standing
// order, not only in money that stays where it landed.
const LINES = [
  { stage: 1, label: "Bills", basis: "from_fixed_costs", value: null, accountId: ID.everyday, sortOrder: 0 },
  { stage: 1, label: "Essentials", basis: "from_variable_essentials", value: null, accountId: ID.everyday, sortOrder: 1 },
  { stage: 2, label: "Mojo", basis: "pct_of_gross", value: 10, accountId: ID.mojo, sortOrder: 2 },
  { stage: 2, label: "House deposit", basis: "fixed_amount", value: 80_000, accountId: ID.savings, sortOrder: 3 },
  { stage: 3, label: "Investing", basis: "sweep", value: 1, accountId: ID.unrecorded, sortOrder: 4 },
];

describe("standing-transfer amounts recorded at apply", () => {
  /** @type {any} */
  let firstApply;
  /** @type {number} */
  let sharesAtApply;

  it("reads a version applied before amounts were recorded as not recorded, with no drift", async () => {
    const dash = await dashboard();
    expect(dash.allocation.applied.status).toBe("not_recorded");
    expect(dash.allocation.transfers.every((/** @type {any} */ t) => t.driftPerPayCents === null)).toBe(true);
    expect(warning(dash, "transfers_drifted")).toBeNull();

    // And /allocation's "Current" says it is a recomputation, not a record.
    const view = await preview();
    expect(view.current.source).toBe("recomputed");
    expect(view.current.reason).toBe("not_recorded");
    expect(view.current.applied).toBeNull();
  });

  it("records each destination's per-pay amount when a draft is applied", async () => {
    const { draft } = await send("POST", `/allocation-plans/${ID.plan}/draft`);
    await send("PUT", `/allocation-versions/${draft.id}/lines`, { lines: LINES });
    firstApply = (await send("POST", `/allocation-plans/${ID.plan}/draft/apply`, { on: ON })).version;

    const applied = firstApply.applied;
    expect(applied).not.toBeNull();
    expect(applied.payCadence).toBe("fortnightly");
    expect(applied.computedOn).toBe(ON);

    // Exactly what /allocation computes for the same version and date — the
    // record is the preview the operator just read, not a second calculation.
    const computed = await send("GET", `/allocation/compute?versionId=${firstApply.id}&on=${ON}`);
    expect(applied.transfers.map((/** @type {any} */ t) => [t.accountId, t.perPayCents, t.perMonthCents, t.isNoOp])).toEqual(
      computed.result.transfers.map((/** @type {any} */ t) => [t.accountId, t.perPayCents, t.perMonthCents, t.isNoOp]),
    );
    // Names are copied in, so a later rename can't rewrite the record.
    expect(transferTo(applied, ID.unrecorded).accountName).toBe("Shares");
    sharesAtApply = transferTo(applied, ID.unrecorded).perPayCents;

    const dash = await dashboard();
    expect(dash.allocation.applied.status).toBe("recorded");
    for (const transfer of dash.allocation.transfers) {
      expect(transfer.appliedPerPayCents).toBe(transfer.perPayCents);
      expect(transfer.driftPerPayCents).toBe(0);
    }
    expect(warning(dash, "transfers_drifted")).toBeNull();
  });

  it("shows drift, and names the standing orders, once a bill moves underneath them", async () => {
    // Power doubles. More goes to bills, so less is left for the sweep.
    await db.update(bills).set({ baseAmountCents: 84_000 }).where(eq(bills.id, ID.power));

    const dash = await dashboard();
    const shares = transferTo(dash.allocation, ID.unrecorded);
    expect(shares.appliedPerPayCents).toBe(sharesAtApply);
    expect(shares.perPayCents).toBeLessThan(sharesAtApply);
    expect(shares.driftPerPayCents).toBe(shares.perPayCents - sharesAtApply);

    const drifted = warning(dash, "transfers_drifted");
    expect(drifted).not.toBeNull();
    expect(drifted.href).toBe("/allocation");
    const appliedOn = new Intl.DateTimeFormat("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${firstApply.applied.appliedOn}T00:00:00Z`));
    const signed = new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      signDisplay: "exceptZero",
    }).format(shares.driftPerPayCents / 100);
    expect(drifted.message).toContain(`Usual plan plan (v${firstApply.version}) was applied on ${appliedOn}`);
    expect(drifted.message).toContain(`Shares ${signed}`);
    // The income-landing account moved too, but nothing at the bank sends
    // money there — it is where the money already is.
    expect(drifted.message).not.toContain("Everyday");

    // /allocation's Current column is what the bank holds, not today's figure.
    const view = await preview();
    expect(view.current.source).toBe("applied");
    expect(transferTo(view.current, ID.unrecorded).perPayCents).toBe(sharesAtApply);
    expect(transferTo(view.active.result, ID.unrecorded).perPayCents).toBe(shares.perPayCents);
    const ownDrift = view.current.drift.find((/** @type {any} */ d) => d.accountId === ID.unrecorded);
    expect(ownDrift.deltaPerPayCents).toBe(shares.driftPerPayCents);
  });

  it("diffs an unchanged draft against what was applied, so it lists exactly the orders to edit", async () => {
    await send("POST", `/allocation-plans/${ID.plan}/draft`);
    const view = await preview();

    // Recomputed against recomputed, this diff would be all zeroes — "no
    // changes" while the bank orders are stale.
    const shares = view.diff.find((/** @type {any} */ d) => d.accountId === ID.unrecorded);
    expect(shares.fromPerPayCents).toBe(sharesAtApply);
    expect(shares.deltaPerPayCents).toBeLessThan(0);
    const unchanged = view.diff.find((/** @type {any} */ d) => d.accountId === ID.savings);
    expect(unchanged.deltaPerPayCents).toBe(0);
  });

  it("clears the drift when that unchanged draft is applied, recording the new amounts", async () => {
    const reapplied = (await send("POST", `/allocation-plans/${ID.plan}/draft/apply`, { on: ON })).version;
    expect(reapplied.version).toBe(firstApply.version + 1);
    expect(transferTo(reapplied.applied, ID.unrecorded).perPayCents).toBeLessThan(sharesAtApply);

    const dash = await dashboard();
    expect(dash.allocation.transfers.every((/** @type {any} */ t) => t.driftPerPayCents === 0)).toBe(true);
    expect(warning(dash, "transfers_drifted")).toBeNull();

    // The superseded version keeps the amounts it was applied with.
    const { versions } = await send("GET", `/allocation-plans/${ID.plan}/versions`);
    const archived = versions.find((/** @type {any} */ v) => v.id === firstApply.id);
    expect(archived.status).toBe("archived");
    expect(transferTo(archived.applied, ID.unrecorded).perPayCents).toBe(sharesAtApply);
  });

  it("refuses to compare across a change of pay cadence, and asks for a re-apply instead", async () => {
    await db.update(paySchedules).set({ cadence: "monthly" }).where(eq(paySchedules.id, ID.paySchedule));

    const dash = await dashboard();
    expect(dash.allocation.applied.status).toBe("cadence_changed");
    expect(dash.allocation.transfers.every((/** @type {any} */ t) => t.appliedPerPayCents === null)).toBe(true);
    expect(warning(dash, "transfers_drifted")).toBeNull();
    const changed = warning(dash, "applied_cadence_changed");
    expect(changed.message).toContain("fortnightly");
    expect(changed.message).toContain("now monthly");
    expect(changed.href).toBe("/allocation");

    const view = await preview();
    expect(view.current.source).toBe("recomputed");
    expect(view.current.reason).toBe("cadence_changed");
  });
});
