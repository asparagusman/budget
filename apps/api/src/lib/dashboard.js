import { addDaysIso, ALLOCATION_SECTIONS, daysBetween, equivalent, resolveCycle, sumCents } from "@budget/engine";
import { allocationVersions, people } from "@budget/schema";
import { eq } from "drizzle-orm";
import {
  findVersionByStatus,
  linesForVersion,
  loadAllocationContext,
  resolveActiveAllocation,
  serializeLine,
} from "./allocation.js";
import { projectActiveBills } from "./bills.js";
import { loadGoals, loadNetWorth } from "./goals.js";
import { serializeVariant } from "./income.js";

/** @import { Cents, IsoDate } from "@budget/engine" */
/** @import { AllocationContext } from "./allocation.js" */

// Far enough ahead to always find five bills for the Upcoming card, whatever
// the household's cadences. Nothing is averaged over it — it is a lookup
// window, not a contribution window (that one is `FIXED_COST_WINDOW_DAYS`,
// four years, and lives in lib/allocation.js).
const UPCOMING_WINDOW_DAYS = 90;

// "Total due in 14 days" (phases/10-dashboard.md "Upcoming").
const DUE_SOON_DAYS = 14;

const UPCOMING_COUNT = 5;

// The net-worth card's window: twelve months back from the reported date.
const NET_WORTH_DAYS = 365;

// A balance older than this makes every figure derived from it quietly wrong,
// so the dashboard says so (phases/10-dashboard.md "Net worth").
const STALE_BALANCE_DAYS = 30;

// Where each warning is FIXED — a warning the operator cannot act on from the
// dashboard is just noise (phases/10-dashboard.md "Warnings strip"). Codes
// come from the phases that raise them; anything unmapped links to Settings
// rather than nowhere.
/** @type {Record<string, string>} */
const WARNING_HREFS = {
  variant_overlap: "/income",
  variant_gap: "/income",
  unallocated: "/allocation",
  unapplied_draft: "/allocation",
  no_active_allocation: "/allocation",
  ambiguous_active_allocation: "/allocation",
  no_income_landing_account: "/accounts",
  no_primary_pay_schedule: "/settings/pay-schedules",
  stale_balance: "/accounts",
  no_balance_recorded: "/accounts",
  orphaned_instances: "/costs/fixed",
  incomplete_seasonal_curve: "/costs/fixed",
  no_budget_set: "/costs/variable",
};

/** @param {{ code: string, message: string }} warning */
function withHref(warning) {
  return { code: warning.code, message: warning.message, href: WARNING_HREFS[warning.code] ?? "/settings/users" };
}

/**
 * Every non-archived account with the newest balance snapshot recorded against
 * it. Snapshots come back ascending, so the last one written into the map per
 * account is that account's latest — one query instead of one per account.
 *
 * @param {import("@budget/schema").Db} db
 */
async function loadAccountsWithBalances(db) {
  const [accountRows, snapshots] = await Promise.all([
    db.query.accounts.findMany({
      where: (a, { isNull: isNullCol }) => isNullCol(a.archivedAt),
      orderBy: (a, { asc }) => [asc(a.sortOrder), asc(a.name)],
    }),
    db.query.balanceSnapshots.findMany({ orderBy: (b, { asc }) => [asc(b.asAt)] }),
  ]);

  /** @type {Map<string, { amountCents: Cents, asAt: IsoDate }>} */
  const latest = new Map();
  for (const snapshot of snapshots) {
    latest.set(snapshot.accountId, { amountCents: snapshot.amountCents, asAt: snapshot.asAt });
  }

  return accountRows.map((account) => ({
    id: account.id,
    name: account.name,
    type: account.type,
    isIncomeLanding: account.isIncomeLanding,
    latestBalance: latest.get(account.id) ?? null,
  }));
}

/**
 * The next few bills and what falls due inside a fortnight. `actualCents ??
 * expectedCents` is the same precedence `billsContribution` uses, so a bill
 * the operator has already entered an actual for reads the same here as it
 * does in the contribution it feeds.
 *
 * @param {import("@budget/schema").Db} db
 * @param {IsoDate} on
 */
