import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

// GET /bills/:id/history?periods=N — the reverse-sequential entry scaffold
// (phases/06-fixed-costs.md "the entry scaffold"). 6 / 12 / 24 are the UI's
// preset options, but "custom" means any positive count, hence no `.max()`.
export const billHistoryQuerySchema = z.object({
  periods: z.coerce.number().int().min(1).default(6),
});

/** @typedef {z.infer<typeof billHistoryQuerySchema>} BillHistoryQuery */

// PUT /bills/:id/history — one bulk upsert of everything entered on the
// reverse-sequential screen. `actualCents: null` clears a previously entered
// slot rather than being rejected, since the operator may need to correct a
// mis-entry back to blank.
export const upsertBillHistorySchema = z.object({
  entries: z.array(
    z.object({
      dueDate: isoDate,
      actualCents: z.number().int().nullable(),
    }),
  ),
});

/** @typedef {z.infer<typeof upsertBillHistorySchema>} UpsertBillHistoryInput */
