import { z } from "zod";
import { allocationBasis } from "../tables/allocation.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const allocationPlanFields = {
  name: z.string().trim().min(1, "Name is required").max(160),
  incomeVariantId: z.string().uuid(),
};

export const createAllocationPlanSchema = z.object(allocationPlanFields);

/** @typedef {z.infer<typeof createAllocationPlanSchema>} CreateAllocationPlanInput */

// PATCH /allocation-plans/:id — all fields optional so a caller can send
// just one. Changing `incomeVariantId` is legitimate (the operator renamed
// or reorganised their variants) and never rewrites a version's own numbers.
export const updateAllocationPlanSchema = z
  .object(allocationPlanFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateAllocationPlanSchema>} UpdateAllocationPlanInput */

// `value`'s meaning depends on `basis` (percentage / cents per month /
// weight / ignored) — see packages/schema/src/tables/allocation.js. Which
// bases require it and which forbid it is a semantic rule rather than a
// shape rule, so it lives in apps/api/src/lib/allocation.js's
// `basisValueError`, the same split as bills' `amountModelFieldError`.
// `max` keeps a value inside numeric(12,4); negatives are rejected outright
// — an allocation line that takes money back out of a destination is not a
// thing this app models.
const allocationLineFields = {
  stage: z.number().int().min(1).max(99),
  label: z.string().trim().min(1, "Label is required").max(160),
  basis: z.enum(allocationBasis.enumValues),
  value: z.number().min(0).max(99_999_999).nullable(),
  goalPct: z.number().min(0).max(100).nullable().optional(),
  accountId: z.string().uuid(),
  sortOrder: z.number().int().default(0),
};

// PUT /allocation-versions/:id/lines — a bulk replace of one draft's lines,
// never a per-line PATCH. The editor holds the whole draft in memory and
// autosaves it, and a partial write would let a reorder or a stage move land
// half-applied.
export const replaceAllocationLinesSchema = z.object({
  lines: z.array(z.object(allocationLineFields)).max(200),
});

/** @typedef {z.infer<typeof replaceAllocationLinesSchema>} ReplaceAllocationLinesInput */

/** @typedef {z.infer<typeof replaceAllocationLinesSchema>["lines"][number]} AllocationLineInput */

// POST /allocation-plans/:id/draft/apply — the note is the operator's own
// "why", stored on the version that becomes active.
export const applyAllocationDraftSchema = z.object({
  note: z.string().trim().max(2000).nullable().optional(),
});

/** @typedef {z.infer<typeof applyAllocationDraftSchema>} ApplyAllocationDraftInput */

// GET /allocation/compute — `on` is optional and defaults to today in the
// handler (a schema-level default would freeze the date at module load).
// It lets the operator preview against a future date, so a plan can be
// checked against the income variant that will be active then rather than
// the one active today.
export const allocationComputeQuerySchema = z.object({
  versionId: z.string().uuid(),
  on: isoDate.optional(),
});

/** @typedef {z.infer<typeof allocationComputeQuerySchema>} AllocationComputeQuery */

export const allocationPreviewQuerySchema = z.object({
  planId: z.string().uuid(),
  on: isoDate.optional(),
});

/** @typedef {z.infer<typeof allocationPreviewQuerySchema>} AllocationPreviewQuery */