async function loadUpcomingBills(db, on) {
  const window = { from: on, to: addDaysIso(on, UPCOMING_WINDOW_DAYS) };
  const { bills, allInstances } = await projectActiveBills(db, window);
  const nameById = new Map(bills.map((b) => [b.id, b.name]));

  /** @param {{ expectedCents: Cents, actualCents: Cents | null }} instance */
  const amountOf = (instance) => instance.actualCents ?? instance.expectedCents;

  const ascending = allInstances
    .filter((i) => i.dueDate >= window.from && i.dueDate < window.to)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const dueSoonCutoff = addDaysIso(on, DUE_SOON_DAYS);

  return {
    billCount: bills.length,
    upcoming: ascending.slice(0, UPCOMING_COUNT).map((instance) => ({
      billId: instance.billId,
      billName: nameById.get(instance.billId) ?? "Unnamed bill",
      dueDate: instance.dueDate,
      amountCents: amountOf(instance),
    })),
    dueNext14DaysCents: sumCents(ascending.filter((i) => i.dueDate < dueSoonCutoff).map(amountOf)),
    dueSoonDays: DUE_SOON_DAYS,
  };
}

/**
 * Phase 07's per-category summary rolled up to one household figure. Only the
 * categories that actually have a trailing average take part — averaging a
 * category with no recorded cycles in as a zero would understate spending and
 * read as a saving that is not there. Null (never zero) when no category has
 * enough history, the same convention `summarizeVariableCategory` uses.
 *
 * @param {AllocationContext} context
 */
function rollUpVariable(context) {
  const hasCadence = context.hasPrimaryPaySchedule;
  /** @param {Cents} cents */
  const perPay = (cents) => (hasCadence ? equivalent(cents, "monthly", context.payCadence) : null);

  /** @type {Cents[]} */
  const trailing = [];
  /** @type {Cents[]} */
  const budgeted = [];
  let cyclesRecorded = 0;
  for (const category of context.variableSummary.byCategory) {
    cyclesRecorded = Math.max(cyclesRecorded, category.cyclesRecorded);
    if (category.trailingAveragePerMonthCents === null) continue;
    trailing.push(category.trailingAveragePerMonthCents);
    budgeted.push(category.budgetPerMonthCents);
  }

  const trailingAveragePerMonthCents = trailing.length > 0 ? sumCents(trailing) : null;

  return {
    essentialPerMonthCents: context.variableEssentialsPerMonthCents,
    essentialPerPayCents: perPay(context.variableEssentialsPerMonthCents),
    nonEssentialPerMonthCents: context.variableNonEssentialPerMonthCents,
    trailingAveragePerMonthCents,
    trailingAveragePerPayCents:
      trailingAveragePerMonthCents === null ? null : perPay(trailingAveragePerMonthCents),
    // Per MONTH, matching the budget it is measured against. Positive means
    // the household is spending more than it budgeted in the categories that
    // have history — never inverted here, only in how the UI colours it.
    varianceCents:
      trailingAveragePerMonthCents === null ? null : trailingAveragePerMonthCents - sumCents(budgeted),
    categoriesWithHistory: trailing.length,
    cyclesRecorded,
  };
}

/**
 * The hero card's figures, grouped by the three SECTIONS — Bills & Essentials,
 * Save Invest & Give, Leftover. They are the headings the spreadsheet has, and
 * they are stages 1/2/3 named, so one tile per section covers every line
 * exactly once and the tiles sum to gross.
 *
 * There is no capping and no "N smaller categories" tile: three sections is
 * three tiles at every width. A per-line `category` grouping lived here, could
 * produce arbitrarily many groups, and had to fall back to grouping by BASIS
 * when no line happened to be named — both paths are gone with the field, and
 * with them the "Allocated out" tile that existed only because the app had no
 * name for the group it was describing (todo.md `[P10-2]`).
 *
 * Every figure comes from the engine's own `StageResult` — nothing here
 * re-derives a percentage or converts a cadence, so a tile cannot disagree
 * with the section it names on /allocation.
 *
 * @param {import("@budget/engine").AllocationResult} result
 * @param {{ stage: number }[]} lines
 * @param {AllocationContext} context
 */
