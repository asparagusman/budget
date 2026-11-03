import {
  OCCURRENCES_PER_YEAR,
  addDaysIso,
  daysBetween,
  futureValueCents,
  goalEta,
  goalRequired,
  mustAt,
  periodRate,
  periodsBetween,
  resolveTargetCents,
  sumCents,
} from "@budget/engine";
import { loadAllocationContext, resolveActiveAllocation } from "./allocation.js";

/** @import { Cadence, Cents, IsoDate } from "@budget/engine" */
/** @import { AllocationContext } from "./allocation.js" */

/**
 * @typedef {{
 *   id: string,
 *   accountId: string,
 *   name: string,
 *   targetMode: "amount" | "months_of_expenses",
 *   targetAmountCents: Cents | null,
 *   targetMonths: number | null,
 *   targetDate: IsoDate | null,
 *   note: string | null,
 *   status: "active" | "achieved" | "abandoned",
 *   createdAt: Date,
 * }} StoredGoal
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   type: "transaction" | "savings" | "investment" | "external",
 *   annualGrowthRate: number | null,
 * }} GoalAccount
 */

// The emergency fund's own scale markers (phases/09-goals-projections.md
// "/goals": "markers at the 1 / 3 / 6 / 12-month thresholds").
const EXPENSE_THRESHOLD_MONTHS = /** @type {const} */ ([1, 3, 6, 12]);

// A goal that even compound growth can't reach inside a human lifetime has no
// useful ETA, and asking the engine for one would have it simulate a million
// pay periods — one curve point each — to say so. The guard below answers the
// same question in closed form first.
const HORIZON_YEARS = 100;

// Enough shape for a card-sized chart; the detail endpoint asks for more.
const CURVE_POINTS_LIST = 90;
const CURVE_POINTS_DETAIL = 400;

/**
 * Which target field is required depends on `targetMode`, and `external`
 * accounts can't have goals at all — semantic rules, not shape rules, so they
 * live here rather than in Zod (the same split as bills' `amountModelFieldError`).
 * Pass the fully-resolved values (create: as submitted; update: merged over
 * the current row), not just the PATCH delta.
 *
 * @param {{ targetMode: string, targetAmountCents?: Cents | null, targetMonths?: number | null }} data
 */
export function targetModeFieldError(data) {
  if (data.targetMode === "amount" && data.targetAmountCents == null) {
    return "An amount goal needs a target amount.";
  }
  if (data.targetMode === "months_of_expenses" && data.targetMonths == null) {
    return "A months-of-expenses goal needs a number of months.";
  }
  return null;
}

/**
 * Stage 1 of the allocation: what the household spends each month to keep the
 * lights on. `months_of_expenses` targets resolve against this at READ time,
 * so they stay correct as costs change instead of going stale the way a
 * hardcoded dollar figure would (phases/09-goals-projections.md "the Mojo
 * mode").
 *
 * @param {AllocationContext} context
 */
export function monthlyEssentialBurnCents(context) {
  return context.fixedTotalPerMonthCents + context.variableEssentialsPerMonthCents;
}

/**
 * Thins a curve to at most `max` points, always keeping the first and last —
 * a goal thirty years out resolves to hundreds of pay periods and the card
 * that draws it needs a shape, not every point.
 *
 * @template T
 * @param {T[]} points
 * @param {number} max
 */
function downsample(points, max) {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const thinned = points.filter((_, i) => i % step === 0);
  const last = points[points.length - 1];
  if (last !== undefined && thinned[thinned.length - 1] !== last) thinned.push(last);
  return thinned;
}

/**
 * Could this goal be reached at all inside `HORIZON_YEARS`, growth included?
 * Closed form via the engine's own future-value formula (which is per-period,
 * not month-specific, despite its parameter names) rather than the
 * period-by-period simulation `goalEta` runs.
 *
 * @param {{ targetCents: Cents, currentBalanceCents: Cents, contributionPerPayCents: Cents, payCadence: Cadence, annualGrowthRate: number }} args
 */
