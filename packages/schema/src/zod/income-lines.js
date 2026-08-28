import { z } from "zod";
import { cadence } from "../tables/pay-schedules.js";

const incomeLineFields = {
  personId: z.string().uuid(),
  label: z.string().trim().max(160).nullable().optional(),
  amountCents: z.number().int(),
  cadence: z.enum(cadence.enumValues),
  notes: z.string().trim().max(2000).nullable().optional(),
  sortOrder: z.number().int().default(0),
};

// POST /income-lines — `variantId` only appears here: it's how the line is
// placed, not an attribute of it, so it's absent from the update schema
// below (same reasoning as pay-schedules.js's immutable `personId`).
export const createIncomeLineSchema = z.object({
  variantId: z.string().uuid(),
  ...incomeLineFields,
});

/** @typedef {z.infer<typeof createIncomeLineSchema>} CreateIncomeLineInput */

// Zod's `.partial()` keeps a field's `.default()`, so a PATCH that omits a
// defaulted key still writes that default — a single-field update would
// silently reset a line's position within its variant. The defaulted fields
// are respelled here without their defaults, the same way people.js and pay-
// schedules.js already do it, so "absent" means "leave alone".
// PATCH /income-lines/:id — all fields optional so a caller can send just
// one. No `variantId`: moving a line to a different variant reads as
// creating a new one there, not editing this one.
export const updateIncomeLineSchema = z
  .object({ ...incomeLineFields, sortOrder: z.number().int() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateIncomeLineSchema>} UpdateIncomeLineInput */
