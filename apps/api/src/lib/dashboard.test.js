import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addDaysIso } from "@budget/engine";
import {
  accounts,
  allocationLines,
  allocationPlans,
  allocationVersions,
  balanceSnapshots,
  bills,
  invites,
  settings,
  users,
  variantSchedule,
} from "@budget/schema";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDashboardRoutes } from "../routes/dashboard.js";
import { createReadApp, get } from "../test/app.js";
import { BACKUP_STATUS_KEY, createBackup } from "./backup.js";
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
    // Each transfer is the engine's own, plus what was recorded at apply.
    // The fixture's active version predates recorded amounts, so it reads as
    // "not recorded" — no applied figure and no drift, never a recomputation
    // passed off as one.
    expect(
      dashboard.allocation.transfers.map(
        (/** @type {any} */ { appliedPerPayCents, driftPerPayCents, ...transfer }) => transfer,
      ),
    ).toEqual(computed.result.transfers);
    for (const transfer of dashboard.allocation.transfers) {
      expect(transfer.appliedPerPayCents).toBeNull();
      expect(transfer.driftPerPayCents).toBeNull();
    }
    expect(dashboard.allocation.applied.status).toBe("not_recorded");
    expect(dashboard.allocation.stages).toEqual(computed.result.stages);
    expect(dashboard.allocation.resolvedLines).toEqual(computed.result.lines);
    expect(dashboard.allocation.unallocatedPerMonthCents).toBe(computed.result.unallocatedPerMonthCents);
    expect(dashboard.allocation.goodLifeFidelityCents).toBe(computed.result.goodLifeFidelityCents);
    // The pool is the target less that shortfall, and is what the Leftover
    // column says is left for non-essentials.
    expect(dashboard.allocation.nonEssentialPoolPerMonthCents).toBe(
      dashboard.variable.nonEssentialPerMonthCents - computed.result.goodLifeFidelityCents,
    );
    expect(dashboard.allocation.overAllocation).toEqual(computed.result.overAllocation);
    expect(dashboard.allocation.overAllocation).toBeNull();
  });

  it("reports the goals /goals computes", async () => {
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

    // The emergency-fund card is gone, and its payload with it: the goal is the
    // first row of the goals list.
    expect(dashboard).not.toHaveProperty("mojo");
  });

  it("says whose bill each upcoming one is, and nothing for a shared one", async () => {
    const owners = Object.fromEntries(
      dashboard.bills.upcoming.map((/** @type {any} */ b) => [b.billId, b.ownerName]),
    );
    expect(owners[HOUSEHOLD_IDS.carInsurance]).toBe("Ada");
    expect(owners[HOUSEHOLD_IDS.power]).toBeNull();
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

  it("has nothing left to set up for a complete household", () => {
    expect(dashboard.setup.complete).toBe(true);
    expect(dashboard.setup.steps.every((/** @type {any} */ s) => s.done)).toBe(true);
    // No users exist in this fixture, so there is nobody to invite on behalf of.
    expect(dashboard.setup.steps.some((/** @type {any} */ s) => s.key === "invite")).toBe(false);
    expect(dashboard.setup.importHref).toBeNull();
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
    // The five booleans an older client reads, still there and still false.
    expect(dashboard.setup).toMatchObject({
      people: false,
      paySchedule: false,
      accounts: false,
      bills: false,
      allocation: false,
      complete: false,
      // An empty household is offered the importer.
      importHref: "/import",
    });
    expect(dashboard.setup.steps.map((/** @type {any} */ s) => s.key)).toEqual([
      "people",
      "income_landing_account",
      "pay_schedule",
      "income_variant",
      "variant_schedule",
      "bills",
      "variable_budgets",
      "allocation",
    ]);
    expect(dashboard.setup.steps.every((/** @type {any} */ s) => !s.done)).toBe(true);
    // Pay schedules live on /income now, not in Settings or on Accounts.
    expect(dashboard.setup.steps.find((/** @type {any} */ s) => s.key === "pay_schedule").href).toBe(
      "/income#pay-schedules",
    );
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

  it("keeps the setup list honest about what is only half done", async () => {
    const dashboard = await dashboardAfter(async (db) => {
      // Accounts exist, but none is where income lands.
      await db.update(accounts).set({ isIncomeLanding: false }).where(eq(accounts.id, HOUSEHOLD_IDS.everyday));
      // A variant with lines, but nothing saying it is running.
      await db.delete(variantSchedule);
      // A plan drafted — as an import leaves it — but never applied.
      await db
        .update(allocationVersions)
        .set({ status: "draft" })
        .where(eq(allocationVersions.id, HOUSEHOLD_IDS.activeVersion));
      // Two bills still on the importer's placeholder date.
      await db.update(bills).set({ dueDateConfirmed: false }).where(inArray(bills.id, [HOUSEHOLD_IDS.power, HOUSEHOLD_IDS.water]));
      // A household of one so far.
      await db.insert(users).values({ displayName: "Ada" });
    });
    /** @param {string} key */
    const step = (key) => dashboard.setup.steps.find((/** @type {any} */ s) => s.key === key);

    // "Accounts" ticks for an income-landing account, not for any account.
    expect(dashboard.setup.accounts).toBe(false);
    expect(step("income_landing_account").done).toBe(false);
    expect(step("income_landing_account").hint).toContain("None of your accounts");

    expect(step("income_variant").done).toBe(true);
    expect(step("variant_schedule").done).toBe(false);
    expect(step("variant_schedule").hint).toBe("One open-ended schedule entry is enough, even with a single variant.");

    expect(step("allocation").done).toBe(false);
    expect(step("allocation").hint).toContain("drafted but not applied");

    expect(step("due_dates")).toMatchObject({
      done: false,
      label: "Set the real due date of 2 imported bills",
      href: "/costs/fixed",
    });
    const dueDates = dashboard.warnings.find((/** @type {any} */ w) => w.code === "unconfirmed_due_dates");
    expect(dueDates).toEqual({
      code: "unconfirmed_due_dates",
      message: "2 bills still have a placeholder due date from the import — set their real dates on Fixed Costs.",
      href: "/costs/fixed",
    });

    expect(step("invite")).toMatchObject({ done: false, optional: true, href: "/admin/invites" });
    expect(dashboard.setup.complete).toBe(false);
  });

  it("counts an invite in flight, and never lets the invite step hold up completion", async () => {
    const dashboard = await dashboardAfter(async (db) => {
      await db.update(bills).set({ dueDateConfirmed: false }).where(eq(bills.id, HOUSEHOLD_IDS.power));
      const [user] = await db.insert(users).values({ displayName: "Ada" }).returning();
      await db.insert(invites).values({
        codeHash: "not-a-real-hash",
        purpose: "new_user",
        createdBy: user?.id ?? null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    });

    const invite = dashboard.setup.steps.find((/** @type {any} */ s) => s.key === "invite");
    expect(invite.done).toBe(true);
    // The only thing left is the placeholder date, in the singular.
    expect(
      dashboard.setup.steps.filter((/** @type {any} */ s) => !s.done && !s.optional).map((/** @type {any} */ s) => s.key),
    ).toEqual(["due_dates"]);
    const dueDates = dashboard.warnings.find((/** @type {any} */ w) => w.code === "unconfirmed_due_dates");
    expect(dueDates.message).toBe(
      "1 bill still has a placeholder due date from the import — set its real date on Fixed Costs.",
    );
    // And the upcoming list says which dates are real.
    for (const bill of dashboard.bills.upcoming) {
      expect(bill.dueDateConfirmed).toBe(bill.billId !== HOUSEHOLD_IDS.power);
    }
  });

  it("says so when a plan commits more than it has, even though the sweep balances the books", async () => {
    const dashboard = await dashboardAfter(async (db) => {
      // $20,000 a month to savings is far past what this household earns.
      // The Spending sweep in section C absorbs the gap by going negative,
      // so unallocated stays at zero and the transfers still sum to gross.
      await db.insert(allocationLines).values({
        versionId: HOUSEHOLD_IDS.activeVersion,
        stage: 2,
        label: "Far too much",
        basis: "fixed_amount",
        value: 2_000_000,
        accountId: HOUSEHOLD_IDS.savings,
        sortOrder: 5,
      });
    });
    const { overAllocation, unallocatedPerMonthCents, stages } = dashboard.allocation;

    expect(unallocatedPerMonthCents).toBe(0);
    expect(overAllocation.negativeStages).toEqual([2]);
    expect(overAllocation.negativeLineIds).toHaveLength(1);
    // The deepest the plan went past gross, which is where section B left it.
    expect(overAllocation.shortfallPerMonthCents).toBe(-stages[1].remainingPerMonthCents);

    const codes = dashboard.warnings.map((/** @type {any} */ w) => w.code);
    expect(codes).toContain("over_allocated");
    expect(codes).not.toContain("unallocated");
    const warning = dashboard.warnings.find((/** @type {any} */ w) => w.code === "over_allocated");
    // Named in the household's own currency, from settings.
    const amount = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(
      overAllocation.shortfallPerMonthCents / 100,
    );
    expect(warning.message).toContain(`commits ${amount} a month more`);
    expect(warning.message).toContain("1 line goes below zero");
    expect(warning.href).toBe("/allocation");
  });
});

describe("loadDashboard, on backups", () => {
  /** @type {Db} */
  let db;
  /** @type {() => Promise<void>} */
  let close;
  /** @type {string} */
  let dir;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedSettings(db);
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "budget-dashboard-backups-"));
    await db.delete(settings).where(eq(settings.key, BACKUP_STATUS_KEY));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function backupWarnings() {
    const app = new Hono().route("/dashboard", createDashboardRoutes({ db, backups: { dir } }));
    const dashboard = await get(app, `/dashboard?on=${ON}`);
    return dashboard.warnings.filter((/** @type {any} */ w) => w.code.startsWith("backup_"));
  }

  it("says when there is no automatic backup at all", async () => {
    const warnings = await backupWarnings();
    expect(warnings.map((/** @type {any} */ w) => w.code)).toEqual(["backup_overdue"]);
    expect(warnings[0].href).toBe("/admin/backups");
  });

  it("says nothing once this week's backup exists", async () => {
    await createBackup(db, { dir, appVersion: "test", kind: "weekly" });
    expect(await backupWarnings()).toEqual([]);
  });

  it("names the age of the newest backup when it is overdue", async () => {
    const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    await createBackup(db, { dir, appVersion: "test", kind: "weekly", now: nineDaysAgo });
    const [warning] = await backupWarnings();
    expect(warning.code).toBe("backup_overdue");
    expect(warning.message).toContain("No backup in 9 days");
  });

  it("puts a failed attempt ahead of an overdue one, and says it once", async () => {
    await db.insert(settings).values({
      key: BACKUP_STATUS_KEY,
      value: { at: new Date().toISOString(), kind: "weekly", ok: false, error: "ENOSPC: no space left on device" },
    });
    const warnings = await backupWarnings();
    expect(warnings.map((/** @type {any} */ w) => w.code)).toEqual(["backup_failed"]);
    expect(warnings[0].message).toContain("ENOSPC");
  });

  it("stays quiet where the app has no backup folder", async () => {
    const dashboard = await get(createReadApp(db), `/dashboard?on=${ON}`);
    expect(dashboard.warnings.some((/** @type {any} */ w) => w.code.startsWith("backup_"))).toBe(false);
  });
});