function reachableWithinHorizon(args) {
  if (args.currentBalanceCents >= args.targetCents) return true;
  if (args.contributionPerPayCents <= 0) return false;
  const periods = OCCURRENCES_PER_YEAR[args.payCadence] * HORIZON_YEARS;
  const rate = periodRate(args.annualGrowthRate, args.payCadence);
  return (
    futureValueCents(args.currentBalanceCents, args.contributionPerPayCents, rate, periods) >= args.targetCents
  );
}

/**
 * One goal, fully reported and nothing written. Everything derived here is
 * computed on read — target, progress, ETA, required contribution — because a
 * cached figure on a financial screen is worse than no figure
 * (phases/09-goals-projections.md "Schema").
 *
 * @param {{
 *   goal: StoredGoal,
 *   account: GoalAccount,
 *   balance: { amountCents: Cents, asAt: IsoDate } | null,
 *   contributionPerPayCents: Cents,
 *   contributionPerMonthCents: Cents,
 *   isFunded: boolean,
 *   burnPerMonthCents: Cents,
 *   payCadence: Cadence,
 *   grossPerMonthCents: Cents,
 *   on: IsoDate,
 *   curvePoints?: number,
 * }} args
 */
export function serializeGoal(args) {
  const { goal, account, balance, contributionPerPayCents, burnPerMonthCents, payCadence, on } = args;

  const targetCents = resolveTargetCents(
    {
      id: goal.id,
      accountId: goal.accountId,
      targetMode: goal.targetMode,
      targetAmountCents: goal.targetAmountCents,
      targetMonths: goal.targetMonths,
      targetDate: goal.targetDate,
    },
    burnPerMonthCents,
  );
  const currentBalanceCents = balance?.amountCents ?? 0;
  const annualGrowthRate = account.annualGrowthRate ?? 0;

  // `targetCents` is null for a months-of-expenses goal while no costs are
  // recorded — the engine won't call months of nothing a target. Nothing
  // below can be measured against it, so every derived figure stays empty
  // rather than reading as "Reached" against $0.
  const withinHorizon =
    targetCents !== null &&
    reachableWithinHorizon({
      targetCents,
      currentBalanceCents,
      contributionPerPayCents,
      payCadence,
      annualGrowthRate,
    });

  const projection =
    targetCents !== null && withinHorizon
      ? goalEta({
          targetCents,
          currentBalanceCents,
          contributionPerPayCents,
          payCadence,
          annualGrowthRate,
          from: on,
        })
      : { eta: null, aheadBehindDays: null, curve: [{ date: on, balanceCents: currentBalanceCents }] };

  // A ratio of two figures the engine produced, for display — not a financial
  // rule of its own, which is why it isn't an engine function. Reported raw
  // rather than clamped: 112% is a goal that has been overshot, and hiding
  // that behind a capped bar would be a lie about the balance.
  const progressPct = targetCents !== null && targetCents > 0 ? (currentBalanceCents / targetCents) * 100 : 0;

  const required =
    goal.targetDate !== null && targetCents !== null
      ? goalRequired({
          targetCents,
          currentBalanceCents,
          targetDate: goal.targetDate,
          payCadence,
          annualGrowthRate,
          grossPerMonthCents: args.grossPerMonthCents,
          from: on,
        })
      : null;

  // With no computable target the figures that would carry one say 0, not
  // null — the screens already reading them type them as plain cents, so
  // `targetComputable` is what marks the 0 as meaningless. Make them null
  // once every reader checks that flag first.
  const reportedTargetCents = targetCents ?? 0;

  const curve = downsample(projection.curve, args.curvePoints ?? CURVE_POINTS_LIST).map((point) => ({
    date: point.date,
    projectedCents: point.balanceCents,
    targetCents: reportedTargetCents,
  }));

  return {
    goal: {
      id: goal.id,
      accountId: goal.accountId,
      name: goal.name,
      targetMode: goal.targetMode,
      targetAmountCents: goal.targetAmountCents,
      targetMonths: goal.targetMonths,
      targetDate: goal.targetDate,
      note: goal.note,
      status: goal.status,
      createdAt: goal.createdAt.toISOString(),
    },
    account,
    targetCents: reportedTargetCents,
    // False only for a months-of-expenses goal before any essential cost is
    // recorded. Then `targetCents` and `progressPct` are a placeholder 0,
    // `reached` is false, and the ETA, required contribution and thresholds
    // are null — "needs costs recorded", not "Reached".
    targetComputable: targetCents !== null,
    currentBalanceCents,
    currentBalanceAsAt: balance?.asAt ?? null,
    contributionPerPayCents,
    contributionPerMonthCents: args.contributionPerMonthCents,
    // An account with a goal and no allocation line contributes zero — said
    // honestly rather than hiding the goal (phases/09-goals-projections.md
    // "API").
    isFunded: args.isFunded,
    progressPct,
    reached: targetCents !== null && currentBalanceCents >= targetCents,
    eta: { date: projection.eta, aheadBehindDays: projection.aheadBehindDays },
    // Distinguishes "no contribution, so no ETA" from "so slow it never
    // arrives" — both report a null ETA, and the operator deserves to know
    // which one they're looking at.
    beyondHorizon: targetCents !== null && !withinHorizon && contributionPerPayCents > 0,
    horizonYears: HORIZON_YEARS,
    required,
    curve,
    // The emergency fund's own framing: how long the household could last, and
    // when each further month of cover arrives at the current contribution.
    // Durations are periods of the PAY cadence and approximate months —
    // never weeks (phases/09-goals-projections.md "/goals").
    monthsCovered:
      goal.targetMode === "months_of_expenses" && burnPerMonthCents > 0
        ? currentBalanceCents / burnPerMonthCents
        : null,
    // Null with no burn to multiply, for the same reason the target is: four
    // thresholds of $0, all "covered", would be the same lie four times.
    thresholds:
      goal.targetMode === "months_of_expenses" && burnPerMonthCents > 0
        ? EXPENSE_THRESHOLD_MONTHS.map((months) => {
            const thresholdCents = Math.round(burnPerMonthCents * months);
            const reachable = reachableWithinHorizon({
              targetCents: thresholdCents,
              currentBalanceCents,
              contributionPerPayCents,
              payCadence,
              annualGrowthRate,
            });
            const eta = reachable
              ? goalEta({
                  targetCents: thresholdCents,
                  currentBalanceCents,
                  contributionPerPayCents,
                  payCadence,
                  annualGrowthRate,
                  from: on,
                }).eta
              : null;
            return {
              months,
              targetCents: thresholdCents,
              covered: currentBalanceCents >= thresholdCents,
              eta,
              periodsToReach: eta ? periodsBetween(on, eta, payCadence) : null,
              approxMonthsToReach: eta ? periodsBetween(on, eta, "monthly") : null,
            };
          })
        : null,
  };
}

