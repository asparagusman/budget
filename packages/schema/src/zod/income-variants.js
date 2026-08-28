import { z } from "zod";

const incomeVariantFields = {
  name: z.string().trim().min(1, "Name is required").max(160),
  notes: z.string().trim().max(2000).nullable().optional(),
  sortOrder: z.number().int().default(0),
};

export const createIncomeVariantSchema = z.object(incomeVariantFields);

/** @typedef {z.infer<typeof createIncomeVariantSchema>} CreateIncomeVariantInput */

// Zod's `.partial()` keeps a field's `.default()`, so a PATCH that omits a
// defaulted key still writes that default — a single-field update would
// silently reset a variant's position in the list. The defaulted fields are
// respelled here without their defaults, the same way people.js and pay-
// schedules.js already do it, so "absent" means "leave alone".
// PATCH /income-variants/:id — all fields optional so a caller can send just
// one.
export const updateIncomeVariantSchema = z
  .object({ ...incomeVariantFields, sortOrder: z.number().int() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateIncomeVariantSchema>} UpdateIncomeVariantInput */
