import {
  addDaysIso,
  computeAllocation,
  diffAllocations,
  equivalent,
  mustAt,
  mustGet,
  resolveVariant,
} from "@budget/engine";
import { allocationLines, allocationStageGoals, allocationVersions, appliedSnapshotSchema } from "@budget/schema";
import { and, desc, eq } from "drizzle-orm";
import { computeContribution, projectActiveBills } from "./bills.js";
import { todayIso } from "./dates.js";
import { computeVariantTotals, getPrimaryPaySchedule } from "./income.js";
import { summarizeVariableCosts } from "./variable-costs.js";

/** @import { AllocationLine, AllocationResult, Cadence, Cents, IsoDate, Transfer } from "@budget/engine" */
/** @import { AppliedSnapshot } from "@budget/schema" */

/**
 * @typedef {{
 *   id: string,
 *   versionId: string,
 *   stage: number,
 *   category: string | null,
 *   label: string,
 *   basis: AllocationLine["basis"],
 *   value: number | null,
 *   goalPct: number | null,
 *   accountId: string,
 *   sortOrder: number,
 * }} StoredAllocationLine An `allocation_lines` row as Drizzle returns it.
 *
 * `category` is still on the row and is deliberately never read — see the
 * column's own comment in packages/schema/src/tables/allocation.js. The three
 * fixed sections replaced it.
 */

/**
 * @typedef {{
 *   id: string,
 *   versionId: string,
 *   stage: number,
 *   goalPct: number,
 * }} StoredAllocationStageGoal An `allocation_stage_goals` row.
 */

/**
 * @typedef {{
 *   id: string,
 *   planId: string,
 *   version: number,
 *   status: "draft" | "active" | "archived",
 *   basedOnVersionId: string | null,
 *   note: string | null,
 *   createdBy: string | null,
 *   createdAt: Date,
 *   activatedAt: Date | null,
 *   appliedSnapshot?: unknown,
 * }} StoredAllocationVersion
 *
 * `appliedSnapshot` is raw jsonb — read it through `readAppliedSnapshot`,
 * never directly.
 */

// Four years, and the number is load-bearing. `billsContribution`
// annualises a window as `total * 365.25 / days`, which only divides exactly
// when the window is a whole multiple of 365.25 days — 1461 is the smallest
// one that is also a whole number of calendar years (four years always
// contain exactly one leap day). At 365 days the same call inflates every
// figure by 0.07%: harmless on the /costs/fixed insight screen, $2/month of
// invented cost here, where the output is a transfer amount typed into a
// bank. On a 1461-day window every month-based cadence lands on its exact
// conventional rate (a monthly bill 48 times, quarterly 16, yearly 4), so
// the fixed total the allocation deducts matches the sum of the bills'
// own monthly equivalents to the cent. No window does that for a weekly or
// fortnightly bill — 1461 days holds 104 or 105 fortnights depending on
// `on` — so the engine prices those at 52 or 26 a year instead of counting
// them, and the transfer no longer moves when nothing but the date has
// (`billsContribution`).
//
// It looks FORWARD from `on` rather than straddling it: money set aside now
// pays bills that haven't happened yet, so an escalating bill's future
// amount is the one to fund, and a past actual (which a straddling window
// would average in) is not. The trade-off is that a steeply escalating bill
// reads as its four-year average rather than today's amount — deliberately
// the conservative direction.
const FIXED_COST_WINDOW_DAYS = 1461;

/**
 * Everything `AllocationInput` needs except the plan's own gross and lines —
 * assembled from the phases that own each figure, never recomputed here
 * (phases/08-allocation.md "/allocation/compute": "It computes nothing
 * itself").
 *
 * `payCadence` falls back to monthly when no primary pay schedule is set,
 * with a warning, rather than failing the whole request: the per-month
 * figures are still true and the screen stays usable. Same convention as
 * income's "no primary pay schedule -> per-pay is null", except the engine
 * has no null cadence to hand it.
 *
 * @param {import("@budget/schema").Db} db
 * @param {IsoDate} on
 */