/** @typedef {ReturnType<typeof serializeGoal>} SerializedGoal */

/**
 * @param {import("@budget/schema").Db} db
 * @param {string} accountId
 * @param {IsoDate} on
 */
export async function balanceAsOf(db, accountId, on) {
  const latest = await db.query.balanceSnapshots.findFirst({
    where: (b, { and: andCol, eq: eqCol, lte }) => andCol(eqCol(b.accountId, accountId), lte(b.asAt, on)),
    orderBy: (b, { desc: descCol }) => descCol(b.asAt),
  });
  return latest ? { amountCents: latest.amountCents, asAt: latest.asAt } : null;
}

/**
 * The shared read path behind `GET /goals` and `GET /goals/:id`: the
 * allocation context (for the essential burn and the per-account
 * contributions), every goal serialized against it, and the summary.
 *
 * The summary reports a shortfall and stops. No ranking field, no suggested
 * order, no "fund this one first" — the operator chose informational over
 * authoritative, twice (phases/09-goals-projections.md "Advisory only").
 *
 * `context` and `allocation` are optional: a caller that has already assembled
 * them for the same date passes them in rather than paying for a second
 * identical load. The dashboard is that caller — it reports goals alongside
 * the allocation those goals are funded by, and loading the context twice
 * would be both slower and a chance for the two halves of one screen to
 * disagree.
 *
 * @param {import("@budget/schema").Db} db
 * @param {{
 *   on: IsoDate,
 *   goalId?: string,
 *   curvePoints?: number,
 *   context?: AllocationContext,
 *   allocation?: Awaited<ReturnType<typeof resolveActiveAllocation>>,
 * }} options
 */
