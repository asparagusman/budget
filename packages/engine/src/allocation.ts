import type { Cents } from "./money.js";
import { divideCents, pctOfCents } from "./money.js";
import type { Cadence } from "./cadence.js";
import { equivalent } from "./cadence.js";

export type Basis =
  | "from_fixed_costs" // value ignored; injected from input
  | "from_variable_essentials" // value ignored; injected from input
  | "pct_of_gross" // value = percentage of gross
  | "pct_of_remaining" // value = percentage of remaining at this stage's start
  | "fixed_amount" // value = cents
  | "sweep"; // value = relative weight; splits all remaining at stage start

export interface AllocationLine {
  id: string;
  stage: number; // 1..N, evaluated in ascending order
  label: string;
  basis: Basis;
  value: number | null;
  goalPct: number | null;
  accountId: string;
}

export interface AllocationInput {
  grossPerMonthCents: Cents;
  payCadence: Cadence; // cadence transfers are expressed in
  fixedTotalPerMonthCents: Cents;
  variableEssentialsPerMonthCents: Cents;
  variableNonEssentialPerMonthCents: Cents; // benchmark only — NEVER deducted
  incomeLandingAccountId: string;
  lines: AllocationLine[];
}

export interface ResolvedLine {
  lineId: string;
  perMonthCents: Cents;
  perPayCents: Cents;
  perWeekCents: Cents;
  actualPct: number | null; // of gross
  fidelity: number | null; // (actualPct - goalPct) / goalPct
}

export interface StageResult {
  stage: number;
  subtotalPerMonthCents: Cents;
  remainingPerMonthCents: Cents;
  goalPct: number | null;
  actualPct: number | null;
  fidelity: number | null;
}

export interface Transfer {
  accountId: string;
  perMonthCents: Cents;
  perPayCents: Cents;
  lineIds: string[];
  isNoOp: boolean; // true for incomeLandingAccountId — money that stays put
}

export interface AllocationResult {
  lines: ResolvedLine[];
  stages: StageResult[];
  transfers: Transfer[];
  unallocatedPerMonthCents: Cents;
  goodLifeFidelityCents: Cents; // nonEssential − final remaining; positive = short of aspiration
}

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
 */
function resolveStageLineAmounts(
  stageLines: AllocationLine[],
  input: AllocationInput,
  remainingAtStageStart: Cents,
): Map<string, Cents> {
  const amounts = new Map<string, Cents>();

  const directBases: Record<Exclude<Basis, "pct_of_gross" | "pct_of_remaining" | "sweep">, Cents> = {
    from_fixed_costs: input.fixedTotalPerMonthCents,
    from_variable_essentials: input.variableEssentialsPerMonthCents,
    fixed_amount: 0 as Cents, // per-line value, handled below
  };

  for (const line of stageLines) {
    if (line.basis === "from_fixed_costs" || line.basis === "from_variable_essentials") {
      amounts.set(line.id, directBases[line.basis]);
    } else if (line.basis === "fixed_amount") {
      amounts.set(line.id, (line.value ?? 0) as Cents);
    }
  }

  const applyPercentGroup = (basis: "pct_of_gross" | "pct_of_remaining", base: Cents) => {
    const group = stageLines.filter((l) => l.basis === basis);
    if (group.length === 0) return;
    const values = group.map((l) => l.value ?? 0);
    const groupTotal = pctOfCents(base, values.reduce((a, b) => a + b, 0));
    const shares = divideCents(groupTotal, values);
    group.forEach((l, i) => amounts.set(l.id, shares[i]!));
  };

  applyPercentGroup("pct_of_gross", input.grossPerMonthCents);
  applyPercentGroup("pct_of_remaining", remainingAtStageStart);

  const sweepLines = stageLines.filter((l) => l.basis === "sweep");
  if (sweepLines.length > 0) {
    const weights = sweepLines.map((l) => l.value ?? 0);
    const shares = divideCents(remainingAtStageStart, weights);
    sweepLines.forEach((l, i) => amounts.set(l.id, shares[i]!));
  }

  return amounts;
}

function pctOfGross(amountCents: Cents, grossPerMonthCents: Cents): number | null {
  if (grossPerMonthCents === 0) return null;
  return (amountCents / grossPerMonthCents) * 100;
}