export async function loadAllocationContext(db, on) {
  const window = { from: on, to: addDaysIso(on, FIXED_COST_WINDOW_DAYS) };

  const [paySchedule, landingAccount, scheduleRows, variableSummary, projected] = await Promise.all([
    getPrimaryPaySchedule(db),
    db.query.accounts.findFirst({
      where: (a, { and: andCol, eq: eqCol, isNull: isNullCol }) =>
        andCol(eqCol(a.isIncomeLanding, true), isNullCol(a.archivedAt)),
    }),
    db.query.variantSchedule.findMany({}),
    summarizeVariableCosts(db, on),
    projectActiveBills(db, window),
  ]);

  /** @type {{ code: string, message: string }[]} */
  const warnings = [];
  if (!paySchedule) {
    warnings.push({
      code: "no_primary_pay_schedule",
      message: "No primary pay schedule is set — transfer amounts are shown per month, not per pay.",
    });
  }
  if (!landingAccount) {
    warnings.push({
      code: "no_income_landing_account",
      message: "No account is flagged as income landing — mark one in Accounts before allocating.",
    });
  }
  // Only the bill warnings that name a real problem with the data; a missing
  // pay schedule is already covered above, and variable-cost budget gaps
  // reach the operator on their own screen.
  warnings.push(...projected.warnings.map((w) => ({ code: w.code, message: w.message })));

  const resolution = resolveVariant(
    scheduleRows.map((row) => ({ variantId: row.variantId, startsOn: row.startsOn, endsOn: row.endsOn })),
    on,
  );

  const fixedContribution = computeContribution(projected.allInstances, window, paySchedule);

  return {
    on,
    window,
    paySchedule,
    payCadence: /** @type {Cadence} */ (paySchedule?.cadence ?? "monthly"),
    hasPrimaryPaySchedule: paySchedule !== null,
    incomeLandingAccountId: landingAccount?.id ?? null,
    fixedTotalPerMonthCents: fixedContribution.perMonthCents,
    // The same `computeContribution` call the monthly figure above comes from,
    // exposed rather than recomputed: the dashboard reports a per-pay bills
    // contribution and must show the cent /costs/fixed shows
    // (phases/10-dashboard.md "The dashboard computes nothing"). Null when no
    // primary pay schedule is set, the repo-wide convention for a per-pay
    // figure with no cadence to express it in.
    fixedTotalPerPayCents: fixedContribution.perPayCents,
    variableEssentialsPerMonthCents: variableSummary.essentialPerMonthCents,
    variableNonEssentialPerMonthCents: variableSummary.nonEssentialPerMonthCents,
    // Phase 07's whole summary, not just the two totals the engine deducts —
    // the dashboard reports the trailing average against budget, and a second
    // `summarizeVariableCosts` call for it would be four more queries for data
    // already in hand.
    variableSummary,
    resolvedVariantId: resolution.variantId,
    resolutionDiagnostics: resolution.diagnostics,
    warnings,
  };
}

/** @typedef {Awaited<ReturnType<typeof loadAllocationContext>>} AllocationContext */

/**
 * A variant's gross per month — phase 05's own totals helper, so the figure
 * matches what /income reports for the same variant to the cent.
 *
 * @param {import("@budget/schema").Db} db
 * @param {string} variantId
 * @returns {Promise<Cents>}
 */
export async function variantGrossPerMonthCents(db, variantId) {
  const lines = await db.query.incomeLines.findMany({
    where: (l, { eq: eqCol }) => eqCol(l.variantId, variantId),
  });
  return computeVariantTotals(lines, null).totalCents.perMonth;
}

/**
 * Stored rows -> the engine's pure `AllocationLine` shape, in evaluation
 * order (stage, then the operator's own ordering within it).
 *
 * @param {StoredAllocationLine[]} rows
 * @returns {AllocationLine[]}
 */
