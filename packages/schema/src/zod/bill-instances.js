import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

export const listBillInstancesQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  // Both optional; leaving them off is the original every-active-bill list.
  // The bill detail sheet needs ONE bill's orphaned rows across all time, and
  // without these it had the server project every active bill over
  // 2000–2100 (~40k objects) only to throw all but a handful away in the
  // browser (.claude/plans/perf-inp-plan.md, P2 #6).
  billId: z.string().uuid().optional(),
  orphansOnly: z.enum(["true", "false"]).optional(),
});

/** @typedef {z.infer<typeof listBillInstancesQuerySchema>} ListBillInstancesQuery */

// POST /bill-instances — materialises a stored row for a projected date that
// doesn't have one yet. Covers both things "Instance storage" (phases/
// 06-fixed-costs.md) lists as reasons a row exists: an override
// (`expectedCents` provided -> `isOverride` is set true by the route) and a
// plain "mark this projected date paid" from the calendar, which needs a row
// but never touches the projected amount (`expectedCents` omitted ->
// `isOverride` stays false).
export const createBillInstanceSchema = z.object({
  billId: z.string().uuid(),
  dueDate: isoDate,
  expectedCents: z.number().int().optional(),
  actualCents: z.number().int().nullable().optional(),
  paidOn: isoDate.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

/** @typedef {z.infer<typeof createBillInstanceSchema>} CreateBillInstanceInput */

// PATCH /bill-instances/:id — all fields optional so a caller can send just
// one. Setting `isOverride: true` here (rather than only via POST) lets the
// operator promote an existing stored actual into an override without
// re-entering it.
export const updateBillInstanceSchema = z
  .object({
    expectedCents: z.number().int().nullable(),
    actualCents: z.number().int().nullable(),
    paidOn: isoDate.nullable(),
    isOverride: z.boolean(),
    note: z.string().trim().max(500).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateBillInstanceSchema>} UpdateBillInstanceInput */
