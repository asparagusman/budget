import { z } from "zod";
import { MAX_SCAFFOLD_PERIODS } from "./bill-history.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

// `on` is the browser's own calendar date. Without it the server's clock
// decides which cycle is "current", and a page that sent its date elsewhere
// (goals, projections, the dashboard) could disagree with this one about it.
// Optional, defaulted to today in the handler — a schema-level default would
// freeze the date at module load.

// GET /variable-costs/summary?on=
export const variableCostsSummaryQuerySchema = z.object({
  on: isoDate.optional(),
});

/** @typedef {z.infer<typeof variableCostsSummaryQuerySchema>} VariableCostsSummaryQuery */

// GET /variable-costs/cycles?periods=N&on= — the entry scaffold, mirroring
// GET /bills/:id/history so the two entry screens feel like the same tool
// (phases/07-variable-costs.md "API") — down to the same cap on `periods`,
// for the same reason (see bill-history.js).
export const variableCostsCyclesQuerySchema = z.object({
  periods: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SCAFFOLD_PERIODS, `At most ${MAX_SCAFFOLD_PERIODS} periods at a time.`)
    .default(6),
  on: isoDate.optional(),
});

/** @typedef {z.infer<typeof variableCostsCyclesQuerySchema>} VariableCostsCyclesQuery */
