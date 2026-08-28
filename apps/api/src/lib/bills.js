import { billsContribution, projectInstances } from "@budget/engine";

/** @import { Bill, BillInstance, Cadence, Cents, DateWindow, PaySchedule } from "@budget/engine" */

/**
 * @typedef {{
 *   id: string,
 *   billId: string,
 *   dueDate: string,
 *   expectedCents: Cents | null,
 *   actualCents: Cents | null,
 *   isOverride: boolean,
 *   paidOn: string | null,
 *   note: string | null,
 * }} StoredBillInstance A `bill_instances` row as Drizzle returns it.
 */

/**
 * DB row -> the engine's pure `Bill` shape. `seasonalFactors`/`stepChanges`
 * are left `undefined` (not `{}`/`[]`) when empty, matching the engine's own
 * `?? 1` / `?? []` fallbacks in `computeExpectedCents` — an empty object and
 * a missing one behave identically there, so either is fine, but `undefined`
 * is what a bill with no rows yet actually is.
 *
 * @param {{ id: string, baseAmountCents: Cents, frequency: Cadence, anchorDate: string, amountModel: import("@budget/engine").AmountModel, escalationPct: number | null, rollingWindow: number | null }} row
 * @param {{ month: number, factor: number }[]} factorRows
 * @param {{ effectiveFrom: string, newAmountCents: Cents }[]} stepChangeRows
 * @returns {Bill}
 */
export function toEngineBill(row, factorRows = [], stepChangeRows = []) {
  return {
    id: row.id,
    baseAmountCents: row.baseAmountCents,
    frequency: row.frequency,
    anchorDate: row.anchorDate,
    amountModel: row.amountModel,
    escalationPct: row.escalationPct ?? undefined,
    rollingWindow: row.rollingWindow ?? undefined,
    seasonalFactors:
      factorRows.length > 0 ? Object.fromEntries(factorRows.map((f) => [f.month, f.factor])) : undefined,
    stepChanges:
      stepChangeRows.length > 0
        ? stepChangeRows.map((s) => ({ effectiveFrom: s.effectiveFrom, newAmountCents: s.newAmountCents }))
        : undefined,
  };
}

/**
 * Stored `bill_instances` rows -> the engine's `BillInstance[]` — drops the
 * bookkeeping columns (`id`, `paidOn`, `note`) the engine doesn't model.
 *
 * `expectedCents` is nullable in the database (a bare actual entry never
 * needs one) but non-nullable in the engine's `BillInstance` — the engine
 * only ever reads it back for a row with `isOverride: true`, and an override
 * row always has a real value there (`createBillInstanceSchema` requires
 * it), so `?? 0` here is a placeholder for a field the engine provably never
 * reads on any row where it could actually be null, not a stand-in "trust
 * me" for a value that might be missing when read.
 *
 * @param {{ billId: string, dueDate: string, expectedCents: Cents | null, actualCents: Cents | null, isOverride: boolean }[]} rows
 * @returns {BillInstance[]}
 */
export function toEngineHistory(rows) {
  return rows.map((r) => ({
    billId: r.billId,
    dueDate: r.dueDate,
    expectedCents: r.expectedCents ?? 0,
    actualCents: r.actualCents,
    isOverride: r.isOverride,
  }));
}

/**
 * Whether `escalationPct`/`rollingWindow` are required, forbidden or
 * optional depends on `amountModel` — a semantic rule, not a shape rule, so
 * it's checked here rather than in Zod (same split as accounts.js's
 * `externalAccountError`). Pass the fully-resolved (create: as submitted;
 * update: merged over the current row) values, not just the PATCH delta.
 *
 * @param {{ amountModel: string, escalationPct?: number | null, rollingWindow?: number | null }} data
 */
export function amountModelFieldError(data) {
  if (data.amountModel === "escalating" && data.escalationPct == null) {
    return "Escalating bills need an escalation percentage.";
  }
  if (data.amountModel === "rolling_average" && data.rollingWindow == null) {
    return "Rolling-average bills need a window size.";
  }
  return null;
}