function buildBreakdown(result, lines, context) {
  return ALLOCATION_SECTIONS.map((section) => {
    const stage = result.stages.find((s) => s.stage === section.stage) ?? null;
    return {
      key: section.key,
      label: section.name,
      perMonthCents: stage?.subtotalPerMonthCents ?? 0,
      // The engine already converted this subtotal with the same cadence.
      // Nulling it when there is no primary pay schedule is the repo-wide
      // convention for a per-pay figure with no period to be per.
      perPayCents: context.hasPrimaryPaySchedule ? stage?.subtotalPerPayCents ?? 0 : null,
      pctOfGross: stage?.actualPct ?? null,
      goalPct: stage?.goalPct ?? null,
      // Whether that goal was set on the section or summed from its lines —
      // the same distinction /allocation draws, so the two screens describe
      // one figure the same way.
      goalSource: stage?.goalSource ?? null,
      fidelity: stage?.fidelity ?? null,
      lineCount: lines.filter((line) => line.stage === section.stage).length,
    };
  });
}

/**
 * The whole `/dashboard` payload. Every figure is read from the endpoint or
 * engine function that owns it — this file sums, filters and picks, and does
 * no financial arithmetic of its own. A second implementation of a rule here
 * is how the dashboard and the screen it links to drift apart
 * (phases/10-dashboard.md "Data").
 *
 * @param {import("@budget/schema").Db} db
 * @param {IsoDate} on
 */
