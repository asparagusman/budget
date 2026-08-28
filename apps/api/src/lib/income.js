import { equivalent } from "@budget/engine";

/** @import { Cadence, Cents, PaySchedule } from "@budget/engine" */

/**
 * Reads the household's transfer cadence from the primary pay schedule
 * (phase 04) — null if none is set yet, in which case per-pay totals can't
 * be computed at all (phases/05-income.md "API": "If none is set, return
 * the totals in monthly only and have the UI prompt the operator to set
 * one.").
 *
 * @param {import("@budget/schema").Db} db
 * @returns {Promise<Cadence | null>}
 */
export async function getPrimaryPayCadence(db) {
  const primary = await db.query.paySchedules.findFirst({
    where: (p, { and: andCol, eq: eqCol, isNull: isNullCol }) =>
      andCol(eqCol(p.isPrimary, true), isNullCol(p.archivedAt)),
  });
  return primary?.cadence ?? null;
}

/**
 * Full primary pay schedule (anchor + cadence) — phase 06 needs the anchor
 * as well to project paydays for its balance curve, where
 * `getPrimaryPayCadence` above (all income's per-pay totals need) isn't
 * enough.
 *
 * @param {import("@budget/schema").Db} db
 * @returns {Promise<PaySchedule | null>}
 */
export async function getPrimaryPaySchedule(db) {
  const primary = await db.query.paySchedules.findFirst({
    where: (p, { and: andCol, eq: eqCol, isNull: isNullCol }) =>
      andCol(eqCol(p.isPrimary, true), isNullCol(p.archivedAt)),
  });
  return primary ? { anchorDate: primary.anchorDate, cadence: primary.cadence } : null;
}

/** @typedef {{ perPay: Cents | null, perMonth: Cents, perYear: Cents }} CadenceTotals */

/**
 * Every figure here comes from the engine's `equivalent()` — this function
 * only sums what `equivalent()` already converted, never its own cadence
 * arithmetic (phases/README.md "Money", phases/05-income.md "API": "never
 * recomputed in a component").
 *
 * `totalCents` is the SUM of `perPersonCents`, not a separate conversion of
 * the combined raw amount. The two can differ by a cent right at a rounding
 * boundary — `equivalent()` rounds each conversion to the nearest cent, and
 * rounding two numbers then adding them doesn't always equal rounding their
 * sum — but a header total that doesn't reconcile with the breakdown under
 * it reads as a bug, so internal consistency wins here.
 *
 * @param {{ personId: string, amountCents: Cents, cadence: Cadence }[]} lines
 * @param {Cadence | null} payCadence
 */
export function computeVariantTotals(lines, payCadence) {
  /** @type {Record<string, CadenceTotals>} */
  const perPersonCents = {};

  for (const line of lines) {
    const existing = perPersonCents[line.personId] ?? {
      perPay: payCadence ? 0 : null,
      perMonth: 0,
      perYear: 0,
    };
    perPersonCents[line.personId] = {
      perPay: payCadence
        ? /** @type {Cents} */ (existing.perPay) + equivalent(line.amountCents, line.cadence, payCadence)
        : null,
      perMonth: existing.perMonth + equivalent(line.amountCents, line.cadence, "monthly"),
      perYear: existing.perYear + equivalent(line.amountCents, line.cadence, "yearly"),
    };
  }

  const totalCents = Object.values(perPersonCents).reduce(
    (acc, t) => ({
      perPay: payCadence ? /** @type {Cents} */ (acc.perPay) + /** @type {Cents} */ (t.perPay) : null,
      perMonth: acc.perMonth + t.perMonth,
      perYear: acc.perYear + t.perYear,
    }),
    /** @type {CadenceTotals} */ ({ perPay: payCadence ? 0 : null, perMonth: 0, perYear: 0 }),
  );

  return { perPersonCents, totalCents };
}

/**
 * Shared response shape for a variant — the list endpoint, the create/update
 * responses and `/income/resolve` all return exactly this, so the frontend
 * never has to know about more than one variant shape.
 *
 * @param {{ id: string, name: string, notes: string | null, sortOrder: number }} variant
 * @param {{ id: string, variantId: string, personId: string, label: string | null, amountCents: Cents, cadence: Cadence, notes: string | null, sortOrder: number }[]} lines
 * @param {Cadence | null} payCadence
 */
export function serializeVariant(variant, lines, payCadence) {
  return {
    id: variant.id,
    name: variant.name,
    notes: variant.notes,
    sortOrder: variant.sortOrder,
    lines,
    totals: computeVariantTotals(lines, payCadence),
  };
}
