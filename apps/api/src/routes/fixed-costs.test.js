import { addDaysIso } from "@budget/engine";
import { billStepChanges, bills } from "@budget/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadApp, get } from "../test/app.js";
import { createTestDb } from "../test/db.js";
import { HOUSEHOLD_IDS, ON, seedHousehold } from "../test/household.js";

/** @import { Db } from "@budget/schema" */

// Like the dashboard suite, these check a figure against the endpoint that
// owns it rather than against a hardcoded number: the defects here were two
// screens computing "the bills contribution" two different ways.

const RENT = "10000000-0000-4000-8000-000000000901";
const CAR_LOAN = "10000000-0000-4000-8000-000000000902";
const PERSONAL_LOAN = "10000000-0000-4000-8000-000000000903";

// The allocation's window (lib/allocation.js FIXED_COST_WINDOW_DAYS), stated
// again rather than imported for the reason dashboard.test.js gives.
const FIXED_COST_WINDOW_DAYS = 1461;

/** @param {Db} db */
async function addBills(db) {
  await db.insert(bills).values([
    {
      id: RENT,
      categoryId: HOUSEHOLD_IDS.utilities,
      name: "Rent",
      paidFromAccountId: HOUSEHOLD_IDS.everyday,
      baseAmountCents: 200_000,
      frequency: "monthly",
      anchorDate: "2026-03-20",
      amountModel: "flat",
      sortOrder: 3,
    },
    {
      id: CAR_LOAN,
      categoryId: HOUSEHOLD_IDS.utilities,
      name: "Car loan",
      paidFromAccountId: HOUSEHOLD_IDS.everyday,
      baseAmountCents: 60_000,
      frequency: "monthly",
      anchorDate: "2026-03-25",
      amountModel: "flat",
      sortOrder: 4,
    },
  ]);
  // Paid off eight months in: inside a one-year curve the loan is most of
  // the story, across the allocation's four years it is a sixth of it.
  await db.insert(billStepChanges).values({ billId: CAR_LOAN, effectiveFrom: "2026-11-01", newAmountCents: 0 });
}

describe("/fixed-costs/balance-curve", () => {
  /** @type {Db} */
  let db;
  /** @type {() => Promise<void>} */
  let close;
  /** @type {ReturnType<typeof createReadApp>} */
  let app;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedHousehold(db);
    await addBills(db);
    app = createReadApp(db);
  });

  afterAll(async () => {
    await close();
  });

  it("credits each payday with what the plan actually transfers for bills", async () => {
    const to = addDaysIso(ON, 365);
    const curve = await get(app, `/fixed-costs/balance-curve?from=${ON}&to=${to}`);
    const computed = await get(app, `/allocation/compute?versionId=${HOUSEHOLD_IDS.activeVersion}&on=${ON}`);
    const line = await db.query.allocationLines.findFirst({
      where: (l, { and: andCol, eq: eqCol }) =>
        andCol(eqCol(l.versionId, HOUSEHOLD_IDS.activeVersion), eqCol(l.basis, "from_fixed_costs")),
    });
    const transferred = computed.result.lines.find((/** @type {any} */ r) => r.lineId === line?.id);

    expect(curve.contributionPerPayCents).toBe(transferred.perPayCents);

    // And every payday on the curve is credited exactly that.
    let balance = curve.openingBalanceCents;
    for (const point of curve.points) {
      if (point.event === "payday") expect(point.balanceCents - balance).toBe(transferred.perPayCents);
      balance = point.balanceCents;
    }
  });

  it("no longer averages its own window, which the plan never transfers", async () => {
    // The figure the curve used to credit: this window's own average. With
    // the loan gone after eight months, a one-year window weighs it far more
    // than the four the plan averages over, so the two genuinely differ here
    // — which is what makes the assertion above mean something.
    const to = addDaysIso(ON, 365);
    const curve = await get(app, `/fixed-costs/balance-curve?from=${ON}&to=${to}`);
    const ownWindow = await get(app, `/fixed-costs/summary?from=${ON}&to=${to}`);

    expect(ownWindow.contribution.perPayCents).toBeGreaterThan(curve.contributionPerPayCents);
  });
});

describe("the fixed-cost total, for a fortnightly bill", () => {
  /** @type {() => Promise<void>} */
  let close;
  /** @type {ReturnType<typeof createReadApp>} */
  let app;

  beforeAll(async () => {
    const created = await createTestDb();
    close = created.close;
    await seedHousehold(created.db);
    await created.db.insert(bills).values({
      id: PERSONAL_LOAN,
      categoryId: HOUSEHOLD_IDS.utilities,
      name: "Personal loan",
      paidFromAccountId: HOUSEHOLD_IDS.everyday,
      baseAmountCents: 50_000,
      frequency: "fortnightly",
      anchorDate: "2026-03-04",
      amountModel: "flat",
      sortOrder: 3,
    });
    app = createReadApp(created.db);
  });

  afterAll(async () => {
    await close();
  });

  it("stays put as the date moves, when nothing else has", async () => {
    // Four years from any of these days holds either 104 or 105 of the
    // loan's fortnights. Counted, the fixed total — and the transfer built
    // from it — rose and fell by $10.42 a month with the date alone. The
    // household's other bills land the same number of times in every one of
    // these windows, so any movement here is the loan's.
    /** @type {number[]} */
    const perMonth = [];
    for (let day = 1; day <= 14; day++) {
      const on = `2026-03-${String(day).padStart(2, "0")}`;
      const to = addDaysIso(on, FIXED_COST_WINDOW_DAYS);
      const fixed = await get(app, `/fixed-costs/summary?from=${on}&to=${to}`);
      perMonth.push(fixed.contribution.perMonthCents);
    }

    expect(new Set(perMonth).size).toBe(1);
  });
});
