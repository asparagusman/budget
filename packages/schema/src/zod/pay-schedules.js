import { z } from "zod";
import { cadence } from "../tables/pay-schedules.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

export const createPayScheduleSchema = z.object({
  personId: z.string().uuid(),
  anchorDate: isoDate,
  cadence: z.enum(cadence.enumValues),
  isPrimary: z.boolean().default(false),
});

/** @typedef {z.infer<typeof createPayScheduleSchema>} CreatePayScheduleInput */

// PATCH /pay-schedules/:id — all fields optional so a caller can send just
// one. `personId` is deliberately not editable — reassigning a schedule to
// a different person reads as creating a new one, not editing this one.
export const updatePayScheduleSchema = z
  .object({
    anchorDate: isoDate,
    cadence: z.enum(cadence.enumValues),
    isPrimary: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updatePayScheduleSchema>} UpdatePayScheduleInput */

export const previewPayScheduleQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
});

/** @typedef {z.infer<typeof previewPayScheduleQuerySchema>} PreviewPayScheduleQuery */
