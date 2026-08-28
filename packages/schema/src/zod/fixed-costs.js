import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

export const fixedCostsSummaryQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
});

/** @typedef {z.infer<typeof fixedCostsSummaryQuerySchema>} FixedCostsSummaryQuery */

// `opening` seeds the insight-only balance curve (phases/06-fixed-costs.md
// "What this phase must not do") — it never feeds back into the
// contribution figure, only into where this one chart's line starts.
export const balanceCurveQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  opening: z.coerce.number().int().default(0),
});

/** @typedef {z.infer<typeof balanceCurveQuerySchema>} BalanceCurveQuery */
