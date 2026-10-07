import { z } from "zod";
import { amountModel } from "../tables/bills.js";
import { cadence } from "../tables/pay-schedules.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

// Whether `escalationPct`/`rollingWindow` are required, forbidden or
// optional depends on `amountModel` — a semantic rule, not a shape rule, so
// it's checked in the route handler (see apps/api/src/lib/bills.js), not
// here (same split as accounts.js's `external` check).
const billFields = {
  categoryId: z.string().uuid(),
  name: z.string().trim().min(1, "Name is required").max(160),
  ownerPersonId: z.string().uuid().nullable().optional(),
  paidFromAccountId: z.string().uuid().nullable().optional(),
  baseAmountCents: z.number().int(),
  frequency: z.enum(cadence.enumValues),
  anchorDate: isoDate,
  amountModel: z.enum(amountModel.enumValues).default("flat"),
  escalationPct: z.number().min(0).max(100).nullable().optional(),
  rollingWindow: z.number().int().min(1).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  sortOrder: z.number().int().default(0),
};

export const createBillSchema = z.object(billFields);

/** @typedef {z.infer<typeof createBillSchema>} CreateBillInput */

// Zod's `.partial()` keeps a field's `.default()`, so a PATCH that omits a
// defaulted key still writes that default — a single-field update would
// silently reset a seasonal bill's amount model back to flat. The defaulted
// fields are respelled here without their defaults, the same way people.js
// and pay-schedules.js already do it, so "absent" means "leave alone".
// PATCH /bills/:id — all fields optional so a caller can send just one.
//
// `dueDateConfirmed` is update-only and has no default, for the same reason:
// absent means "leave it alone". A changed `anchorDate` confirms the date on
// its own (routes/bills.js); sending `true` is how the operator says the
// imported placeholder happens to be the real date after all.
export const updateBillSchema = z
  .object({
    ...billFields,
    amountModel: z.enum(amountModel.enumValues),
    sortOrder: z.number().int(),
    dueDateConfirmed: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateBillSchema>} UpdateBillInput */
