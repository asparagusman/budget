import { z } from "zod";
import { goalStatus, targetMode } from "../tables/goals.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

// Which target field is required depends on `targetMode` — a semantic rule
// rather than a shape rule, so it lives in apps/api/src/lib/goals.js's
// `targetModeFieldError` (the same split as bills' `amountModelFieldError`),
// which is also where the "external accounts can't have goals" check sits.
const goalFields = {
  accountId: z.string().uuid(),
  name: z.string().trim().min(1, "Name is required").max(160),
  targetMode: z.enum(targetMode.enumValues).default("amount"),
  targetAmountCents: z.number().int().min(0).nullable().optional(),
  targetMonths: z.number().min(0).max(999).nullable().optional(),
  targetDate: isoDate.nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(goalStatus.enumValues).default("active"),
};

export const createGoalSchema = z.object(goalFields);

/** @typedef {z.infer<typeof createGoalSchema>} CreateGoalInput */

// Zod's `.partial()` keeps a field's `.default()`, so a PATCH that omits a
// defaulted key still writes that default — a single-field update would
// silently reset a months-of-expenses goal's mode and an achieved goal's
// status. The defaulted fields are respelled here without their defaults,
// the same way people.js and pay-schedules.js already do it, so "absent"
// means "leave alone".
// PATCH /goals/:id — all fields optional so a caller can send just one.
export const updateGoalSchema = z
  .object({
    ...goalFields,
    targetMode: z.enum(targetMode.enumValues),
    status: z.enum(goalStatus.enumValues),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateGoalSchema>} UpdateGoalInput */

// GET /goals?on= — the date every projection is computed from. Optional, and
// defaulted to today in the handler; a schema-level default would freeze the
// date at module load.
export const goalsQuerySchema = z.object({
  on: isoDate.optional(),
});

/** @typedef {z.infer<typeof goalsQuerySchema>} GoalsQuery */

export const netWorthQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
});

/** @typedef {z.infer<typeof netWorthQuerySchema>} NetWorthQuery */

// GET /projections?months= — how far the compound-growth table and chart run.
// 60 months is the spreadsheet's own longest column; the cap is well past it
// rather than at it, since the horizon is the operator's to choose.
export const projectionsQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(600).default(60),
  on: isoDate.optional(),
});

/** @typedef {z.infer<typeof projectionsQuerySchema>} ProjectionsQuery */
