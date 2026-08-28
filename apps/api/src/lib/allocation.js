import { addDaysIso, computeAllocation, equivalent, mustAt, mustGet, resolveVariant } from "@budget/engine";
import { allocationLines, allocationVersions } from "@budget/schema";
import { and, desc, eq } from "drizzle-orm";
import { computeContribution, projectActiveBills } from "./bills.js";
import { computeVariantTotals, getPrimaryPaySchedule } from "./income.js";
import { summarizeVariableCosts } from "./variable-costs.js";

/** @import { AllocationLine, AllocationResult, Cadence, Cents, IsoDate } from "@budget/engine" */

/**
 * @typedef {{
 *   id: string,
 *   versionId: string,
 *   stage: number,
 *   label: string,
 *   basis: AllocationLine["basis"],
 *   value: number | null,
 *   goalPct: number | null,
 *   accountId: string,
 *   sortOrder: number,
 * }} StoredAllocationLine An `allocation_lines` row as Drizzle returns it.
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
 * }} StoredAllocationVersion
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
// own monthly equivalents to the cent.
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
 * Timestamps go out as ISO strings rather than `Date`s: the RPC client reads
 * these back off `res.json()`, where a Date has already become a string
 * anyway — sending one keeps the type honest about what actually arrives.
 *
 * @param {StoredAllocationVersion} version
 * @param {StoredAllocationLine[]} lineRows
 * @param {{ createdByName?: string | null }} [extra]
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
 * @returns {AllocationResult}
 */
export function computeVersionAllocation(context, grossPerMonthCents, lineRows) {
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
  const [lineRows, grossPerMonthCents] = await Promise.all([
    linesForVersion(db, version.id),
    variantGrossPerMonthCents(db, plan.incomeVariantId),
  ]);

  return {
    plan,
    version,
    // Without an income-landing account the engine has no destination for
    // money nobody allocated, so there is nothing to compute — the same guard
    // /allocation/compute makes, minus the 400: goals are still readable.
    result: context.incomeLandingAccountId ? computeVersionAllocation(context, grossPerMonthCents, lineRows) : null,
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

    return draft;
  });
}

/**
 * Draft -> active, previous active -> archived, in one transaction. The
 * archive has to land before the promotion or the partial unique index on
 * `status = 'active'` rejects the second statement — which is the index
 * doing its job.
 *
 * @param {import("@budget/schema").Db} db
 * @param {{ draft: StoredAllocationVersion, active: StoredAllocationVersion | null, note?: string | null }} args
 */
export async function applyDraftVersion(db, { draft, active, note }) {
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
      })
      .where(eq(allocationVersions.id, draft.id))
      .returning();
    return mustAt(updated, 0, "applied version");
  });
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