export async function loadDashboard(db, on) {
  const context = await loadAllocationContext(db, on);
  const allocation = await resolveActiveAllocation(db, context);

  const [accounts, billsPayload, netWorthPayload, goalsPayload, peopleCount, activeVersionCount, draftVersion, activeLines] =
    await Promise.all([
      loadAccountsWithBalances(db),
      loadUpcomingBills(db, on),
      loadNetWorth(db, { from: addDaysIso(on, -NET_WORTH_DAYS), to: on }),
      loadGoals(db, { on, context, allocation }),
      db.$count(people),
      db.$count(allocationVersions, eq(allocationVersions.status, "active")),
      allocation.plan ? findVersionByStatus(db, allocation.plan.id, "draft") : Promise.resolve(null),
      allocation.version ? linesForVersion(db, allocation.version.id) : Promise.resolve([]),
    ]);

  // ---- cycle -------------------------------------------------------------
  // Every date on the screen hangs off the primary pay schedule. Without one
  // there is no cycle to report, so the banner says so rather than inventing
  // a fortnight (phases/README.md "The one rule").
  const resolvedCycle = context.paySchedule ? resolveCycle(context.paySchedule, on) : null;
  const cycle = resolvedCycle
    ? {
        cycleStart: resolvedCycle.cycleStart,
        cycleEnd: resolvedCycle.cycleEnd,
        payCadence: context.payCadence,
        daysRemaining: daysBetween(on, resolvedCycle.cycleEnd),
        // The cycle selector moves by setting `?on=`; handing it the two
        // neighbouring dates keeps cadence arithmetic out of the browser
        // (phases/10-dashboard.md "No financial arithmetic in dashboard
        // components").
        previousOn: addDaysIso(resolvedCycle.cycleStart, -1),
        nextOn: resolvedCycle.cycleEnd,
      }
    : null;

  // ---- variant -----------------------------------------------------------
  const variantRow = context.resolvedVariantId
    ? (await db.query.incomeVariants.findFirst({
        where: (v, { eq: eqCol }) => eqCol(v.id, /** @type {string} */ (context.resolvedVariantId)),
      })) ?? null
    : null;
  const variantLines = variantRow
    ? await db.query.incomeLines.findMany({
        where: (l, { eq: eqCol }) => eqCol(l.variantId, variantRow.id),
        orderBy: (l, { asc }) => [asc(l.sortOrder)],
      })
    : [];
  // Phase 05's own serializer, so the income the banner names is the income
  // /income reports for the same variant to the cent.
  const serialized = variantRow
    ? serializeVariant(variantRow, variantLines, context.hasPrimaryPaySchedule ? context.payCadence : null)
    : null;
  const variant = {
    id: serialized?.id ?? null,
    name: serialized?.name ?? null,
    totalPerPayCents: serialized?.totals.totalCents.perPay ?? null,
    totalPerMonthCents: serialized?.totals.totalCents.perMonth ?? null,
    diagnostics: context.resolutionDiagnostics,
  };

  // ---- allocation --------------------------------------------------------
  const result = allocation.result;
  const grossPerPayCents = context.hasPrimaryPaySchedule
    ? equivalent(allocation.grossPerMonthCents, "monthly", context.payCadence)
    : null;
  const allocationPayload =
    allocation.plan && allocation.version && result
      ? {
          versionId: allocation.version.id,
          version: allocation.version.version,
          planId: allocation.plan.id,
          planName: allocation.plan.name,
          incomeVariantId: allocation.plan.incomeVariantId,
          grossPerMonthCents: allocation.grossPerMonthCents,
          grossPerPayCents,
          transfers: result.transfers,
          // The engine's own `StageResult`s, passed through untouched — they
          // already carry per-month, per-pay and per-week. Whether the pay
          // figures mean anything is `grossPerPayCents`/`setup.paySchedule`'s
          // job to say; blanking them here only broke the engine's own type
          // for every component that takes an `AllocationResult`.
          stages: result.stages,
          // Stage, label and destination per line — what the flow diagram
          // needs to draw income -> stage -> account, the same shape
          // /allocation draws it from.
          lines: activeLines.map(serializeLine),
          resolvedLines: result.lines,
          // What the hero card puts under the income figure — grouped here,
          // not in a component (phases/10-dashboard.md "No financial
          // arithmetic in dashboard components").
          breakdown: buildBreakdown(result, activeLines, context),
          unallocatedPerMonthCents: result.unallocatedPerMonthCents,
          goodLifeFidelityCents: result.goodLifeFidelityCents,
          hasDraft: draftVersion !== null,
        }
      : null;

  // ---- net worth ---------------------------------------------------------
  // Before `knownFrom` every total is a zero meaning "unknown", not "empty" —
  // drawing those would put a cliff at the left edge of the chart, and with no
  // snapshot at all (`knownFrom === null`) it would draw a flat zero line for a
  // year, which reads as "we have nothing" rather than "we have never said".
  const series =
    netWorthPayload.knownFrom === null
      ? []
      : netWorthPayload.totalPoints.filter(
          (point) => point.date >= /** @type {IsoDate} */ (netWorthPayload.knownFrom),
        );
  const lastPoint = series[series.length - 1] ?? null;
  const heldAccounts = accounts.filter((a) => a.type !== "external");
  /** @type {IsoDate[]} */
  const recordedDates = [];
  /** @type {typeof heldAccounts} */
  const unrecordedAccounts = [];
  for (const account of heldAccounts) {
    if (account.latestBalance) recordedDates.push(account.latestBalance.asAt);
    else unrecordedAccounts.push(account);
  }
  // ISO dates compare correctly as plain strings, so the oldest is just the
  // smallest.
  const stalestAsAt = recordedDates.length > 0 ? recordedDates.reduce((a, b) => (a < b ? a : b)) : null;
  const netWorth = {
    totalCents: lastPoint ? lastPoint.totalCents : 0,
    series,
    stalestAsAt,
    staleDays: stalestAsAt === null ? null : daysBetween(stalestAsAt, on),
    staleAfterDays: STALE_BALANCE_DAYS,
    accountsWithoutBalance: unrecordedAccounts.length,
  };

  // ---- mojo --------------------------------------------------------------
  // The household's expense-cover goal, if it has one. `months_of_expenses` is
  // the mode that means "emergency fund" — the app never assumes an account
  // called Mojo exists, only that a goal may be measured in months of cover
  // (phases/09-goals-projections.md "the Mojo mode").
  const activeGoals = goalsPayload.goals.filter((g) => g.goal.status === "active");
  const coverGoal = activeGoals.find((g) => g.goal.targetMode === "months_of_expenses") ?? null;
  const nextThreshold = coverGoal?.thresholds?.find((t) => !t.covered) ?? null;
  const mojo = coverGoal
    ? {
        goalId: coverGoal.goal.id,
        name: coverGoal.goal.name,
        accountName: coverGoal.account.name,
        balanceCents: coverGoal.currentBalanceCents,
        monthsCovered: coverGoal.monthsCovered,
        burnPerMonthCents: goalsPayload.summary.monthlyEssentialBurnCents,
        nextThresholdMonths: nextThreshold?.months ?? null,
        // Periods of the household's own pay cadence — fortnights here, but
        // the field is named for the cadence rather than for this household.
        // Weeks are what the source spreadsheet said, and they were wrong by
        // half (phases/09-goals-projections.md "/goals").
        periodsToNextThreshold: nextThreshold?.periodsToReach ?? null,
        approxMonthsToNextThreshold: nextThreshold?.approxMonthsToReach ?? null,
        nextThresholdEta: nextThreshold?.eta ?? null,
        payCadence: context.payCadence,
      }
    : null;

  // ---- goals -------------------------------------------------------------
  const goals = activeGoals.map((g) => ({
    id: g.goal.id,
    name: g.goal.name,
    accountName: g.account.name,
    progressPct: g.progressPct,
    etaDate: g.eta.date,
    aheadBehindDays: g.eta.aheadBehindDays,
    isFunded: g.isFunded,
    reached: g.reached,
    currentBalanceCents: g.currentBalanceCents,
    targetCents: g.targetCents,
  }));

  // ---- setup path --------------------------------------------------------
  // What the operator still has to do before any of the above means anything.
  // The dashboard is the first screen they ever see, so it has to be the one
  // that says where to start (phases/10-dashboard.md "Empty state on day one").
  const setup = {
    people: peopleCount > 0,
    paySchedule: context.hasPrimaryPaySchedule,
    accounts: accounts.length > 0,
    bills: billsPayload.billCount > 0,
    // "Have you built one?", not "does one apply on this date?". An ambiguous
    // income schedule leaves `allocationPayload` null even though the plan
    // exists, and telling the operator to go build an allocation they already
    // have would point them away from the thing that is actually wrong — the
    // warnings strip is where that gets said.
    allocation: activeVersionCount > 0,
  };

  // ---- warnings ----------------------------------------------------------
  // Ordered most-actionable first: the UI shows three and collapses the rest,
  // so the order here decides which three those are.
  /** @type {{ code: string, message: string }[]} */
  const warnings = [];

  for (const diagnostic of context.resolutionDiagnostics) {
    warnings.push(
      diagnostic.kind === "overlap"
        ? {
            code: "variant_overlap",
            message: `${diagnostic.variantIds.length} income variants both cover ${on}, so none is in effect. Fix the schedule and every figure below resolves.`,
          }
        : {
            code: "variant_gap",
            message: `No income variant covers ${on}, so there is nothing to divide. Add a schedule entry covering this date.`,
          },
    );
  }
  if (result && result.unallocatedPerMonthCents !== 0) {
    warnings.push({
      code: "unallocated",
      message:
        result.unallocatedPerMonthCents > 0
          ? "Some income is not allocated anywhere — it stays in the income account."
          : "This plan allocates more than the income it has. Nothing is rebalanced for you.",
    });
  }
  if (allocationPayload?.hasDraft) {
    warnings.push({
      code: "unapplied_draft",
      message: `The ${allocationPayload.planName} plan has an unapplied draft — the transfers below are still the active version's.`,
    });
  }
  if (allocation.warning) warnings.push(allocation.warning);
  if (netWorth.staleDays !== null && netWorth.staleDays > STALE_BALANCE_DAYS) {
    warnings.push({
      code: "stale_balance",
      message: `The oldest account balance is ${netWorth.staleDays} days old — net worth and every goal below are only as accurate as that.`,
    });
  }
  if (unrecordedAccounts.length > 0) {
    warnings.push({
      code: "no_balance_recorded",
      message: `${unrecordedAccounts.length} account${unrecordedAccounts.length === 1 ? " has" : "s have"} no balance recorded yet, so ${unrecordedAccounts.length === 1 ? "it counts" : "they count"} as zero towards net worth.`,
    });
  }
  warnings.push(...context.warnings);
  warnings.push(...context.variableSummary.warnings.map((w) => ({ code: w.code, message: w.message })));

  // One warning per problem. Several phases legitimately raise the same code
  // for the same underlying gap — a missing pay schedule stops both the
  // allocation and the trailing averages — and saying it twice inside a strip
  // that only shows three would push a different problem out of view.
  /** @type {Set<string>} */
  const seenCodes = new Set();
  const deduped = warnings.filter((w) => (seenCodes.has(w.code) ? false : seenCodes.add(w.code)));

  return {
    on,
    cycle,
    variant,
    bills: {
      contributionPerPayCents: context.fixedTotalPerPayCents,
      contributionPerMonthCents: context.fixedTotalPerMonthCents,
      dueNext14DaysCents: billsPayload.dueNext14DaysCents,
      dueSoonDays: billsPayload.dueSoonDays,
      nextDue: billsPayload.upcoming[0] ?? null,
      upcoming: billsPayload.upcoming,
      billCount: billsPayload.billCount,
    },
    variable: rollUpVariable(context),
    allocation: allocationPayload,
    accounts,
    netWorth,
    mojo,
    goals,
    setup: { ...setup, complete: Object.values(setup).every(Boolean) },
    warnings: deduped.map(withHref),
  };
}
