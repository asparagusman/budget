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
 * @typedef {{
 *   id: string,
 *   stage: number,
 *   label: string,
 *   basis: Basis,
 *   value: number | null,
 *   goalPct: number | null,
 *   accountId: string
 * }} AllocationLine
 *
 * - `stage` — 1..N, evaluated in ascending order. It is also the section the
 *   line belongs to: the sheet's "Category" column is a section heading, not
 *   a per-row field, so stages 1/2/3 ARE Bills & Essentials / Save, Invest &
 *   Give / Leftover. A per-line `category` existed here briefly and was the
 *   wrong altitude — it put the sheet's own structure in a side panel and left
 *   the rows reading as an unlabelled list.
 * - `label` — the sheet's "Division": the area of the section this line is.
 */

/**
 * The three sections, which are stages 1/2/3 named.
 *
 * The spreadsheet's "Category" column is a section heading — three of them,
 * broken up by its Subtotal/Remaining rows — and its "Division" column is the
 * line. That structure is the whole reason the sheet reads fluently:
 * **what we must pay → what we choose to set aside → what's left**.
 *
 * It lives here rather than in the web app because two screens name these
 * groups (`/allocation`'s sections and the dashboard's breakdown tiles), and
 * two independent lists would drift — the dashboard already had to invent
 * "Allocated out" for the group it could not name (todo.md `[P10-2]`).
 *
 * Arithmetic still belongs entirely to `stage`: these are labels on the
 * evaluation order, and nothing here changes what a line resolves to.
 *
 * @type {{ stage: number, key: string, letter: string, name: string, blurb: string }[]}
 */
export const ALLOCATION_SECTIONS = [
  {
    stage: 1,
    key: "needs",
    letter: "A",
    name: "Bills & Essentials",
    blurb: "Fixed bills and essential variable costs, taken straight from their own screens.",
  },
  {
    stage: 2,
    key: "saving",
    letter: "B",
    name: "Save, Invest & Give",
    blurb: "Portions of income set aside — savings, investing, giving, and the emergency buffer.",
  },
  {
    stage: 3,
    key: "leftover",
    letter: "C",
    name: "Leftover",
    // Wording matters here: this section is a gauge, not an instruction. The
    // operator was explicit that its splits are "less about allocating, more
    // about gauging how much is theoretically left for each at that point".
    blurb: "What's left once needs and goals are met — and a read on what it's notionally for.",
  },
];

/** @param {number} stage */
export function sectionForStage(stage) {
  return ALLOCATION_SECTIONS.find((s) => s.stage === stage) ?? null;
}

/**
 * A goal on a whole section, which no per-line goal can express.
 *
 * The sheet carries Goal % on section A's Subtotal row (50%) and on section
 * B's Remaining row (10%). Neither is the sum of any line's goal — A's lines
 * are injected totals carrying no goal at all, and B's lines sum to 40%
 * against a section actual of 31%. Section C's lines sweep everything B
 * leaves, so C's subtotal IS that remaining and a goal here covers the sheet's
 * second figure without a second concept.
 *
 * @typedef {{ stage: number, goalPct: number }} StageGoal
 */

/**
 * @typedef {{
 *   grossPerMonthCents: Cents,
 *   payCadence: Cadence,
 *   fixedTotalPerMonthCents: Cents,
 *   variableEssentialsPerMonthCents: Cents,
 *   variableNonEssentialPerMonthCents: Cents,
 *   incomeLandingAccountId: string,
 *   lines: AllocationLine[],
 *   stageGoals?: StageGoal[]
 * }} AllocationInput
 *
 * - `payCadence` — cadence transfers are expressed in
 * - `variableNonEssentialPerMonthCents` — benchmark only — NEVER deducted
 * - `stageGoals` — optional; a section with no row here falls back to the sum
 *   of its own lines' goals
 */

/**
 * @typedef {{
 *   lineId: string,
 *   perMonthCents: Cents,
 *   perPayCents: Cents,
 *   perWeekCents: Cents,
 *   actualPct: number | null,
 *   goalPerMonthCents: Cents | null,
 *   goalPerPayCents: Cents | null,
 *   fidelity: number | null
 * }} ResolvedLine
 *
 * - `actualPct` — of gross
 * - `goalPerMonthCents` — what `goalPct` of gross actually is, in money.
 *   A percentage is not a figure anyone recognises against their own pay;
 *   "you're at $520, your 10% goal is $860" is the sentence the operator
 *   can act on. Null when the line carries no goal — never 0, which would
 *   read as a goal of nothing.
 * - `fidelity` — (actualPct - goalPct) / goalPct
 */

/**
 * @typedef {{
 *   stage: number,
 *   goalPerMonthCents: Cents | null,
 *   goalPerPayCents: Cents | null,
 *   subtotalPerMonthCents: Cents,
 *   subtotalPerPayCents: Cents,
 *   subtotalPerWeekCents: Cents,
 *   remainingPerMonthCents: Cents,
 *   remainingPerPayCents: Cents,
 *   remainingPerWeekCents: Cents,
 *   goalPct: number | null,
 *   goalSource: "stage" | "lines" | null,
 *   actualPct: number | null,
 *   fidelity: number | null
 * }} StageResult
 *
 * - subtotal/remaining carry all three cadences for the same reason
 *   `ResolvedLine` does: the screen's primary interval is the pay period, and
 *   converting in a component would put allocation arithmetic outside the engine.
 * - `goalSource` — where `goalPct` came from: `"stage"` when the operator set a
 *   goal on the section itself, `"lines"` when it is the sum of the section's
 *   own lines' goals, `null` when there is no goal either way. The UI needs the
 *   distinction: presenting a derived sum as a figure someone typed invites
 *   editing it where it can't be edited, and 40% summed from five lines is a
 *   different claim from 40% set on the section.
 */

