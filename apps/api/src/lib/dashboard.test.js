import { addDaysIso } from "@budget/engine";
import { allocationPlans, allocationVersions, balanceSnapshots, variantSchedule } from "@budget/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadApp, get } from "../test/app.js";
import { createTestDb } from "../test/db.js";
import { HOUSEHOLD_IDS, ON, seedHousehold, seedSettings } from "../test/household.js";
import { summarizeVariableCosts } from "./variable-costs.js";

/** @import { Db } from "@budget/schema" */

// `/dashboard` is the one endpoint that reports figures it does not own. Its
// whole contract is that it sums, filters and picks, and does no financial
// arithmetic of its own (phases/10-dashboard.md "Data") — so the test for it
// is not "is 30775 the right number", it is "does it still say what the
// screen that owns 30775 says". A hardcoded expectation would pass happily
// while the two drifted apart, which is the exact failure todo.md
// `[P10-11]` describes.
//
// The window here is `loadAllocationContext`'s own FIXED_COST_WINDOW_DAYS.
// It is not exported, and it should not be: the point of asking
// /fixed-costs for the same window is that the dashboard has to agree with
// that screen over the window it actually uses, so this is a second,
// independent statement of the number rather than a shared constant that
// could be wrong in both places at once.
const FIXED_COST_WINDOW_DAYS = 1461;
const NET_WORTH_DAYS = 365;

