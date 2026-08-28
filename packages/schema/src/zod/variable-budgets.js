import { z } from "zod";
import { cadence } from "../tables/pay-schedules.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const variableBudgetFields = {
  categoryId: z.string().uuid(),
  amountCents: z.number().int(),
  cadence: z.enum(cadence.enumValues).default("monthly"),
  effectiveFrom: isoDate,
  note: z.string().trim().max(500).nullable().optional(),
};

// POST /variable-budgets — a new dated row, never an edit of an earlier
// one's amount (phases/07-variable-costs.md "Schema").
export const createVariableBudgetSchema = z.object(variableBudgetFields);

/** @typedef {z.infer<typeof createVariableBudgetSchema>} CreateVariableBudgetInput */

// Zod's `.partial()` keeps a field's `.default()`, so a PATCH that omits a
// defaulted key still writes that default — a single-field update would
// silently reset a fortnightly budget row's cadence to monthly. The
// defaulted fields are respelled here without their defaults, the same way
// people.js and pay-schedules.js already do it, so "absent" means "leave
// alone".
// PATCH /variable-budgets/:id — all fields optional so a caller can send
// just one; for correcting a mistaken row, not for "changing the budget"
// going forward (that's a new POST row).
export const updateVariableBudgetSchema = z
  .object({ ...variableBudgetFields, cadence: z.enum(cadence.enumValues) })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateVariableBudgetSchema>} UpdateVariableBudgetInput */
