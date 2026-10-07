import { accounts, bills, variableActuals, variableBudgets } from "@budget/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadApp, get } from "../test/app.js";
import { createTestDb } from "../test/db.js";
import { HOUSEHOLD_IDS, ON, seedHousehold } from "../test/household.js";

/** @import { Db } from "@budget/schema" */

/**
 * A fresh household per describe, damaged in one way: these break the
 * fixture on purpose, and a shared one would leak the breakage.
 *
 * @param {(db: Db) => Promise<void>} damage
 */
async function householdAfter(damage) {
  const { db, close } = await createTestDb();
  await seedHousehold(db);
  await damage(db);
  return { app: createReadApp(db), close };
}

describe("/net-worth, after an account is archived", () => {
  /** @type {ReturnType<typeof createReadApp>} */
  let app;
  /** @type {() => Promise<void>} */
  let close;

  // Local noon, so the calendar date it falls on is 1 March in any timezone
  // the suite runs under.
  const ARCHIVED_ON = "2026-03-01";

  beforeAll(async () => {
    ({ app, close } = await householdAfter(async (db) => {
      await db
        .update(accounts)
        .set({ archivedAt: new Date(2026, 2, 1, 12, 0) })
        .where(eq(accounts.id, HOUSEHOLD_IDS.savings));
    }));
  });

  afterAll(async () => {
    await close();
  });

  it("keeps its balances in every total dated before it was archived", async () => {
    const netWorth = await get(app, `/net-worth?from=2026-01-01&to=${ON}`);
    /** @param {string} date */
    const totalOn = (date) => netWorth.totalPoints.find((/** @type {any} */ p) => p.date === date).totalCents;

    // 2026-02-13 is a snapshot date, so it is always sampled. Everyday $4,100
    // + Mojo $9,000 + Savings $12,000 — before this fix Savings was missing
    // from it, and from every other date in the history.
    expect(totalOn("2026-02-13")).toBe(410_000 + 900_000 + 1_200_000);
    // From the day it was archived it counts for nothing, even though a
    // balance was recorded against it on ON itself.
    expect(totalOn(ON)).toBe(455_000 + 950_000);

    const savings = netWorth.accounts.find((/** @type {any} */ a) => a.id === HOUSEHOLD_IDS.savings);
    expect(savings.archivedOn).toBe(ARCHIVED_ON);
    // A closed account's last balance must not make today's figure read as
    // stale, so its `asAt` goes with it.
    expect(savings.points.at(-1)).toEqual({ date: ON, balanceCents: 0, asAt: null });
  });

  it("leaves out an account archived before the window opens", async () => {
    const netWorth = await get(app, `/net-worth?from=${ARCHIVED_ON}&to=${ON}`);
    expect(netWorth.accounts.map((/** @type {any} */ a) => a.id)).not.toContain(HOUSEHOLD_IDS.savings);
  });
});

describe("a months-of-expenses goal before any costs are recorded", () => {
  /** @type {ReturnType<typeof createReadApp>} */
  let app;
  /** @type {() => Promise<void>} */
  let close;

  beforeAll(async () => {
    ({ app, close } = await householdAfter(async (db) => {
      // No bills and no essential budget: the burn the target multiplies is
      // zero, which is every household's state on its first day.
      await db.delete(bills);
      await db.delete(variableActuals);
      await db.delete(variableBudgets);
    }));
  });

  afterAll(async () => {
    await close();
  });

  it("reports the target as not computable, not as reached", async () => {
    const goals = await get(app, `/goals?on=${ON}`);
    const cover = goals.goals.find((/** @type {any} */ g) => g.goal.id === HOUSEHOLD_IDS.mojoGoal);

    expect(goals.summary.monthlyEssentialBurnCents).toBe(0);
    // Six months of nothing was a $0 target, and the $9,500 balance "reached"
    // it on a household that had not entered a single cost. The 0 is still
    // sent, as a placeholder the flag beside it disowns.
    expect(cover.targetComputable).toBe(false);
    expect(cover.targetCents).toBe(0);
    expect(cover.reached).toBe(false);
    expect(cover.progressPct).toBe(0);
    expect(cover.eta).toEqual({ date: null, aheadBehindDays: null });
    expect(cover.beyondHorizon).toBe(false);
    expect(cover.required).toBeNull();
    expect(cover.monthsCovered).toBeNull();
    expect(cover.thresholds).toBeNull();

    // An amount goal does not depend on costs and is untouched.
    const deposit = goals.goals.find((/** @type {any} */ g) => g.goal.id === HOUSEHOLD_IDS.holidayGoal);
    expect(deposit.targetComputable).toBe(true);
    expect(deposit.targetCents).toBe(4_000_000);
  });

  it("answers GET /goals/:id and /dashboard the same way, without falling over", async () => {
    const detail = await get(app, `/goals/${HOUSEHOLD_IDS.mojoGoal}?on=${ON}`);
    expect(detail.targetComputable).toBe(false);
    expect(detail.reached).toBe(false);

    const dashboard = await get(app, `/dashboard?on=${ON}`);
    const cover = dashboard.goals.find((/** @type {any} */ g) => g.id === HOUSEHOLD_IDS.mojoGoal);
    expect(cover).toMatchObject({ targetComputable: false, reached: false });
    expect(dashboard.mojo).toMatchObject({
      goalId: HOUSEHOLD_IDS.mojoGoal,
      targetComputable: false,
      monthsCovered: null,
      nextThresholdMonths: null,
    });
  });
});