export async function loadGoals(db, { on, goalId, curvePoints, context: loadedContext, allocation: loadedAllocation }) {
  const context = loadedContext ?? (await loadAllocationContext(db, on));
  const allocation = loadedAllocation ?? (await resolveActiveAllocation(db, context));

  const goalRows = await db.query.goals.findMany({
    where: (g, { eq: eqCol }) => (goalId ? eqCol(g.id, goalId) : undefined),
    orderBy: (g, { asc }) => [asc(g.createdAt)],
  });

  const accountRows = await db.query.accounts.findMany();
  const accountById = new Map(accountRows.map((a) => [a.id, a]));

  const transferByAccount = new Map(
    (allocation.result?.transfers ?? []).map((t) => [t.accountId, t]),
  );
  const burnPerMonthCents = monthlyEssentialBurnCents(context);

  /** @type {SerializedGoal[]} */
  const goals = [];
  for (const row of goalRows) {
    const account = accountById.get(row.accountId);
    if (!account) continue;
    const transfer = transferByAccount.get(row.accountId) ?? null;
    goals.push(
      serializeGoal({
        goal: row,
        account: {
          id: account.id,
          name: account.name,
          type: account.type,
          annualGrowthRate: account.annualGrowthRate,
        },
        balance: await balanceAsOf(db, row.accountId, on),
        contributionPerPayCents: transfer?.perPayCents ?? 0,
        contributionPerMonthCents: transfer?.perMonthCents ?? 0,
        isFunded: transfer !== null && transfer.perPayCents > 0,
        burnPerMonthCents,
        payCadence: context.payCadence,
        grossPerMonthCents: allocation.grossPerMonthCents,
        on,
        curvePoints,
      }),
    );
  }

  // Active goals only: an achieved or abandoned goal is history, and counting
  // it would overstate what the household still needs to find.
  const active = goals.filter((g) => g.goal.status === "active");
  // `goalRequired` never goes below zero itself now, so a goal already met
  // adds nothing here without a clamp of this file's own.
  const totalRequiredPerPayCents = sumCents(active.map((g) => g.required?.perPayCents ?? 0));
  const totalAllocatedToGoalsPerPayCents = sumCents(active.map((g) => g.contributionPerPayCents));

  /** @type {{ code: string, message: string }[]} */
  const warnings = [...context.warnings];
  if (allocation.warning) warnings.push(allocation.warning);

  return {
    goals,
    summary: {
      on,
      activeCount: active.length,
      payCadence: context.payCadence,
      hasPrimaryPaySchedule: context.hasPrimaryPaySchedule,
      monthlyEssentialBurnCents: burnPerMonthCents,
      grossPerMonthCents: allocation.grossPerMonthCents,
      allocationPlan: allocation.plan ? { id: allocation.plan.id, name: allocation.plan.name } : null,
      totalRequiredPerPayCents,
      totalAllocatedToGoalsPerPayCents,
      // Positive means the goals with a deadline need more than the allocation
      // currently sends to them. Reported, and nothing more.
      shortfallPerPayCents: totalRequiredPerPayCents - totalAllocatedToGoalsPerPayCents,
      goalsWithDeadline: active.filter((g) => g.required !== null).length,
    },
    warnings,
  };
}

