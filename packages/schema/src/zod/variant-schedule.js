import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const variantScheduleFields = {
  startsOn: isoDate,
  endsOn: isoDate.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
};

// POST /variant-schedule — `variantId` only appears here, same reasoning as
// income-lines.js: which variant a schedule entry names is how it's placed,
// not an attribute you edit afterwards.
export const createVariantScheduleSchema = z.object({
  variantId: z.string().uuid(),
  ...variantScheduleFields,
});

/** @typedef {z.infer<typeof createVariantScheduleSchema>} CreateVariantScheduleInput */

// PATCH /variant-schedule/:id — all fields optional so a caller can send
// just one.
export const updateVariantScheduleSchema = z
  .object(variantScheduleFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateVariantScheduleSchema>} UpdateVariantScheduleInput */

export const resolveVariantQuerySchema = z.object({
  on: isoDate,
});

/** @typedef {z.infer<typeof resolveVariantQuerySchema>} ResolveVariantQuery */