export function toEngineLines(rows) {
  return [...rows]
    .sort((a, b) => a.stage - b.stage || a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
    .map((row) => ({
      id: row.id,
      stage: row.stage,
      label: row.label,
      basis: row.basis,
      value: row.value,
      goalPct: row.goalPct,
      accountId: row.accountId,
    }));
}

/**
 * @param {StoredAllocationLine} row
 */
export function serializeLine(row) {
  return {
    id: row.id,
    versionId: row.versionId,
    stage: row.stage,
    label: row.label,
    basis: row.basis,
    value: row.value,
    goalPct: row.goalPct,
    accountId: row.accountId,
    sortOrder: row.sortOrder,
  };
}

/**
 * @param {StoredAllocationStageGoal} row
 */
export function serializeStageGoal(row) {
  return { stage: row.stage, goalPct: row.goalPct };
}

/**
 * Timestamps go out as ISO strings rather than `Date`s: the RPC client reads
 * these back off `res.json()`, where a Date has already become a string
 * anyway — sending one keeps the type honest about what actually arrives.
 *
 * @param {StoredAllocationVersion} version
 * @param {StoredAllocationLine[]} lineRows
 * @param {{ createdByName?: string | null, stageGoalRows?: StoredAllocationStageGoal[] }} [extra]
 */
export function serializeVersion(version, lineRows, extra = {}) {
  return {
    id: version.id,
    planId: version.planId,
    version: version.version,
    status: version.status,
    basedOnVersionId: version.basedOnVersionId,
    note: version.note,
    createdBy: version.createdBy,
    createdByName: extra.createdByName ?? null,
    createdAt: version.createdAt.toISOString(),
    activatedAt: version.activatedAt ? version.activatedAt.toISOString() : null,
    lines: lineRows.map(serializeLine),
    // Sent with the lines, always — the editor hydrates its section goals from
    // the same response it hydrates its rows from. Defaults to empty rather
    // than being omitted so a caller never has to distinguish "this version
    // has no section goals" from "this response didn't say".
    stageGoals: (extra.stageGoalRows ?? []).map(serializeStageGoal),
    // What the standing transfers were set to when this version was applied.
    // Null for a draft and for a version applied before amounts were
    // recorded — "not recorded", never a recomputation passed off as one.
    applied: readAppliedSnapshot(version),
  };
}

/**
 * The engine call, and the only place in `apps/api` that makes it. Returns
 * `AllocationResult` verbatim — no post-processing, no arithmetic of its own
 * (phases/08-allocation.md: "No allocation arithmetic exists outside
 * packages/engine").
 *
 * @param {AllocationContext} context
 * @param {Cents} grossPerMonthCents
 * @param {StoredAllocationLine[]} lineRows
 * @param {StoredAllocationStageGoal[]} [stageGoalRows]
 * @returns {AllocationResult}
 */
export function computeVersionAllocation(context, grossPerMonthCents, lineRows, stageGoalRows = []) {
  return computeAllocation({
    grossPerMonthCents,
    payCadence: context.payCadence,
    fixedTotalPerMonthCents: context.fixedTotalPerMonthCents,
    variableEssentialsPerMonthCents: context.variableEssentialsPerMonthCents,
    variableNonEssentialPerMonthCents: context.variableNonEssentialPerMonthCents,
    // Guarded by the caller, which refuses the request when no account is
    // flagged — an empty string here would silently invent a destination.
    incomeLandingAccountId: /** @type {string} */ (context.incomeLandingAccountId),
    lines: toEngineLines(lineRows),
    stageGoals: stageGoalRows.map(serializeStageGoal),
  });
}

/**
 * The assembled inputs, echoed back so the screen can state what the
 * numbers were computed from — and assert the transfer total against gross
 * — without a second round trip or a conversion of its own.
 *
 * @param {AllocationContext} context
 * @param {Cents} grossPerMonthCents
 */
export function serializeInputs(context, grossPerMonthCents) {
  return {
    on: context.on,
    payCadence: context.payCadence,
    hasPrimaryPaySchedule: context.hasPrimaryPaySchedule,
    grossPerMonthCents,
    grossPerPayCents: equivalent(grossPerMonthCents, "monthly", context.payCadence),
    fixedTotalPerMonthCents: context.fixedTotalPerMonthCents,
    variableEssentialsPerMonthCents: context.variableEssentialsPerMonthCents,
    variableNonEssentialPerMonthCents: context.variableNonEssentialPerMonthCents,
    incomeLandingAccountId: context.incomeLandingAccountId,
    resolvedVariantId: context.resolvedVariantId,
    resolutionDiagnostics: context.resolutionDiagnostics,
    fixedCostWindow: context.window,
  };
}

const BASES_NEEDING_VALUE = /** @type {const} */ ([
  "pct_of_gross",
  "pct_of_remaining",
  "fixed_amount",
  "sweep",
]);

const INJECTED_BASES = /** @type {const} */ (["from_fixed_costs", "from_variable_essentials"]);

/** @param {AllocationLine["basis"]} basis */
export function isInjectedBasis(basis) {
  return /** @type {readonly string[]} */ (INJECTED_BASES).includes(basis);
}

/**
 * Whether a line's `value` is required, and what it must look like, depends
 * on its `basis` — a semantic rule rather than a shape rule, so it lives
 * here rather than in Zod (same split as bills' `amountModelFieldError`).
 *
 * @param {{ label: string, basis: AllocationLine["basis"], value: number | null }} line
 */
export function basisValueError(line) {
  if (isInjectedBasis(line.basis)) return null;

  if (/** @type {readonly string[]} */ (BASES_NEEDING_VALUE).includes(line.basis) && line.value === null) {
    return `"${line.label}" needs a value.`;
  }
  if (
    (line.basis === "pct_of_gross" || line.basis === "pct_of_remaining") &&
    line.value !== null &&
    line.value > 100
  ) {
    return `"${line.label}" is a percentage — 100 is the most it can be.`;
  }
  if (line.basis === "fixed_amount" && line.value !== null && !Number.isInteger(line.value)) {
    return `"${line.label}" is a fixed amount in whole cents.`;
  }
  return null;
}

/**
 * Two lines drawing from the same injected total would deduct it twice —
 * the fixed-cost total is the WHOLE total on every line that draws it, not a
 * share — and the operator would see a phantom shortfall with no
 * explanation. Structurally wrong data, so it's refused on write rather
 * than surfaced as a warning.
 *
 * @param {{ label: string, basis: AllocationLine["basis"] }[]} lines
 */
export function duplicateInjectedBasisError(lines) {
  for (const basis of INJECTED_BASES) {
    const matching = lines.filter((l) => l.basis === basis);
    if (matching.length > 1) {
      const what = basis === "from_fixed_costs" ? "fixed costs" : "variable essentials";
      return `Only one line can draw from ${what} — it's the whole total, not a share. Remove one of ${matching.map((l) => `"${l.label}"`).join(", ")}.`;
    }
  }
  return null;
}
/**
 * The household's ACTIVE allocation for `on` — the active version of the plan
 * whose income variant the schedule resolves for that date. Phase 09's goal
 * contributions and projections both hang off it: an account's contribution is
 * that allocation's transfer to it, and nothing else.
 *
 * Never guesses which plan applies. If the schedule resolves to a variant no
 * active plan divides, or resolves to nothing at all while several plans are
 * active, this returns no allocation and a warning saying so — contributions
 * then read as zero, which is honest, where picking a plan by name order would
 * quietly attribute money to the wrong destinations (phases/README.md "The one
 * rule": conflicts are surfaced, not resolved). One active plan and no
 * resolution is not a conflict — there is only one answer, so it is used.
 *
 * @param {import("@budget/schema").Db} db
 * @param {AllocationContext} context
 */
export async function resolveActiveAllocation(db, context) {
  const [plans, activeVersions] = await Promise.all([
    db.query.allocationPlans.findMany({ where: (p, { isNull: isNullCol }) => isNullCol(p.archivedAt) }),
    db.query.allocationVersions.findMany({ where: (v, { eq: eqCol }) => eqCol(v.status, "active") }),
  ]);

  const activeByPlan = new Map(activeVersions.map((v) => [v.planId, v]));
  const candidates = plans.filter((p) => activeByPlan.has(p.id));

  /** @type {{ plan: null, version: null, result: null, grossPerMonthCents: Cents, warning: { code: string, message: string } }} */
  const none = {
    plan: null,
    version: null,
    result: null,
    grossPerMonthCents: 0,
    warning: {
      code: "no_active_allocation",
      message: "No allocation plan has an active version yet — contributions to goals show as zero until one is applied.",
    },
  };

  if (candidates.length === 0) return none;

  let plan = context.resolvedVariantId
    ? candidates.find((p) => p.incomeVariantId === context.resolvedVariantId) ?? null
    : null;

  if (!plan) {
    if (candidates.length === 1) {
      plan = mustAt(candidates, 0, "active allocation plan");
    } else {
      return {
        ...none,
        warning: {
          code: "ambiguous_active_allocation",
          message: context.resolvedVariantId
            ? `On ${context.on} the income schedule resolves to a variant no active allocation plan divides. Contributions show as zero rather than being attributed to a plan that may not apply — apply a plan for that variant on Allocation.`
            : `${candidates.length} allocation plans are active and the income schedule doesn't say which applies on ${context.on}. Contributions show as zero rather than being guessed — add a schedule entry on Income to say which variant is running.`,
        },
      };
    }
  }

  const version = mustGet(activeByPlan, plan.id, "active allocation version");
  const [lineRows, stageGoalRows, grossPerMonthCents] = await Promise.all([
    linesForVersion(db, version.id),
    stageGoalsForVersion(db, version.id),
    variantGrossPerMonthCents(db, plan.incomeVariantId),
  ]);

  return {
    plan,
    version,
    // Without an income-landing account the engine has no destination for
    // money nobody allocated, so there is nothing to compute — the same guard
    // /allocation/compute makes, minus the 400: goals are still readable.
    result: context.incomeLandingAccountId
      ? computeVersionAllocation(context, grossPerMonthCents, lineRows, stageGoalRows)
      : null,
    grossPerMonthCents,
    /** @type {{ code: string, message: string } | null} */
    warning: context.incomeLandingAccountId
      ? null
      : {
          code: "no_income_landing_account",
          message: "Mark an account as income landing in Accounts to see what each goal is currently funded by.",
        },
  };
}

// ---------------------------------------------------------------------------
// Version lifecycle. Draft creation lives here rather than in a route file
// because three endpoints need exactly the same copy-on-write —
// POST /allocation-plans/:id/draft, POST /allocation-versions/:id/revert, and
// creating a plan — and a second, subtly different copy of it is how a
// "reverted" draft quietly loses a line's goal.
// ---------------------------------------------------------------------------

/**
 * @param {import("@budget/schema").Db | import("@budget/schema").Tx} db
 * @param {string} versionId
 */
export async function linesForVersion(db, versionId) {
  return db.query.allocationLines.findMany({
    where: (l, { eq: eqCol }) => eqCol(l.versionId, versionId),
    orderBy: (l, { asc }) => [asc(l.stage), asc(l.sortOrder)],
  });
}

/**
 * A version's section goals. Loaded everywhere the lines are — the two are one
 * plan, and a compute that had the lines but not the goals would report a
 * section as having no target the operator can plainly see they set.
 *
 * @param {import("@budget/schema").Db | import("@budget/schema").Tx} db
 * @param {string} versionId
 */
export async function stageGoalsForVersion(db, versionId) {
  return db.query.allocationStageGoals.findMany({
    where: (g, { eq: eqCol }) => eqCol(g.versionId, versionId),
    orderBy: (g, { asc }) => [asc(g.stage)],
  });
}

/**
 * `serializeVersion` with both halves of a version fetched for you. Every
 * route that returns a version goes through this rather than fetching the
 * lines alone — one place to forget the section goals is one place too many,
 * and a response missing them silently empties the editor's goal fields.
 *
 * @param {import("@budget/schema").Db | import("@budget/schema").Tx} db
 * @param {StoredAllocationVersion} version
 * @param {{ createdByName?: string | null }} [extra]
 */
export async function serializeVersionById(db, version, extra = {}) {
  const [lineRows, stageGoalRows] = await Promise.all([
    linesForVersion(db, version.id),
    stageGoalsForVersion(db, version.id),
  ]);
  return serializeVersion(version, lineRows, { ...extra, stageGoalRows });
}

/**
 * @param {import("@budget/schema").Db | import("@budget/schema").Tx} db
 * @param {string} planId
 * @param {"draft" | "active"} status
 */
export async function findVersionByStatus(db, planId, status) {
  return (
    (await db.query.allocationVersions.findFirst({
      where: (v, { and: andCol, eq: eqCol }) => andCol(eqCol(v.planId, planId), eqCol(v.status, status)),
    })) ?? null
  );
}

/**
 * The newest version by number, whatever its status — what a plan whose
 * active version has been archived out from under it should seed its next
 * draft from.
 *
 * @param {import("@budget/schema").Db | import("@budget/schema").Tx} db
 * @param {string} planId
 */
export async function findNewestVersion(db, planId) {
  return (
    (await db.query.allocationVersions.findFirst({
      where: (v, { eq: eqCol }) => eqCol(v.planId, planId),
      orderBy: (v, { desc: descCol }) => [descCol(v.version)],
    })) ?? null
  );
}

/**
 * Copy-on-write: a new `draft` version of `planId`, its lines copied from
 * `source` (a brand-new plan passes null and gets an empty draft). Runs in one
 * transaction so a failure part-way never leaves a draft holding half a plan.
 *
 * @param {import("@budget/schema").Db} db
 * @param {{ planId: string, source: StoredAllocationVersion | null, createdBy: string | null, note?: string | null }} args
 */
export async function createDraftVersion(db, { planId, source, createdBy, note = null }) {
  const sourceLines = source ? await linesForVersion(db, source.id) : [];
  const sourceStageGoals = source ? await stageGoalsForVersion(db, source.id) : [];

  return db.transaction(async (tx) => {
    const newest = await findNewestVersion(tx, planId);
    const created = await tx
      .insert(allocationVersions)
      .values({
        planId,
        version: (newest?.version ?? 0) + 1,
        status: "draft",
        basedOnVersionId: source?.id ?? null,
        note,
        createdBy,
      })
      .returning();
    const draft = mustAt(created, 0, "created draft version");

    if (sourceLines.length > 0) {
      await tx.insert(allocationLines).values(
        sourceLines.map((line) => ({
          versionId: draft.id,
          stage: line.stage,
          label: line.label,
          basis: line.basis,
          value: line.value,
          goalPct: line.goalPct,
          accountId: line.accountId,
          sortOrder: line.sortOrder,
        })),
      );
    }

    // Copied with the lines and in the same transaction, for the reason at the
    // top of this section: a draft that silently lost its section goals is the
    // same class of bug as one that lost a line's goal.
    if (sourceStageGoals.length > 0) {
      await tx.insert(allocationStageGoals).values(
        sourceStageGoals.map((goal) => ({
          versionId: draft.id,
          stage: goal.stage,
          goalPct: goal.goalPct,
        })),
      );
    }

    return draft;
  });
}

/**
 * Draft -> active, previous active -> archived, in one transaction. The
 * archive has to land before the promotion or the partial unique index on
 * `status = 'active'` rejects the second statement — which is the index
 * doing its job.
 *
 * `appliedSnapshot` is written in the same statement as the promotion, so a
 * version can never be active with the amounts of some other moment — or
 * have amounts recorded and fail to become active. Null when nothing could
 * be resolved (see `resolveAppliedSnapshot`); the version is still applied,
 * since applying is the operator's decision, not the engine's.
 *
 * @param {import("@budget/schema").Db} db
 * @param {{ draft: StoredAllocationVersion, active: StoredAllocationVersion | null, note?: string | null, appliedSnapshot?: AppliedSnapshot | null }} args
 */
export async function applyDraftVersion(db, { draft, active, note, appliedSnapshot = null }) {
  return db.transaction(async (tx) => {
    if (active) {
      await tx
        .update(allocationVersions)
        .set({ status: "archived" })
        .where(and(eq(allocationVersions.id, active.id), eq(allocationVersions.status, "active")));
    }
    const updated = await tx
      .update(allocationVersions)
      .set({
        status: "active",
        activatedAt: new Date(),
        // An empty note in the confirmation dialog leaves whatever the draft
        // already carried (e.g. "Reverted from v3") rather than blanking it.
        note: note === undefined || note === null ? draft.note : note,
        appliedSnapshot,
      })
      .where(eq(allocationVersions.id, draft.id))
      .returning();
    return mustAt(updated, 0, "applied version");
  });
}

// ---------------------------------------------------------------------------
// Applied amounts. A version stores rules (basis + value), and every figure
// they resolve to moves when a bill, a budget or an income line does. The
// bank does not: a standing order says what it said on the day it was typed
// in. So the amounts are recorded at apply, and everything that reports "what
// the bank is doing" reads them back rather than recomputing.
//
// Nothing here ever writes a new figure into a recorded one. Drift is shown,
// and re-applying the plan is the only way to record new amounts — there is
// no "mark the bank as updated", because the app is not a todo list
// (phases/08-allocation.md "What transfers are, and are not").
// ---------------------------------------------------------------------------

/**
 * The amounts stored on a version at apply, or null when there are none: a
 * draft, a version applied before amounts were recorded, or a row whose jsonb
 * does not parse. All three read the same way — "not recorded".
 *
 * @param {{ appliedSnapshot?: unknown }} version
 * @returns {AppliedSnapshot | null}
 */
export function readAppliedSnapshot(version) {
  if (version.appliedSnapshot == null) return null;
  const parsed = appliedSnapshotSchema.safeParse(version.appliedSnapshot);
  return parsed.success ? parsed.data : null;
}

/**
 * What to record when `version` is applied: its transfers resolved exactly
 * the way the preview the operator just read resolved them — same context,
 * same gross, same engine call — for the date that preview was computed for.
 *
 * Null without an income-landing account. The engine has no destination for
 * unallocated money without one, so there is nothing true to record; the
 * version still applies, and reads as "not recorded" until it is re-applied.
 *
 * @param {import("@budget/schema").Db} db
 * @param {{ plan: { incomeVariantId: string }, version: StoredAllocationVersion, on: IsoDate }} args
 * @returns {Promise<AppliedSnapshot | null>}
 */
export async function resolveAppliedSnapshot(db, { plan, version, on }) {
  const context = await loadAllocationContext(db, on);
  if (!context.incomeLandingAccountId) return null;

  const [lineRows, stageGoalRows, grossPerMonthCents] = await Promise.all([
    linesForVersion(db, version.id),
    stageGoalsForVersion(db, version.id),
    variantGrossPerMonthCents(db, plan.incomeVariantId),
  ]);
  const result = computeVersionAllocation(context, grossPerMonthCents, lineRows, stageGoalRows);

  const accountIds = result.transfers.map((t) => t.accountId);
  const accounts =
    accountIds.length > 0
      ? await db.query.accounts.findMany({ where: (a, { inArray }) => inArray(a.id, accountIds) })
      : [];
  // Lines reference accounts by foreign key and accounts are only ever
  // archived, so every destination resolves to a row.
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));

  return {
    version: 1,
    payCadence: context.payCadence,
    hasPrimaryPaySchedule: context.hasPrimaryPaySchedule,
    computedOn: on,
    appliedOn: todayIso(),
    grossPerMonthCents,
    transfers: result.transfers.map((t) => ({
      accountId: t.accountId,
      accountName: mustGet(nameById, t.accountId, "transfer destination"),
      perPayCents: t.perPayCents,
      perMonthCents: t.perMonthCents,
      isNoOp: t.isNoOp,
    })),
  };
}

