import { divideCents, pctOfCents } from "./money.js";
import { equivalent } from "./cadence.js";
import { mustAt, mustGet } from "./invariant.js";

/** @import { Cents } from "./money.js" */
/** @import { Cadence } from "./cadence.js" */

/**
 * @typedef {"from_fixed_costs"
 *   | "from_variable_essentials"
 *   | "pct_of_gross"
 *   | "pct_of_remaining"
 *   | "fixed_amount"
 *   | "sweep"} Basis
 *
 * - `from_fixed_costs` — value ignored; injected from input
 * - `from_variable_essentials` — value ignored; injected from input
 * - `pct_of_gross` — value = percentage of gross
 * - `pct_of_remaining` — value = percentage of remaining at this stage's start
 * - `fixed_amount` — value = cents
 * - `sweep` — value = relative weight; splits all remaining at stage start
 */

/**
 * @typedef {object} AllocationLine
 * @property {string} id
 * @property {number} stage 1..N, evaluated in ascending order
 * @property {string} label
 * @property {Basis} basis
 * @property {number | null} value
 * @property {number | null} goalPct
 * @property {string} accountId
 */

/**
 * @typedef {object} AllocationInput
 * @property {Cents} grossPerMonthCents
 * @property {Cadence} payCadence cadence transfers are expressed in
 * @property {Cents} fixedTotalPerMonthCents
 * @property {Cents} variableEssentialsPerMonthCents
 * @property {Cents} variableNonEssentialPerMonthCents benchmark only — NEVER deducted
 * @property {string} incomeLandingAccountId
 * @property {AllocationLine[]} lines
 */

/**
 * @typedef {object} ResolvedLine
 * @property {string} lineId
 * @property {Cents} perMonthCents
 * @property {Cents} perPayCents
 * @property {Cents} perWeekCents
 * @property {number | null} actualPct of gross
 * @property {number | null} fidelity (actualPct - goalPct) / goalPct
 */

/**
 * @typedef {object} StageResult
 * @property {number} stage
 * @property {Cents} subtotalPerMonthCents
 * @property {Cents} remainingPerMonthCents
 * @property {number | null} goalPct
 * @property {number | null} actualPct
 * @property {number | null} fidelity
 */

/**
 * @typedef {object} Transfer
 * @property {string} accountId
 * @property {Cents} perMonthCents
 * @property {Cents} perPayCents
 * @property {string[]} lineIds
 * @property {boolean} isNoOp true for incomeLandingAccountId — money that stays put
 */

/**
 * @typedef {object} AllocationResult
 * @property {ResolvedLine[]} lines
 * @property {StageResult[]} stages
 * @property {Transfer[]} transfers
 * @property {Cents} unallocatedPerMonthCents
 * @property {Cents} goodLifeFidelityCents nonEssential − final remaining; positive = short of aspiration
 */

/**
 * Resolves every line in one stage into a `lineId -> perMonthCents` map.
 *
 * `pct_of_gross` and `pct_of_remaining` lines are resolved as a GROUP against
 * their shared base (gross, or remaining-at-stage-start), not independently:
 * the group's combined amount is computed once (`pctOfCents(base, sum of
 * their percentages)`) and then `divideCents` apportions that exact amount
 * across the group's lines by percentage weight. Rounding each line
 * independently would let the stage's total drift a cent or two away from
 * the base whenever the percentages are meant to add up to something exact
 * (a final stage summing its lines to 100% of remaining, for instance) —
 * exactly the "don't hope the rounding cancels" trap the cadence-conversion
 * invariant also guards against. Grouping makes that drift structurally
 * impossible: when percentages sum to 100, the group's target is the base
 * itself, computed with zero rounding at all.
 *
 * @param {AllocationLine[]} stageLines
 * @param {AllocationInput} input
 * @param {Cents} remainingAtStageStart
 * @returns {Map<string, Cents>}
 */
