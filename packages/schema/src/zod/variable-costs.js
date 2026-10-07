import { z } from "zod";
import { MAX_SCAFFOLD_PERIODS } from "./bill-history.js";

// GET /variable-costs/cycles?periods=N — the entry scaffold, mirroring
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
});

/** @typedef {z.infer<typeof variableCostsCyclesQuerySchema>} VariableCostsCyclesQuery */
