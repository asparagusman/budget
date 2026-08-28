import { addDaysIso, equivalent, resolveCycle, resolveVariableBudget, trailingAverageCents } from "@budget/engine";
import { getPrimaryPaySchedule } from "./income.js";

/** @import { Cadence, Cents, IsoDate, PaySchedule, VariableBudgetRow } from "@budget/engine" */

/**
 * @typedef {{ id: string, categoryId: string, amountCents: Cents, cadence: Cadence, effectiveFrom: IsoDate, note: string | null }} StoredVariableBudget
 */

/**
 * @typedef {{ id: string, name: string, isEssential: boolean }} VariableCostCategory
 */

/**
 * One category's slice of `/variable-costs/summary`. `budgetPerMonthCents`
 * is 0 (with a warning pushed by the caller) when the category has no
 * budget row yet — `trailingAveragePerMonthCents` and `varianceCents` stay
 * `null`, never `0`, whenever there isn't enough to compute them
 * (phases/07-variable-costs.md "Acceptance criteria").
 *
 * @param {VariableCostCategory} category
 * @param {StoredVariableBudget[]} ownBudgetRows
 * @param {Cents[]} ownActualsCents
 * @param {PaySchedule | null} primaryPaySchedule
 * @param {IsoDate} today
 */
export function summarizeVariableCategory(category, ownBudgetRows, ownActualsCents, primaryPaySchedule, today) {
  const currentBudget = resolveVariableBudget(ownBudgetRows, today);
  const budgetPerMonthCents = currentBudget ? equivalent(currentBudget.amountCents, currentBudget.cadence, "monthly") : 0;

  // Actuals are recorded one per pay cycle, so their mean is a per-cycle
  // figure — `equivalent()` (never manual cadence math, per phases/
  // README.md "Money") converts it to monthly using the household's actual
  // cycle length, the primary pay schedule's cadence.
  const trailingAveragePerCycleCents = trailingAverageCents(ownActualsCents);
  const trailingAveragePerMonthCents =
    trailingAveragePerCycleCents !== null && primaryPaySchedule
      ? equivalent(trailingAveragePerCycleCents, primaryPaySchedule.cadence, "monthly")
      : null;

  return {
    categoryId: category.id,
    name: category.name,
    isEssential: category.isEssential,
    budgetPerMonthCents,
    trailingAveragePerMonthCents,
    varianceCents:
      trailingAveragePerMonthCents !== null && currentBudget ? trailingAveragePerMonthCents - budgetPerMonthCents : null,
    cyclesRecorded: ownActualsCents.length,
  };
}

/**
 * @param {import("@budget/schema").Db} db
 */
export async function loadActiveVariableCategories(db) {
  return db.query.costCategories.findMany({
    where: (cat, { and: andCol, eq: eqCol, isNull: isNullCol }) =>
      andCol(isNullCol(cat.archivedAt), eqCol(cat.kind, "variable")),
    orderBy: (cat, { asc }) => [asc(cat.sortOrder), asc(cat.name)],
  });
}

/**
 * The whole `/variable-costs/summary` payload: two named totals, never a
 * single combined one. Deducting a non-essential category would double-count
 * money already accounted for by the prize-pool lines that fund it
 * (phases/07-variable-costs.md "The trap").
 *
 * Shared with the allocation, which deducts `essentialPerMonthCents` and
 * benchmarks against `nonEssentialPerMonthCents` — phase 08 reads the same
 * figures phase 07 reports rather than deriving its own
 * (phases/08-allocation.md "/allocation/compute"). `on` is the date budgets
 * are resolved against, so previewing a future date picks up a budget row
 * that starts later.
 *
 * @param {import("@budget/schema").Db} db
 * @param {IsoDate} on
 */
export async function summarizeVariableCosts(db, on) {
  const [categories, budgetRows, actualRows, primary] = await Promise.all([
    loadActiveVariableCategories(db),
    db.query.variableBudgets.findMany(),
    db.query.variableActuals.findMany(),
    getPrimaryPaySchedule(db),
  ]);

  /** @type {{ code: string, message: string, categoryId?: string }[]} */
  const warnings = [];
  if (!primary) {
    warnings.push({
      code: "no_primary_pay_schedule",
      message: "Set a primary pay schedule to see trailing averages.",
    });
  }

  const byCategory = categories.map((cat) => {
    const ownBudgetRows = budgetRows.filter((b) => b.categoryId === cat.id);
    const ownActualsCents = actualRows.filter((a) => a.categoryId === cat.id).map((a) => a.amountCents);

    if (ownBudgetRows.length === 0) {
      warnings.push({
        code: "no_budget_set",
        message: `"${cat.name}" has no budget set yet.`,
        categoryId: cat.id,
      });
    }

    return summarizeVariableCategory(cat, ownBudgetRows, ownActualsCents, primary, on);
  });

  const essentialPerMonthCents = byCategory
    .filter((c) => c.isEssential)
    .reduce((sum, c) => sum + c.budgetPerMonthCents, 0);
  const nonEssentialPerMonthCents = byCategory
    .filter((c) => !c.isEssential)
    .reduce((sum, c) => sum + c.budgetPerMonthCents, 0);

  return { essentialPerMonthCents, nonEssentialPerMonthCents, byCategory, warnings };
}

/**
 * The reverse-sequential entry scaffold's cycle bounds, newest first.
 * Ordinal 1 ("Previous cycle") is the cycle `today` currently falls inside —
 * variable spending is checked in on as it happens, unlike a bill's fixed
 * due date — and each earlier ordinal steps back one full cycle via the
 * engine's own `resolveCycle`, never by re-deriving cadence arithmetic here
 * (phases/07-variable-costs.md "API").
 *
 * @param {PaySchedule} primaryPaySchedule
 * @param {IsoDate} today
 * @param {number} periods
 */
export function buildCycleScaffold(primaryPaySchedule, today, periods) {
  /** @type {{ ordinal: number, label: string, cycleStart: IsoDate, cycleEnd: IsoDate }[]} */
  const cycles = [];
  let cursor = resolveCycle(primaryPaySchedule, today);
  for (let i = 0; i < periods; i++) {
    cycles.push({
      ordinal: i + 1,
      label: i === 0 ? "Previous cycle" : `${i + 1} cycles ago`,
      cycleStart: cursor.cycleStart,
      cycleEnd: cursor.cycleEnd,
    });
    cursor = resolveCycle(primaryPaySchedule, addDaysIso(cursor.cycleStart, -1));
  }
  return cycles;
}