/**
 * 'seasonal' bills are written as a full set of 12 rows in one call
 * (PUT /bills/:id/seasonal-factors) — fewer than 12 means the operator
 * hasn't finished the editor yet, surfaced as a warning
 * (phases/06-fixed-costs.md "Warnings surface for orphans and incomplete
 * seasonal curves").
 *
 * @param {{ amountModel: string }} bill
 * @param {unknown[]} factorRows
 */
export function seasonalCurveIncomplete(bill, factorRows) {
  return bill.amountModel === "seasonal" && factorRows.length < 12;
}

/**
 * Groups `rows` by `keyFn(row)`, preserving input order within each group.
 *
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => string} keyFn
 */
function groupBy(rows, keyFn) {
  /** @type {Map<string, T[]>} */
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const group = map.get(key);
    if (group) group.push(row);
    else map.set(key, [row]);
  }
  return map;
}

/**
 * Batch-loads every seasonal factor and step change for a set of bills — the
 * modifiers a plain bill list needs — plus every stored instance
 * (`withHistory`, on by default) for screens that go on to project a window
 * or compute a rolling average. Three queries total, however many bills
 * there are (phases/06-fixed-costs.md "Instance storage" step 2). Skip
 * `withHistory` for a listing that has no use for it (`GET /bills`) to save
 * the third query.
 *
 * @param {import("@budget/schema").Db} db
 * @param {string[]} billIds
 * @param {{ withHistory?: boolean }} [options]
 */
export async function loadBillModifiers(db, billIds, { withHistory = true } = {}) {
  if (billIds.length === 0) {
    return { factorsByBill: new Map(), stepChangesByBill: new Map(), historyByBill: new Map() };
  }
  const [factorRows, stepChangeRows, historyRows] = await Promise.all([
    db.query.billSeasonalFactors.findMany({ where: (f, { inArray }) => inArray(f.billId, billIds) }),
    db.query.billStepChanges.findMany({ where: (s, { inArray }) => inArray(s.billId, billIds) }),
    withHistory
      ? db.query.billInstances.findMany({ where: (i, { inArray }) => inArray(i.billId, billIds) })
      : Promise.resolve([]),
  ]);
  return {
    factorsByBill: groupBy(factorRows, (r) => r.billId),
    stepChangesByBill: groupBy(stepChangeRows, (r) => r.billId),
    historyByBill: groupBy(historyRows, (r) => r.billId),
  };
}

/**
 * Stored rows inside `window` whose `dueDate` isn't among `projectedDates` —
 * the operator changed `anchorDate`/`frequency` after the row was written,
 * so it no longer aligns with any occurrence the new schedule produces.
 * Never dropped, only flagged (phases/06-fixed-costs.md "Orphaned
 * instances").
 *
 * @param {StoredBillInstance[]} historyRows
 * @param {string[]} projectedDates
 * @param {DateWindow} window
 */
function findOrphanRows(historyRows, projectedDates, window) {
  const projectedSet = new Set(projectedDates);
  return historyRows.filter(
    (r) => r.dueDate >= window.from && r.dueDate < window.to && !projectedSet.has(r.dueDate),
  );
}

/**
 * The full read path for one bill (phases/06-fixed-costs.md "Instance
 * storage" steps 3-4, plus orphan detection): project the series, enrich
 * each projected instance with the bookkeeping fields the engine doesn't
 * model (`id`, `paidOn`, `note`) from any stored row at that exact date, and
 * separately surface stored rows that no longer land on a projected date.
 *
 * @param {Bill} engineBill
 * @param {StoredBillInstance[]} historyRows
 * @param {DateWindow} window
 */