/**
 * Balance history across every non-`external` account, sampled on a regular
 * grid. Never interpolates: each sample carries the last snapshot at or before
 * it, with its own `asAt` so the UI can show how stale that is
 * (phases/09-goals-projections.md "API").
 *
 * @param {import("@budget/schema").Db} db
 * @param {{ from: IsoDate, to: IsoDate }} window
 */
export async function loadNetWorth(db, window) {
  // Archived accounts too. Archiving a closed account says it no longer
  // counts from that day on, not that the household never owned what it
  // held — filtering them out here erased their balances from every date in
  // the history, and the chart drew a past that never happened.
  const allAccountRows = await db.query.accounts.findMany({
    where: (a, { ne }) => ne(a.type, "external"),
    orderBy: (a, { asc }) => [asc(a.sortOrder), asc(a.name)],
  });
  const accountRows = allAccountRows
    .map((account) => ({ ...account, archivedOn: account.archivedAt ? localCalendarDate(account.archivedAt) : null }))
    // One archived before the window opened contributes nothing to it.
    .filter((account) => account.archivedOn === null || account.archivedOn > window.from);
  const snapshots = await db.query.balanceSnapshots.findMany({
    orderBy: (b, { asc }) => [asc(b.asAt)],
  });

  // Every date a balance was actually recorded, plus a regular grid: without
  // the recorded dates the chart's steps land wherever the grid happens to
  // fall, which for a household that updates balances every few months means
  // a step drawn days away from the day it really happened.
  const dates = sampleDates(
    window.from,
    window.to,
    snapshots.map((s) => s.asAt),
  );

  const accounts = accountRows.map((account) => {
    const own = snapshots.filter((s) => s.accountId === account.id);
    let index = -1;
    const points = dates.map((date) => {
      // From the day it was archived the account is out of every total. Its
      // `asAt` goes null with it, so a closed account's last balance can't
      // make today's net worth read as stale.
      if (account.archivedOn !== null && date >= account.archivedOn) {
        return { date, balanceCents: 0, asAt: null };
      }
      while (index + 1 < own.length && mustAt(own, index + 1, "snapshot").asAt <= date) index++;
      const current = index >= 0 ? mustAt(own, index, "snapshot") : null;
      return {
        date,
        balanceCents: current?.amountCents ?? 0,
        // Null before the first snapshot: no balance was ever recorded on or
        // before this date, which is different from a recorded zero.
        asAt: current?.asAt ?? null,
      };
    });
    return { id: account.id, name: account.name, type: account.type, archivedOn: account.archivedOn, points };
  });

  const totalPoints = dates.map((date, i) => ({
    date,
    totalCents: sumCents(accounts.map((a) => mustAt(a.points, i, "net worth point").balanceCents)),
  }));

  // Before this date the totals are not net worth: a zero that means "unknown"
  // rather than "empty", and after it, until every account has its first
  // balance, a partial sum that climbs each time another account is entered.
  // The history starts on the first date every account that has ever been
  // given a balance has one — where the balances exist as a set — so the line
  // never draws a climb that didn't happen. An account with no snapshot at all
  // is counted as zero everywhere and takes no part, and an external one is
  // not in `accountRows`, so its balances can't move the date.
  const firstSnapshotOn = accountRows
    .map((account) => snapshots.find((s) => s.accountId === account.id)?.asAt ?? null)
    .filter((asAt) => asAt !== null);
  const knownFrom = firstSnapshotOn.length > 0 ? firstSnapshotOn.reduce((a, b) => (a > b ? a : b)) : null;

  return { window, knownFrom, accounts, totalPoints };
}

/**
 * The calendar date a timestamp falls on in the server's own timezone — the
 * same local reading `todayIso` makes of "now", so an account archived this
 * afternoon is archived as of today's date on every screen.
 *
 * @param {Date} timestamp
 */