/**
 * The recorded transfers in the engine's own `AllocationResult` shape, so the
 * comparison below is `diffAllocations` — the engine's function — rather than
 * a subtraction written here. `diffAllocations` reads `transfers` and nothing
 * else, so the rest of `live` rides along untouched, and `lineIds` is empty
 * because the record never needed to say which lines fed each transfer.
 *
 * @param {AppliedSnapshot} snapshot
 * @param {AllocationResult} live
 * @returns {AllocationResult}
 */
function appliedAsResult(snapshot, live) {
  /** @type {Transfer[]} */
  const transfers = snapshot.transfers.map((t) => ({
    accountId: t.accountId,
    perMonthCents: t.perMonthCents,
    perPayCents: t.perPayCents,
    lineIds: [],
    isNoOp: t.isNoOp,
  }));
  return { ...live, transfers };
}

/**
 * @typedef {{
 *   status: "recorded" | "not_recorded" | "cadence_changed",
 *   snapshot: AppliedSnapshot | null,
 *   drift: import("@budget/engine").TransferDelta[] | null,
 * }} AppliedComparison
 *
 * - `drift` — per destination, `toPerPayCents` is live and `fromPerPayCents`
 *   is applied, so `deltaPerPayCents` is live − applied. Null unless
 *   `status` is "recorded".
 * - `"cadence_changed"` — the primary pay schedule's cadence is not the one
 *   the amounts were recorded in. Deliberately not converted: what the bank
 *   holds is a fortnightly order, and a monthly figure derived from it is a
 *   number nobody typed anywhere. The plan needs re-applying.
 */

