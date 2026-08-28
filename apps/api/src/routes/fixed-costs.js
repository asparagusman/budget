import { billsContribution, projectPaydays, requiredOpeningBalanceCents, simulateBalance } from "@budget/engine";
import { balanceCurveQuerySchema, fixedCostsSummaryQuerySchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getPrimaryPaySchedule } from "../lib/income.js";
import { computeContribution, getBillsBufferCents, projectActiveBills } from "../lib/bills.js";
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
      const { bills, instancesByCategory, allInstances, warnings } = await projectActiveBills(db, window);

      if (!paySchedule) {
        warnings.push({
          code: "no_primary_pay_schedule",
          message: "Set a primary pay schedule to see per-pay figures.",
        });
      }

      // Each category's subtotal is `computeContribution` run over just that
      // category's instances — derived from bill membership, never a stored
      // range (phases/06-fixed-costs.md "Category subtotals are derived").
      const byCategory = categories.map((cat) => {
        const contribution = computeContribution(instancesByCategory.get(cat.id) ?? [], window, paySchedule);
        return {
          categoryId: cat.id,
          name: cat.name,
          perYearCents: contribution.perYearCents,
          perMonthCents: contribution.perMonthCents,
          perPayCents: contribution.perPayCents,
          billCount: bills.filter((b) => b.categoryId === cat.id).length,
        };
      });

      return c.json({
        window,
        contribution: computeContribution(allInstances, window, paySchedule),
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

      const { allInstances } = await projectActiveBills(db, window);
      // `paySchedule` is confirmed non-null above, so this — unlike
      // `computeContribution` — always returns a real `perPayCents`; no
      // null-handling wrapper needed on this path.
      const { perPayCents } = billsContribution(allInstances, window, paySchedule);
      const paydays = projectPaydays(paySchedule, window);
      const bufferCents = await getBillsBufferCents(db);

      return c.json({
        window,
        points: simulateBalance(allInstances, perPayCents, paydays, opening),
        contributionPerPayCents: perPayCents,
        requiredOpeningBalanceCents: requiredOpeningBalanceCents(allInstances, perPayCents, paydays, bufferCents),
      });
    });
}