/**
 * @typedef {{
 *   accountId: string,
 *   perMonthCents: Cents,
 *   perPayCents: Cents,
 *   lineIds: string[],
 *   isNoOp: boolean
 * }} Transfer
 *
 * - `isNoOp` — true for incomeLandingAccountId — money that stays put
 */

/**
 * @typedef {{
 *   lines: ResolvedLine[],
 *   stages: StageResult[],
 *   transfers: Transfer[],
 *   unallocatedPerMonthCents: Cents,
 *   goodLifeFidelityCents: Cents
 * }} AllocationResult
 *
 * - `stages` is the ONE grouping of the resolved lines. A parallel `categories`
 *   grouping (by a per-line heading) lived here and was removed: it was the
 *   same figures a second time, which on screen meant a side panel restating
 *   the section subtotals the sections were already showing.
 * - `goodLifeFidelityCents` — nonEssential − final remaining; positive = short of aspiration
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
 */
function pctOfGross(amountCents, grossPerMonthCents) {
  if (grossPerMonthCents === 0) return null;
  return (amountCents / grossPerMonthCents) * 100;
}

/**
 * @param {number | null} actualPct
 * @param {number | null} goalPct
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
 */
export function computeAllocation(input) {
  const gross = input.grossPerMonthCents;
  const stageGoalByStage = new Map(
    (input.stageGoals ?? []).map((g) => [g.stage, g.goalPct]),
  );
  // Every stage that has lines, plus every stage that has only a goal. A
  // section whose goal is set before its first line is entered still has to
  // appear — it is 0% of gross against a target, which is a real and readable
  // state, not an absent one.
  const stageNumbers = Array.from(
    new Set([
      ...input.lines.map((l) => l.stage),
      ...stageGoalByStage.keys(),
    ]),
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
      const goalPerMonthCents = line.goalPct === null ? null : pctOfCents(gross, line.goalPct);
      resolvedByLineId.set(line.id, {
        lineId: line.id,
        perMonthCents,
        perPayCents: equivalent(perMonthCents, "monthly", input.payCadence),
        perWeekCents: equivalent(perMonthCents, "monthly", "weekly"),
        actualPct,
        goalPerMonthCents,
        goalPerPayCents:
          goalPerMonthCents === null ? null : equivalent(goalPerMonthCents, "monthly", input.payCadence),
        fidelity: fidelityOf(actualPct, line.goalPct),
      });
    }

    remaining = remaining - subtotal;

    // A goal set on the SECTION wins outright; otherwise fall back to the sum
    // of its lines' own goals; otherwise null, rather than fabricating a
    // target the operator never entered.
    //
    // The precedence is not a tie-break, it is the point: the sheet's "bills
    // and essentials should be half our income" is a statement about the
    // section, and section A's lines are injected totals that carry no goal to
    // sum in the first place. Where both exist, the one typed on the section is
    // the one the operator can see and edit.
    const explicitStageGoal = stageGoalByStage.get(stageNum) ?? null;
    const goalValues = stageLines
      .map((l) => l.goalPct)
      .filter((g) => g !== null);
    const summedLineGoals =
      goalValues.length > 0 ? goalValues.reduce((a, b) => a + b, 0) : null;
    const stageGoalPct = explicitStageGoal ?? summedLineGoals;
    /** @type {StageResult["goalSource"]} */
    const goalSource =
      explicitStageGoal !== null ? "stage" : summedLineGoals !== null ? "lines" : null;
    const stageActualPct = pctOfGross(subtotal, gross);
    const stageGoalPerMonthCents = stageGoalPct === null ? null : pctOfCents(gross, stageGoalPct);

    stages.push({
      stage: stageNum,
      goalPerMonthCents: stageGoalPerMonthCents,
      goalPerPayCents:
        stageGoalPerMonthCents === null
          ? null
          : equivalent(stageGoalPerMonthCents, "monthly", input.payCadence),
      subtotalPerMonthCents: subtotal,
      subtotalPerPayCents: equivalent(subtotal, "monthly", input.payCadence),
      subtotalPerWeekCents: equivalent(subtotal, "monthly", "weekly"),
      remainingPerMonthCents: remaining,
      remainingPerPayCents: equivalent(remaining, "monthly", input.payCadence),
      remainingPerWeekCents: equivalent(remaining, "monthly", "weekly"),
      goalPct: stageGoalPct,
      goalSource,
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
 * @typedef {{
 *   accountId: string,
 *   fromPerPayCents: Cents | null,
 *   toPerPayCents: Cents | null,
 *   deltaPerPayCents: Cents
 * }} TransferDelta
 *
 * - `fromPerPayCents` — null = new destination
 * - `toPerPayCents` — null = destination removed
 */

/** Compares two allocation results' transfers, account by account — used to
 * show the operator exactly what a draft change would move before they
 * commit to it.
 *
 * @param {AllocationResult} active
 * @param {AllocationResult} draft
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