/**
 * The live result beside the amounts recorded at apply.
 *
 * @param {AppliedSnapshot | null} snapshot
 * @param {AllocationResult} live
 * @param {Cadence} payCadence the cadence `live` was computed in
 * @returns {AppliedComparison}
 */
export function compareWithApplied(snapshot, live, payCadence) {
  if (!snapshot) return { status: "not_recorded", snapshot: null, drift: null };
  if (snapshot.payCadence !== payCadence) return { status: "cadence_changed", snapshot, drift: null };
  return { status: "recorded", snapshot, drift: diffAllocations(appliedAsResult(snapshot, live), live) };
}

/**
 * @typedef {{
 *   accountId: string,
 *   accountName: string | null,
 *   perPayCents: Cents,
 *   perMonthCents: Cents,
 *   isNoOp: boolean,
 * }} CurrentTransfer
 *
 * `accountName` is the name recorded at apply, or null for a recomputed row
 * (the screen already holds the live names).
 */

/**
 * @typedef {{
 *   source: "applied" | "recomputed",
 *   reason: "not_recorded" | "cadence_changed" | null,
 *   applied: AppliedSnapshot | null,
 *   transfers: CurrentTransfer[],
 *   drift: import("@budget/engine").TransferDelta[] | null,
 * }} CurrentTransfers
 *
 * - `reason` — why `source` is "recomputed": the version was applied before
 *   amounts were recorded, or the pay cadence has changed since. Null when
 *   `source` is "applied".
 * - `drift` — live − applied for the active version itself, so the screen can
 *   say a standing order has gone stale without anyone opening a draft. Null
 *   unless `source` is "applied".
 */

