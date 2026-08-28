import { z } from "zod";

// PUT /bills/:id/seasonal-factors — always replaces the full curve in one
// call (phases/06-fixed-costs.md "Schema": "Always written as a full set of
// 12 rows"). `factors[0]` is January, `factors[11]` is December — the
// 12-month editor is naturally an array of 12 fields, so this avoids a
// month-keyed object only to have the route re-index it anyway.
export const replaceBillSeasonalFactorsSchema = z.object({
  factors: z.array(z.number().min(0)).length(12, "Provide all 12 months."),
});

/** @typedef {z.infer<typeof replaceBillSeasonalFactorsSchema>} ReplaceBillSeasonalFactorsInput */
