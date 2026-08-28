import { z } from "zod";

// GET /variable-costs/cycles?periods=N — the entry scaffold, mirroring
// GET /bills/:id/history so the two entry screens feel like the same tool
// (phases/07-variable-costs.md "API"). 6 / 12 / 24 are the UI's preset
// options, but "custom" means any positive count, hence no `.max()`.
export const variableCostsCyclesQuerySchema = z.object({
  periods: z.coerce.number().int().min(1).default(6),
});

/** @typedef {z.infer<typeof variableCostsCyclesQuerySchema>} VariableCostsCyclesQuery */