function resolveStageLineAmounts(stageLines, input, remainingAtStageStart) {
  /** @type {Map<string, Cents>} */
  const amounts = new Map();

  /** @type {Record<Exclude<Basis, "pct_of_gross" | "pct_of_remaining" | "sweep">, Cents>} */
  const directBases = {
    from_fixed_costs: input.fixedTotalPerMonthCents,
    from_variable_essentials: input.variableEssentialsPerMonthCents,
    fixed_amount: 0, // per-line value, handled below
  };

  for (const line of stageLines) {
    if (
      line.basis === "from_fixed_costs" ||
      line.basis === "from_variable_essentials"
    ) {
      amounts.set(line.id, directBases[line.basis]);
    } else if (line.basis === "fixed_amount") {
      amounts.set(line.id, line.value ?? 0);
    }
  }

  /**
   * @param {"pct_of_gross" | "pct_of_remaining"} basis
   * @param {Cents} base
   */
  const applyPercentGroup = (basis, base) => {
    const group = stageLines.filter((l) => l.basis === basis);
    if (group.length === 0) return;
    const values = group.map((l) => l.value ?? 0);
    const groupTotal = pctOfCents(
      base,
      values.reduce((a, b) => a + b, 0),
    );
    const shares = divideCents(groupTotal, values);
    group.forEach((l, i) => amounts.set(l.id, mustAt(shares, i, "share")));
  };

  applyPercentGroup("pct_of_gross", input.grossPerMonthCents);
  applyPercentGroup("pct_of_remaining", remainingAtStageStart);

  const sweepLines = stageLines.filter((l) => l.basis === "sweep");
  if (sweepLines.length > 0) {
    const weights = sweepLines.map((l) => l.value ?? 0);
    const shares = divideCents(remainingAtStageStart, weights);
    sweepLines.forEach((l, i) =>
      amounts.set(l.id, mustAt(shares, i, "sweep share")),
    );
  }

  return amounts;
}

/**
 * @param {Cents} amountCents
 * @param {Cents} grossPerMonthCents
 * @returns {number | null}
 */
function pctOfGross(amountCents, grossPerMonthCents) {
  if (grossPerMonthCents === 0) return null;
  return (amountCents / grossPerMonthCents) * 100;
}

/**
 * @param {number | null} actualPct
 * @param {number | null} goalPct
 * @returns {number | null}
 */
function fidelityOf(actualPct, goalPct) {
  if (actualPct === null || goalPct === null || goalPct === 0) return null;
  return (actualPct - goalPct) / goalPct;
}

/**
 * Resolves every allocation line, stage by stage, into concrete transfers.
 *
 * Stages ascend. Within a stage, every line resolves against the *same*
 * snapshot of remaining taken at stage entry — never a running balance
 * updated line by line, which would make results depend on row order. At the
 * end of each stage, remaining is reduced by that stage's subtotal.
 *
 * Transfers are grouped by `accountId` over resolved lines; one account may
 * be fed by several lines across different stages. `sum(transfers.perPayCents)`
 * reconciles EXACTLY to the pay-period-equivalent gross: monthly amounts are
 * computed per account first, then `divideCents` apportions the exact
 * pay-period gross across accounts by those monthly weights — never each
 * account's own `equivalent()` conversion independently, which would let
 * per-account rounding drift off the true total.
 *
 * @param {AllocationInput} input
 * @returns {AllocationResult}
 */