export function projectBillInWindow(engineBill, historyRows, window) {
  const history = toEngineHistory(historyRows);
  const projected = projectInstances(engineBill, window, history);
  const byDate = new Map(historyRows.map((r) => [r.dueDate, r]));

  const instances = projected.map((p) => {
    const stored = byDate.get(p.dueDate);
    return {
      ...p,
      id: stored?.id ?? null,
      paidOn: stored?.paidOn ?? null,
      note: stored?.note ?? null,
      isOrphan: false,
    };
  });

  const orphans = findOrphanRows(historyRows, projected.map((p) => p.dueDate), window).map((r) => ({
    billId: r.billId,
    dueDate: r.dueDate,
    expectedCents: r.expectedCents,
    actualCents: r.actualCents,
    isOverride: r.isOverride,
    id: r.id,
    paidOn: r.paidOn,
    note: r.note,
    isOrphan: true,
  }));

  return { instances, orphans };
}

/**
 * `billsContribution`'s per-month/per-year figures never actually read
 * `paySchedule` (only `perPayCents` does, via `countPaydays`), so a
 * placeholder schedule is safe to pass through when there isn't a primary
 * one yet — only the `perPayCents` a placeholder would have produced gets
 * discarded below, replaced with `null`. Same convention as income's "no
 * primary pay schedule -> per-pay is null" (apps/api/src/lib/income.js).
 *
 * @param {BillInstance[]} instances
 * @param {DateWindow} window
 * @param {PaySchedule | null} paySchedule
 */
export function computeContribution(instances, window, paySchedule) {
  const raw = billsContribution(instances, window, paySchedule ?? { anchorDate: window.from, cadence: "monthly" });
  return { ...raw, perPayCents: paySchedule ? raw.perPayCents : null };
}

/**
 * Every active bill projected across `window`, with per-category grouping and
 * the warnings both readers of this data surface (an orphaned instance, an
 * unfinished seasonal curve). Shared by `/fixed-costs/summary`,
 * `/fixed-costs/balance-curve` and the allocation's own fixed-cost total —
 * phase 08 must deduct the same figure phase 06 reports, so it reads it
 * through this function rather than re-deriving one of its own
 * (phases/08-allocation.md "/allocation/compute").
 *
 * @param {import("@budget/schema").Db} db
 * @param {DateWindow} window
 */
export async function projectActiveBills(db, window) {
  const bills = await db.query.bills.findMany({ where: (b, { isNull: isNullCol }) => isNullCol(b.archivedAt) });
  const { factorsByBill, stepChangesByBill, historyByBill } = await loadBillModifiers(
    db,
    bills.map((b) => b.id),
  );

  /** @type {{ code: string, message: string, billId?: string }[]} */
  const warnings = [];
  /** @type {Map<string, BillInstance[]>} */
  const instancesByCategory = new Map();
  /** @type {BillInstance[]} */
  const allInstances = [];

  for (const bill of bills) {
    const factorRows = factorsByBill.get(bill.id) ?? [];
    const stepRows = stepChangesByBill.get(bill.id) ?? [];
    const historyRows = historyByBill.get(bill.id) ?? [];
    const engineBill = toEngineBill(bill, factorRows, stepRows);
    const { instances, orphans } = projectBillInWindow(engineBill, historyRows, window);

    allInstances.push(...instances);
    const categoryList = instancesByCategory.get(bill.categoryId) ?? [];
    categoryList.push(...instances);
    instancesByCategory.set(bill.categoryId, categoryList);

    if (orphans.length > 0) {
      warnings.push({
        code: "orphaned_instances",
        message: `"${bill.name}" has ${orphans.length} orphaned instance${orphans.length === 1 ? "" : "s"} in this window — its anchor date or frequency changed after they were entered.`,
        billId: bill.id,
      });
    }
    if (seasonalCurveIncomplete(bill, factorRows)) {
      warnings.push({
        code: "incomplete_seasonal_curve",
        message: `"${bill.name}"'s seasonal factors aren't fully set yet.`,
        billId: bill.id,
      });
    }
  }

  return { bills, instancesByCategory, allInstances, warnings };
}

/**
 * @param {import("@budget/schema").Db} db
 * @returns {Promise<Cents>}
 */
export async function getBillsBufferCents(db) {
  const row = await db.query.settings.findFirst({ where: (s, { eq: eqCol }) => eqCol(s.key, "billsBufferCents") });
  return typeof row?.value === "number" ? row.value : 0;
}