describe("loadDashboard, against the endpoints that own each figure", () => {
  /** @type {Db} */
  let db;
  /** @type {() => Promise<void>} */
  let close;
  /** @type {ReturnType<typeof createReadApp>} */
  let app;
  /** @type {any} */
  let dashboard;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedHousehold(db);
    app = createReadApp(db);
    dashboard = await get(app, `/dashboard?on=${ON}`);
  });

  afterAll(async () => {
    await close();
  });

  it("reports the income /income resolves for the same date", async () => {
    const income = await get(app, `/income/resolve?on=${ON}`);

    expect(dashboard.variant.id).toBe(income.variantId);
    expect(dashboard.variant.name).toBe(income.variant.name);
    expect(dashboard.variant.totalPerPayCents).toBe(income.variant.totals.totalCents.perPay);
    expect(dashboard.variant.totalPerMonthCents).toBe(income.variant.totals.totalCents.perMonth);
    expect(dashboard.variant.diagnostics).toEqual(income.diagnostics);
  });

  it("reports the bills contribution /costs/fixed computes over the same window", async () => {
    const to = addDaysIso(ON, FIXED_COST_WINDOW_DAYS);
    const fixed = await get(app, `/fixed-costs/summary?from=${ON}&to=${to}`);

    expect(dashboard.bills.contributionPerMonthCents).toBe(fixed.contribution.perMonthCents);
    expect(dashboard.bills.contributionPerPayCents).toBe(fixed.contribution.perPayCents);
    expect(dashboard.bills.billCount).toBe(fixed.billCount);
    // An escalating bill's four-year average is not its face value, so a
    // dashboard that had quietly gone back to `baseAmountCents` would still
    // be in the right order of magnitude and would pass a looser assertion.
    expect(dashboard.bills.contributionPerMonthCents).not.toBe(30_000);
  });

  // The dashboard shows the bills contribution twice: once as a standing
  // transfer (the plan's figure) and once in the Upcoming card's footer
  // (/costs/fixed's figure). todo.md `[P10-12]` is that those two were both
  // per-pay and disagreed. They disagree because the plan converts monthly to
  // per-pay with nominal cadence arithmetic (x 12/26) while /costs/fixed
  // divides the window total by the paydays actually in the window, and 1461
  // days holds 105 real paydays against 104.35 nominal fortnights.
  //
  // The footer states a monthly figure now, and these two assertions are the
  // whole reason that is safe: monthly, the two agree to the cent, and per
  // pay they do not. If a later change makes the per-pay figures equal, the
  // second assertion fails and the footer can go back to being per pay.
  it("agrees with the plan on the bills contribution per month, and not per pay", async () => {
    const line = await db.query.allocationLines.findFirst({
      where: (l, { and: andCol, eq: eqCol }) =>
        andCol(eqCol(l.versionId, HOUSEHOLD_IDS.activeVersion), eqCol(l.basis, "from_fixed_costs")),
    });
    const resolved = dashboard.allocation.resolvedLines.find(
      (/** @type {any} */ r) => r.lineId === line?.id,
    );

    expect(resolved.perMonthCents).toBe(dashboard.bills.contributionPerMonthCents);
    expect(resolved.perPayCents).not.toBe(dashboard.bills.contributionPerPayCents);
  });

  it("reports the transfers, stages and resolved lines /allocation computes", async () => {
    const versionId = dashboard.allocation.versionId;
    const computed = await get(app, `/allocation/compute?versionId=${versionId}&on=${ON}`);

    expect(dashboard.allocation.grossPerMonthCents).toBe(computed.inputs.grossPerMonthCents);
    expect(dashboard.allocation.transfers).toEqual(computed.result.transfers);
    expect(dashboard.allocation.stages).toEqual(computed.result.stages);
    expect(dashboard.allocation.resolvedLines).toEqual(computed.result.lines);
    expect(dashboard.allocation.unallocatedPerMonthCents).toBe(computed.result.unallocatedPerMonthCents);
    expect(dashboard.allocation.goodLifeFidelityCents).toBe(computed.result.goodLifeFidelityCents);
  });

  it("reports the goals and the cover projection /goals computes", async () => {
    const goals = await get(app, `/goals?on=${ON}`);
    const active = goals.goals.filter((/** @type {any} */ g) => g.goal.status === "active");

    expect(dashboard.goals.map((/** @type {any} */ g) => g.id)).toEqual(
      active.map((/** @type {any} */ g) => g.goal.id),
    );
    for (const [i, g] of active.entries()) {
      expect(dashboard.goals[i].progressPct).toBe(g.progressPct);
      expect(dashboard.goals[i].etaDate).toBe(g.eta.date);
      expect(dashboard.goals[i].currentBalanceCents).toBe(g.currentBalanceCents);
      expect(dashboard.goals[i].targetCents).toBe(g.targetCents);
    }

    const cover = active.find((/** @type {any} */ g) => g.goal.targetMode === "months_of_expenses");
    expect(dashboard.mojo.goalId).toBe(cover.goal.id);
    expect(dashboard.mojo.monthsCovered).toBe(cover.monthsCovered);
    expect(dashboard.mojo.balanceCents).toBe(cover.currentBalanceCents);
    // The burn the card divides by is the household summary's, not a second
    // essentials total assembled here.
    expect(dashboard.mojo.burnPerMonthCents).toBe(goals.summary.monthlyEssentialBurnCents);
  });

  it("reports the net worth /net-worth computes over its own twelve months", async () => {
    const from = addDaysIso(ON, -NET_WORTH_DAYS);
    const netWorth = await get(app, `/net-worth?from=${from}&to=${ON}`);

    const known = netWorth.totalPoints.filter(
      (/** @type {any} */ p) => p.date >= netWorth.knownFrom,
    );
    expect(dashboard.netWorth.series).toEqual(known);
    expect(dashboard.netWorth.totalCents).toBe(known[known.length - 1].totalCents);
    // The mortgage is external and carries a large negative balance. If it
    // ever reached net worth the total would go deeply negative, so this
    // asserts the exclusion by consequence rather than by counting rows.
    expect(dashboard.netWorth.totalCents).toBeGreaterThan(0);
  });

  it("reports the variable rollup phase 07's own summary produces", async () => {
    // /variable-costs/summary takes no `on` — it answers for today — so the
    // shared surface between the two screens is the function beneath it.
    const summary = await summarizeVariableCosts(db, ON);

    expect(dashboard.variable.essentialPerMonthCents).toBe(summary.essentialPerMonthCents);
    expect(dashboard.variable.nonEssentialPerMonthCents).toBe(summary.nonEssentialPerMonthCents);

    const withHistory = summary.byCategory.filter(
      (/** @type {any} */ c) => c.trailingAveragePerMonthCents !== null,
    );
    expect(dashboard.variable.categoriesWithHistory).toBe(withHistory.length);
    expect(dashboard.variable.trailingAveragePerMonthCents).toBe(
      withHistory.reduce((/** @type {number} */ sum, /** @type {any} */ c) => sum + c.trailingAveragePerMonthCents, 0),
    );
    // Positive means overspending against budget. A category with no history
    // must take part in NEITHER side of the variance — averaging it in as a
    // zero would read as a saving that is not there.
    expect(dashboard.variable.varianceCents).toBe(
      dashboard.variable.trailingAveragePerMonthCents -
        withHistory.reduce((/** @type {number} */ sum, /** @type {any} */ c) => sum + c.budgetPerMonthCents, 0),
    );
    expect(withHistory.length).toBeLessThan(summary.byCategory.length);
  });

  it("groups the hero into the three sections without recomputing any of them", () => {
    const { breakdown, stages, grossPerMonthCents, unallocatedPerMonthCents } = dashboard.allocation;

    expect(breakdown.map((/** @type {any} */ b) => b.key)).toEqual(["needs", "saving", "leftover"]);
    for (const [i, tile] of breakdown.entries()) {
      expect(tile.perMonthCents).toBe(stages[i].subtotalPerMonthCents);
      expect(tile.perPayCents).toBe(stages[i].subtotalPerPayCents);
      expect(tile.pctOfGross).toBe(stages[i].actualPct);
      expect(tile.goalPct).toBe(stages[i].goalPct);
      expect(tile.fidelity).toBe(stages[i].fidelity);
    }

    // One tile per section covers every line exactly once, so the tiles plus
    // whatever is unallocated are the whole of gross. This is the invariant
    // the per-line `category` grouping could not hold.
    const tiled = breakdown.reduce((/** @type {number} */ sum, /** @type {any} */ b) => sum + b.perMonthCents, 0);
    expect(tiled + unallocatedPerMonthCents).toBe(grossPerMonthCents);
    expect(breakdown.reduce((/** @type {number} */ sum, /** @type {any} */ b) => sum + b.lineCount, 0)).toBe(
      dashboard.allocation.lines.length,
    );
  });

  it("counts unrecorded balances against held accounts only", () => {
    // Five accounts, of which one is external (excluded from net worth
    // entirely) and one has no snapshot. Counting the external one would put
    // a warning on screen that no balance entry could ever clear.
    expect(dashboard.accounts).toHaveLength(5);
    expect(dashboard.netWorth.accountsWithoutBalance).toBe(1);
    expect(dashboard.warnings.map((/** @type {any} */ w) => w.code)).toContain("no_balance_recorded");
  });

  it("gives every warning a link to where it is fixed", () => {
    for (const warning of dashboard.warnings) {
      expect(warning.href, `${warning.code} has no href`).toMatch(/^\//);
    }
  });
});

