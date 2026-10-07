import { equivalent, projectPaydays, requiredOpeningBalanceCents, simulateBalance } from "@budget/engine";
import { balanceCurveQuerySchema, fixedCostsSummaryQuerySchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { loadAllocationContext } from "../lib/allocation.js";
import { getPrimaryPaySchedule } from "../lib/income.js";
import {
  billFigures,
  computeContribution,
  getBillsBufferCents,
  projectActiveBills,
  resolveOpeningBalance,
  sumBillFigures,
} from "../lib/bills.js";
import { handleValidation } from "../lib/validation.js";

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createFixedCostsRoutes({ db }) {
  const app = new Hono();

  return app
    // The headline number, per phases/06-fixed-costs.md "API" — everything
    // else on /costs/fixed is either raw bill data or this endpoint's
    // per-category breakdown, never a separately-computed total.
    .get("/summary", zValidator("query", fixedCostsSummaryQuerySchema, handleValidation), async (c) => {
      const window = c.req.valid("query");
      const paySchedule = await getPrimaryPaySchedule(db);

      const categories = await db.query.costCategories.findMany({
        where: (cat, { and: andCol, eq: eqCol, isNull: isNullCol }) =>
          andCol(isNullCol(cat.archivedAt), eqCol(cat.kind, "fixed")),
        orderBy: (cat, { asc }) => [asc(cat.sortOrder), asc(cat.name)],
      });
      const { bills, instancesByBill, allInstances, warnings } = await projectActiveBills(db, window);

      if (!paySchedule) {
        warnings.push({
          code: "no_primary_pay_schedule",
          message: "Set a primary pay schedule to see per-pay figures.",
        });
      }

      // Every figure on /costs/fixed resolves through one bill's projected
      // instances — the amount its row prints, the subtotal above it, and the
      // annual equivalent beside it. The screen used to derive rows itself
      // from `baseAmountCents * occurrences`, which silently disagreed with
      // these subtotals for any bill whose amount model actually did
      // something (see `billFigures`).
      const byBill = bills.map((bill) =>
        billFigures(bill, instancesByBill.get(bill.id) ?? [], window, paySchedule),
      );

      // Each category's subtotal is derived from bill membership, never a
      // stored range (phases/06-fixed-costs.md "Category subtotals are
      // derived") — and specifically it is the sum of the rows printed under
      // it, so the two can never disagree.
      const byCategory = categories.map((cat) => {
        const rows = byBill.filter((b) => b.categoryId === cat.id);
        const totals = sumBillFigures(rows, paySchedule);
        return {
          categoryId: cat.id,
          name: cat.name,
          perYearCents: totals.perYearCents,
          perMonthCents: totals.perMonthCents,
          perPayCents: totals.perPayCents,
          billCount: rows.length,
        };
      });

      return c.json({
        window,
        contribution: computeContribution(allInstances, window, paySchedule),
        byBill,
        byCategory,
        billCount: bills.length,
        warnings,
      });
    })

    // Insight only, never the contribution figure itself (phases/
    // 06-fixed-costs.md "What this phase must not do") — a separate endpoint
    // keeps that physically impossible to blur.
    .get("/balance-curve", zValidator("query", balanceCurveQuerySchema, handleValidation), async (c) => {
      const { from, to, opening } = c.req.valid("query");
      const window = { from, to };

      const paySchedule = await getPrimaryPaySchedule(db);
      if (!paySchedule) {
        return c.json(
          { error: { code: "no_primary_schedule", message: "Set a primary pay schedule first." } },
          400,
        );
      }

      // With no `opening` in the query the curve starts from the saved
      // figure — an override if one is set, otherwise the income-landing
      // account's own latest balance. A supplied `opening` is an unsaved
      // what-if: it drives the curve, but `savedOpeningBalance` still reports
      // what the screen would fall back to, and where it came from, so no
      // assumed figure is ever presented as fact.
      const savedOpeningBalance = await resolveOpeningBalance(db);
      const openingBalanceCents = opening ?? savedOpeningBalance.openingBalanceCents;

      const [{ allInstances }, context] = await Promise.all([
        projectActiveBills(db, window),
        loadAllocationContext(db, from),
      ]);
      // Each payday credits what the plan actually transfers for bills: its
      // `from_fixed_costs` line is `fixedTotalPerMonthCents`, averaged over
      // the allocation's own four-year window, then converted to the pay
      // cadence by `equivalent()` — the engine's `ResolvedLine.perPayCents`
      // for that line, to the cent. Averaging this curve's own shorter window
      // instead credited a figure nobody transfers: with a car loan ending
      // eight months in, $1,107.69 a fortnight against a real $969.23, which
      // understated the opening balance the account needs by ~$2,077.
      const perPayCents = equivalent(context.fixedTotalPerMonthCents, "monthly", paySchedule.cadence);
      const paydays = projectPaydays(paySchedule, window);
      const bufferCents = await getBillsBufferCents(db);

      return c.json({
        window,
        points: simulateBalance(allInstances, perPayCents, paydays, openingBalanceCents),
        contributionPerPayCents: perPayCents,
        requiredOpeningBalanceCents: requiredOpeningBalanceCents(allInstances, perPayCents, paydays, bufferCents),
        openingBalanceCents,
        savedOpeningBalance,
      });
    });
}