/**
 * What the preview's "Current" column is: the amounts recorded when the
 * active version was applied — what is actually at the bank — whenever they
 * exist and are in today's cadence; otherwise today's recomputation of the
 * active version, with `reason` saying why. Diffing a draft against the
 * recorded amounts is what makes "apply an unchanged draft after a bill
 * moved" show exactly which standing orders to edit, which is the flow phase
 * 08 sanctions for it.
 *
 * `baseline` is the same choice in `AllocationResult` shape, for
 * `diffAllocations`.
 *
 * @param {StoredAllocationVersion} activeVersion
 * @param {AllocationResult} recomputed
 * @param {Cadence} payCadence
 * @returns {{ current: CurrentTransfers, baseline: AllocationResult }}
 */
export function resolveCurrentTransfers(activeVersion, recomputed, payCadence) {
  const comparison = compareWithApplied(readAppliedSnapshot(activeVersion), recomputed, payCadence);

  if (comparison.status === "recorded" && comparison.snapshot) {
    const snapshot = comparison.snapshot;
    return {
      current: { source: "applied", reason: null, applied: snapshot, transfers: snapshot.transfers, drift: comparison.drift },
      baseline: appliedAsResult(snapshot, recomputed),
    };
  }

  return {
    current: {
      source: "recomputed",
      reason: comparison.status === "cadence_changed" ? "cadence_changed" : "not_recorded",
      applied: comparison.snapshot,
      transfers: recomputed.transfers.map((t) => ({
        accountId: t.accountId,
        accountName: null,
        perPayCents: t.perPayCents,
        perMonthCents: t.perMonthCents,
        isNoOp: t.isNoOp,
      })),
      drift: null,
    },
    baseline: recomputed,
  };
}

/**
 * Newest first — the shape the version timeline renders.
 *
 * @param {import("@budget/schema").Db} db
 * @param {string} planId
 */
export async function versionsForPlan(db, planId) {
  return db
    .select()
    .from(allocationVersions)
    .where(eq(allocationVersions.planId, planId))
    .orderBy(desc(allocationVersions.version));
}