function localCalendarDate(timestamp) {
  const y = timestamp.getFullYear();
  const m = String(timestamp.getMonth() + 1).padStart(2, "0");
  const d = String(timestamp.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// About one point a week over a year, or one a month over five — enough shape
// for a line chart without shipping a row per day.
const NET_WORTH_MAX_POINTS = 60;

/**
 * @param {IsoDate} from
 * @param {IsoDate} to
 * @param {IsoDate[]} [mustInclude] Dates inside the window that have to be sampled exactly.
 */
function sampleDates(from, to, mustInclude = []) {
  const span = daysBetween(from, to);
  if (span <= 0) return [from];
  const step = Math.max(1, Math.ceil(span / NET_WORTH_MAX_POINTS));
  /** @type {Set<IsoDate>} */
  const dates = new Set();
  for (let day = 0; day <= span; day += step) dates.add(addDaysIso(from, day));
  dates.add(to);
  for (const date of mustInclude) {
    if (date >= from && date <= to) dates.add(date);
  }
  return Array.from(dates).sort();
}

/**
 * Compound growth per account, at the household's current contributions
 * (phases/09-goals-projections.md "/projections"). Rates are stored annually
 * and converted by the engine's `periodRate` — never divided by twelve here.
 *
 * @param {import("@budget/schema").Db} db
 * @param {{ months: number, on: IsoDate }} options
 */
export async function loadProjections(db, { months, on }) {
  const context = await loadAllocationContext(db, on);
  const allocation = await resolveActiveAllocation(db, context);
  const transferByAccount = new Map((allocation.result?.transfers ?? []).map((t) => [t.accountId, t]));

  // Savings and investment accounts only. A transaction account's allocation
  // "contribution" is money that goes straight back out as bills or groceries
  // — compounding it would project the income-landing account to six figures
  // of money the household has already spent. `type` is exactly this
  // distinction: phase 04 defines transaction and external accounts as the
  // ones with no compounding assumption (packages/schema/src/tables/accounts.js).
  const accountRows = await db.query.accounts.findMany({
    where: (a, { and: andCol, inArray, isNull: isNullCol }) =>
      andCol(isNullCol(a.archivedAt), inArray(a.type, ["savings", "investment"])),
    orderBy: (a, { asc }) => [asc(a.sortOrder), asc(a.name)],
  });

  const horizons = PROJECTION_HORIZONS.filter((h) => h <= months);

  const accounts = await Promise.all(
    accountRows.map(async (account) => {
      const balance = await balanceAsOf(db, account.id, on);
      const principalCents = balance?.amountCents ?? 0;
      const contributionPerMonthCents = transferByAccount.get(account.id)?.perMonthCents ?? 0;
      const annualGrowthRate = account.annualGrowthRate ?? 0;
      // Annual in, monthly out, through the engine — never a division by 12
      // (phases/09-goals-projections.md "/projections").
      const monthlyRate = periodRate(annualGrowthRate, "monthly");

      const series = Array.from({ length: months + 1 }, (_, month) => ({
        month,
        projectedCents: futureValueCents(principalCents, contributionPerMonthCents, monthlyRate, month),
      }));

      return {
        id: account.id,
        name: account.name,
        type: account.type,
        annualGrowthRate,
        monthlyRate,
        currentBalanceCents: principalCents,
        currentBalanceAsAt: balance?.asAt ?? null,
        contributionPerMonthCents,
        byHorizon: Object.fromEntries(
          horizons.map((h) => [h, futureValueCents(principalCents, contributionPerMonthCents, monthlyRate, h)]),
        ),
        series,
      };
    }),
  );

  const totalSeries = Array.from({ length: months + 1 }, (_, month) => ({
    month,
    projectedCents: sumCents(accounts.map((a) => mustAt(a.series, month, "projection point").projectedCents)),
  }));

  return {
    on,
    months,
    horizons,
    payCadence: context.payCadence,
    allocationPlan: allocation.plan ? { id: allocation.plan.id, name: allocation.plan.name } : null,
    accounts,
    totalSeries,
    warnings: allocation.warning ? [allocation.warning] : [],
  };
}

// The spreadsheet's own columns (phases/09-goals-projections.md
// "/projections").
const PROJECTION_HORIZONS = /** @type {const} */ ([6, 12, 18, 24, 36, 48, 60]);
