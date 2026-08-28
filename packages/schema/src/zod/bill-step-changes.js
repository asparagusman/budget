import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const billStepChangeFields = {
  effectiveFrom: isoDate,
  newAmountCents: z.number().int(),
  note: z.string().trim().max(500).nullable().optional(),
};

// POST /bills/:id/step-changes — `billId` comes from the URL, not the body.
export const createBillStepChangeSchema = z.object(billStepChangeFields);

/** @typedef {z.infer<typeof createBillStepChangeSchema>} CreateBillStepChangeInput */

// PATCH /bill-step-changes/:id — top-level, same shape as balances.js's
// DELETE /balances/:id (phases/06-fixed-costs.md "API"): a step change is
// edited or removed by its own id, not nested under the bill.
export const updateBillStepChangeSchema = z
  .object(billStepChangeFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateBillStepChangeSchema>} UpdateBillStepChangeInput */
