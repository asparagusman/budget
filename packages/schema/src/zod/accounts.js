import { z } from "zod";
import { accountType } from "../tables/accounts.js";

// `external` requiring a null growth rate and rejecting balance snapshots is
// a semantic rule, not a shape rule, so it's checked in the route handler,
// not here (phases/04-accounts-people.md "Constraints to enforce...").
const accountFields = {
  name: z.string().trim().min(1, "Name is required").max(160),
  type: z.enum(accountType.enumValues),
  institution: z.string().trim().max(160).nullable().optional(),
  isIncomeLanding: z.boolean().default(false),
  // A fraction, not a percentage: 0.050325 is 5.0325% p.a. Capped at 1
  // (100% p.a.) — a growth assumption above that is a typo, not a return.
  annualGrowthRate: z.number().min(0).max(1).nullable().optional(),
  sortOrder: z.number().int().default(0),
};

export const createAccountSchema = z.object(accountFields);

/** @typedef {z.infer<typeof createAccountSchema>} CreateAccountInput */

// Zod's `.partial()` keeps a field's `.default()`, so a PATCH that omits a
// defaulted key still writes that default — a single-field update would
// silently reset the income-landing flag and the sort order. The defaulted
// fields are respelled here without their defaults, the same way people.js
// and pay-schedules.js already do it, so "absent" means "leave alone".
// PATCH /accounts/:id — all fields optional so a caller can send just one.
export const updateAccountSchema = z
  .object({ ...accountFields, isIncomeLanding: z.boolean(), sortOrder: z.number().int() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateAccountSchema>} UpdateAccountInput */