function fidelityOf(actualPct: number | null, goalPct: number | null): number | null {
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
 */
export function computeAllocation(input: AllocationInput): AllocationResult {
  const gross = input.grossPerMonthCents;
  const stageNumbers = Array.from(new Set(input.lines.map((l) => l.stage))).sort((a, b) => a - b);

  let remaining = gross;
  let lastStageRemainingAtStart: Cents = gross;
  const resolvedByLineId = new Map<string, ResolvedLine>();
  const stages: StageResult[] = [];

  for (const stageNum of stageNumbers) {
    const stageLines = input.lines.filter((l) => l.stage === stageNum);
    const remainingAtStart = remaining;
    lastStageRemainingAtStart = remainingAtStart;

    const stageAmounts = resolveStageLineAmounts(stageLines, input, remainingAtStart);

    let subtotal = 0 as Cents;
    for (const line of stageLines) {
      const perMonthCents = stageAmounts.get(line.id)!;
      subtotal = (subtotal + perMonthCents) as Cents;

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

    remaining = (remaining - subtotal) as Cents;

    // Stage-level goal is the sum of its lines' own goals — null when none
    // of the stage's lines carry one, rather than fabricating a target the
    // operator never entered.
    const goalValues = stageLines.map((l) => l.goalPct).filter((g): g is number => g !== null);
    const stageGoalPct = goalValues.length > 0 ? goalValues.reduce((a, b) => a + b, 0) : null;
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
  const accountOrder: string[] = [];
  const accountMonthly = new Map<string, Cents>();
  const accountLineIds = new Map<string, string[]>();
  const touchAccount = (accountId: string) => {
    if (!accountMonthly.has(accountId)) {
      accountOrder.push(accountId);
      accountMonthly.set(accountId, 0 as Cents);
      accountLineIds.set(accountId, []);
    }
  };
  for (const line of input.lines) {
    const resolved = resolvedByLineId.get(line.id)!;
    touchAccount(line.accountId);
    accountMonthly.set(line.accountId, ((accountMonthly.get(line.accountId) as number) + perMonth(resolved)) as Cents);
    accountLineIds.get(line.accountId)!.push(line.id);
  }

  // Money nobody explicitly allocated simply stays where the salary landed —
  // nothing moved it. Folding it into the landing account here (rather than
  // dropping it) is what makes the reconciliation invariant below hold
  // unconditionally, not just when every stage's lines happen to sum to
  // 100% of remaining.
  touchAccount(input.incomeLandingAccountId);
  accountMonthly.set(
    input.incomeLandingAccountId,
    ((accountMonthly.get(input.incomeLandingAccountId) as number) + (remaining as number)) as Cents,
  );

  const grossPerPay = equivalent(gross, "monthly", input.payCadence);
  const weights = accountOrder.map((id) => accountMonthly.get(id) as number);
  const perPayShares = divideCents(grossPerPay, weights);

  const transfers: Transfer[] = accountOrder.map((accountId, i) => ({
    accountId,
    perMonthCents: accountMonthly.get(accountId)!,
    perPayCents: perPayShares[i]!,
    lineIds: accountLineIds.get(accountId)!,
    isNoOp: accountId === input.incomeLandingAccountId,
  }));

  const goodLifeFidelityCents = (input.variableNonEssentialPerMonthCents - lastStageRemainingAtStart) as Cents;

  return {
    lines: input.lines.map((l) => resolvedByLineId.get(l.id)!),
    stages,
    transfers,
    unallocatedPerMonthCents: remaining,
    goodLifeFidelityCents,
  };
}

function perMonth(resolved: ResolvedLine): number {
  return resolved.perMonthCents as number;
}

export interface TransferDelta {
  accountId: string;
  fromPerPayCents: Cents | null; // null = new destination
  toPerPayCents: Cents | null; // null = destination removed
  deltaPerPayCents: Cents;
}

/** Compares two allocation results' transfers, account by account — used to
 * show the operator exactly what a draft change would move before they
 * commit to it. */
export function diffAllocations(active: AllocationResult, draft: AllocationResult): TransferDelta[] {
  const accountIds = new Set<string>([
    ...active.transfers.map((t) => t.accountId),
    ...draft.transfers.map((t) => t.accountId),
  ]);

  return Array.from(accountIds).map((accountId) => {
    const from = active.transfers.find((t) => t.accountId === accountId) ?? null;
    const to = draft.transfers.find((t) => t.accountId === accountId) ?? null;
    const fromPerPayCents = from ? from.perPayCents : null;
    const toPerPayCents = to ? to.perPayCents : null;
    const deltaPerPayCents = ((toPerPayCents ?? 0) - (fromPerPayCents ?? 0)) as Cents;
    return { accountId, fromPerPayCents, toPerPayCents, deltaPerPayCents };
  });
}