describe("loadDashboard, on a database with nothing in it", () => {
  /** @type {any} */
  let dashboard;
  /** @type {() => Promise<void>} */
  let close;

  beforeAll(async () => {
    const created = await createTestDb();
    close = created.close;
    await seedSettings(created.db);
    dashboard = await get(createReadApp(created.db), `/dashboard?on=${ON}`);
  });

  afterAll(async () => {
    await close();
  });

  it("answers at all, rather than dividing by an income nobody has entered", () => {
    expect(dashboard.on).toBe(ON);
    expect(dashboard.cycle).toBeNull();
    expect(dashboard.variant.id).toBeNull();
    expect(dashboard.allocation).toBeNull();
    expect(dashboard.mojo).toBeNull();
    expect(dashboard.goals).toEqual([]);
    expect(dashboard.accounts).toEqual([]);
  });

  it("reports an unknown net worth as unknown, not as zero over a year", () => {
    // A flat zero line for twelve months reads as "we have nothing" rather
    // than "we have never said" (phases/10-dashboard.md).
    expect(dashboard.netWorth.series).toEqual([]);
    expect(dashboard.netWorth.stalestAsAt).toBeNull();
    expect(dashboard.netWorth.staleDays).toBeNull();
    expect(dashboard.netWorth.accountsWithoutBalance).toBe(0);
  });

  it("says where to start", () => {
    expect(dashboard.setup).toEqual({
      people: false,
      paySchedule: false,
      accounts: false,
      bills: false,
      allocation: false,
      complete: false,
    });
  });

  it("raises each missing prerequisite once", () => {
    const codes = dashboard.warnings.map((/** @type {any} */ w) => w.code);
    expect(codes).toContain("variant_gap");
    expect(codes).toContain("no_primary_pay_schedule");
    expect(codes).toContain("no_income_landing_account");
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("loadDashboard, when the data itself is the problem", () => {
  /**
   * A fresh household per case: these tests break the fixture on purpose, and
   * a shared one would leak the breakage into whichever test ran next.
   *
   * @param {(db: Db) => Promise<void>} damage
   */
  async function dashboardAfter(damage) {
    const { db, close } = await createTestDb();
    await seedHousehold(db);
    await damage(db);
    const payload = await get(createReadApp(db), `/dashboard?on=${ON}`);
    await close();
    return payload;
  }

  /** @param {Db} db */
  async function overlapTheSchedule(db) {
    await db.insert(variantSchedule).values({
      variantId: HOUSEHOLD_IDS.leave,
      startsOn: "2026-03-01",
      endsOn: "2026-04-01",
    });
  }

  it("reports no income when two variants both cover the date", async () => {
    const dashboard = await dashboardAfter(overlapTheSchedule);

    expect(dashboard.variant.id).toBeNull();
    expect(dashboard.variant.totalPerPayCents).toBeNull();
    expect(dashboard.warnings.map((/** @type {any} */ w) => w.code)).toContain("variant_overlap");
    // The plan still exists, so the setup checklist must not send the
    // operator off to build a second one — the warning is what is actionable.
    expect(dashboard.setup.allocation).toBe(true);
    // And with exactly one active plan there is still no ambiguity about
    // WHICH plan applies, so the transfers stay on screen. The overlap makes
    // the income unresolvable, not the plan.
    expect(dashboard.allocation).not.toBeNull();
  });

  it("shows no transfers when the overlap makes it ambiguous which plan applies", async () => {
    const dashboard = await dashboardAfter(async (db) => {
      await overlapTheSchedule(db);
      const plan = { id: HOUSEHOLD_IDS.leavePlan, name: "Leave plan", incomeVariantId: HOUSEHOLD_IDS.leave };
      await db.insert(allocationPlans).values(plan);
      await db.insert(allocationVersions).values({
        planId: plan.id,
        version: 1,
        status: "active",
        activatedAt: new Date("2026-01-02T00:00:00Z"),
      });
    });

    // Two active plans and nothing to say which is running: zero, and a
    // warning, rather than a guess typed into a bank.
    expect(dashboard.allocation).toBeNull();
    const warning = dashboard.warnings.find(
      (/** @type {any} */ w) => w.code === "ambiguous_active_allocation",
    );
    expect(warning.message).toContain("2 allocation plans are active");
    expect(warning.href).toBe("/allocation");
  });

  it("says how old the oldest balance is when it is old enough to matter", async () => {
    const dashboard = await dashboardAfter(async (db) => {
      await db.delete(balanceSnapshots);
      await db.insert(balanceSnapshots).values([
        { accountId: HOUSEHOLD_IDS.everyday, asAt: "2025-12-01", amountCents: 400_000 },
        { accountId: HOUSEHOLD_IDS.savings, asAt: "2026-03-01", amountCents: 1_200_000 },
        { accountId: HOUSEHOLD_IDS.mojo, asAt: "2026-03-01", amountCents: 900_000 },
        { accountId: HOUSEHOLD_IDS.unrecorded, asAt: "2026-03-01", amountCents: 0 },
      ]);
    });

    expect(dashboard.netWorth.stalestAsAt).toBe("2025-12-01");
    expect(dashboard.netWorth.staleDays).toBe(102);
    const stale = dashboard.warnings.find((/** @type {any} */ w) => w.code === "stale_balance");
    expect(stale.message).toContain("102 days old");
    expect(stale.href).toBe("/accounts");
  });

  it("says the transfers on screen are not the draft the operator is editing", async () => {
    const dashboard = await dashboardAfter(async (db) => {
      await db.insert(allocationVersions).values({
        planId: HOUSEHOLD_IDS.plan,
        version: 2,
        status: "draft",
        basedOnVersionId: HOUSEHOLD_IDS.activeVersion,
      });
    });

    expect(dashboard.allocation.hasDraft).toBe(true);
    expect(dashboard.allocation.versionId).toBe(HOUSEHOLD_IDS.activeVersion);
    const warning = dashboard.warnings.find((/** @type {any} */ w) => w.code === "unapplied_draft");
    expect(warning.message).toContain("Usual plan");
    expect(warning.href).toBe("/allocation");
  });

  it("says so when a plan does not spend everything it is given", async () => {
    const dashboard = await dashboardAfter(async (db) => {
      // Removing the sweep leaves the remainder sitting in the income
      // account with nothing claiming it.
      await db.delete(allocationVersions).where(eq(allocationVersions.id, HOUSEHOLD_IDS.activeVersion));
      await db.insert(allocationVersions).values({
        id: HOUSEHOLD_IDS.activeVersion,
        planId: HOUSEHOLD_IDS.plan,
        version: 2,
        status: "active",
        activatedAt: new Date("2026-01-02T00:00:00Z"),
      });
    });

    expect(dashboard.allocation.unallocatedPerMonthCents).toBe(dashboard.allocation.grossPerMonthCents);
    const warning = dashboard.warnings.find((/** @type {any} */ w) => w.code === "unallocated");
    expect(warning.message).toContain("not allocated");
  });
});