export function computeAllocation(input) {
  const gross = input.grossPerMonthCents;
  const stageNumbers = Array.from(
    new Set(input.lines.map((l) => l.stage)),
  ).sort((a, b) => a - b);

  let remaining = gross;
  let lastStageRemainingAtStart = gross;
  /** @type {Map<string, ResolvedLine>} */
  const resolvedByLineId = new Map();
  /** @type {StageResult[]} */
  const stages = [];

  for (const stageNum of stageNumbers) {
    const stageLines = input.lines.filter((l) => l.stage === stageNum);
    const remainingAtStart = remaining;
    lastStageRemainingAtStart = remainingAtStart;

    const stageAmounts = resolveStageLineAmounts(
      stageLines,
      input,
      remainingAtStart,
    );

    let subtotal = 0;
    for (const line of stageLines) {
      const perMonthCents = mustGet(stageAmounts, line.id, "stage amount");
      subtotal = subtotal + perMonthCents;

      const actualPct = pctOfGross(perMonthCents, gross);
      resolvedByLineId.set(line.id, {
        lineId: line.id,
        perMonthCents,
        perPayCents: equivalent(perMonthCents, "monthly", input.payCadence),
        perWeekCents: equivalent(perMonthCents, "monthly", "weekly"),
        actualPct,
        fidelity: fidelityOf(actualPct, line.goalPct),
      });
    }

    remaining = remaining - subtotal;

    // Stage-level goal is the sum of its lines' own goals — null when none
    // of the stage's lines carry one, rather than fabricating a target the
    // operator never entered.
    const goalValues = stageLines
      .map((l) => l.goalPct)
      .filter((g) => g !== null);
    const stageGoalPct =
      goalValues.length > 0 ? goalValues.reduce((a, b) => a + b, 0) : null;
    const stageActualPct = pctOfGross(subtotal, gross);

    stages.push({
      stage: stageNum,
      subtotalPerMonthCents: subtotal,
      remainingPerMonthCents: remaining,
      goalPct: stageGoalPct,
      actualPct: stageActualPct,
      fidelity: fidelityOf(stageActualPct, stageGoalPct),
    });
  }

  // Group by destination account.
  /** @type {string[]} */
  const accountOrder = [];
  /** @type {Map<string, Cents>} */
  const accountMonthly = new Map();
  /** @type {Map<string, string[]>} */
  const accountLineIds = new Map();
  /** @param {string} accountId */
  const touchAccount = (accountId) => {
    if (!accountMonthly.has(accountId)) {
      accountOrder.push(accountId);
      accountMonthly.set(accountId, 0);
      accountLineIds.set(accountId, []);
    }
  };
  for (const line of input.lines) {
    const resolved = mustGet(resolvedByLineId, line.id, "resolved line");
    touchAccount(line.accountId);
    accountMonthly.set(
      line.accountId,
      mustGet(accountMonthly, line.accountId, "account total") +
        resolved.perMonthCents,
    );
    mustGet(accountLineIds, line.accountId, "account line ids").push(line.id);
  }

  // Money nobody explicitly allocated simply stays where the salary landed —
  // nothing moved it. Folding it into the landing account here (rather than
  // dropping it) is what makes the reconciliation invariant below hold
  // unconditionally, not just when every stage's lines happen to sum to
  // 100% of remaining.
  touchAccount(input.incomeLandingAccountId);
  accountMonthly.set(
    input.incomeLandingAccountId,
    mustGet(accountMonthly, input.incomeLandingAccountId, "landing account") +
      remaining,
  );

  const grossPerPay = equivalent(gross, "monthly", input.payCadence);
  const weights = accountOrder.map((id) =>
    mustGet(accountMonthly, id, "account total"),
  );
  const perPayShares = divideCents(grossPerPay, weights);

  /** @type {Transfer[]} */
  const transfers = accountOrder.map((accountId, i) => ({
    accountId,
    perMonthCents: mustGet(accountMonthly, accountId, "account total"),
    perPayCents: mustAt(perPayShares, i, "per-pay share"),
    lineIds: mustGet(accountLineIds, accountId, "account line ids"),
    isNoOp: accountId === input.incomeLandingAccountId,
  }));

  const goodLifeFidelityCents =
    input.variableNonEssentialPerMonthCents - lastStageRemainingAtStart;

  return {
    lines: input.lines.map((l) =>
      mustGet(resolvedByLineId, l.id, "resolved line"),
    ),
    stages,
    transfers,
    unallocatedPerMonthCents: remaining,
    goodLifeFidelityCents,
  };
}

/**
 * @typedef {object} TransferDelta
 * @property {string} accountId
 * @property {Cents | null} fromPerPayCents null = new destination
 * @property {Cents | null} toPerPayCents null = destination removed
 * @property {Cents} deltaPerPayCents
 */

/** Compares two allocation results' transfers, account by account — used to
 * show the operator exactly what a draft change would move before they
 * commit to it.
 *
 * @param {AllocationResult} active
 * @param {AllocationResult} draft
 * @returns {TransferDelta[]}
 */
export function diffAllocations(active, draft) {
  const accountIds = new Set([
    ...active.transfers.map((t) => t.accountId),
    ...draft.transfers.map((t) => t.accountId),
  ]);

  return Array.from(accountIds).map((accountId) => {
    const from =
      active.transfers.find((t) => t.accountId === accountId) ?? null;
    const to = draft.transfers.find((t) => t.accountId === accountId) ?? null;
    const fromPerPayCents = from ? from.perPayCents : null;
    const toPerPayCents = to ? to.perPayCents : null;
    const deltaPerPayCents = (toPerPayCents ?? 0) - (fromPerPayCents ?? 0);
    return { accountId, fromPerPayCents, toPerPayCents, deltaPerPayCents };
  });
}
