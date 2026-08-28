import { resolveVariant } from "@budget/engine";
import { resolveVariantQuerySchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getPrimaryPayCadence, serializeVariant } from "../lib/income.js";
import { handleValidation } from "../lib/validation.js";

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createIncomeRoutes({ db }) {
  const app = new Hono();

  return app.get(
    "/resolve",
    zValidator("query", resolveVariantQuerySchema, handleValidation),
    async (c) => {
      const { on } = c.req.valid("query");

      const scheduleRows = await db.query.variantSchedule.findMany({});
      const entries = scheduleRows.map((row) => ({
        variantId: row.variantId,
        startsOn: row.startsOn,
        endsOn: row.endsOn,
      }));

      // Never guesses: exactly one covering entry resolves cleanly, more
      // than one yields an overlap diagnostic, none yields a gap diagnostic
      // — both cases return `variantId: null` rather than picking a winner
      // (phases/05-income.md "Resolution rules").
      const resolution = resolveVariant(entries, on);
      const payCadence = await getPrimaryPayCadence(db);

      let variant = null;
      if (resolution.variantId) {
        const row = await db.query.incomeVariants.findFirst({
          where: (v, { eq: eqCol }) => eqCol(v.id, /** @type {string} */ (resolution.variantId)),
        });
        if (row) {
          const lines = await db.query.incomeLines.findMany({
            where: (l, { eq: eqCol }) => eqCol(l.variantId, row.id),
            orderBy: (l, { asc }) => [asc(l.sortOrder)],
          });
          variant = serializeVariant(row, lines, payCadence);
        }
      }

      return c.json({ variantId: resolution.variantId, variant, diagnostics: resolution.diagnostics });
    },
  );
}
