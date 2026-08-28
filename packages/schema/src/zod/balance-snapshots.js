import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

// POST /accounts/:id/balances — the route upserts on (accountId, asAt)
// rather than erroring on a repeat date, so there's no separate update
// schema (phases/04-accounts-people.md "Acceptance criteria").
export const createBalanceSnapshotSchema = z.object({
  asAt: isoDate,
  amountCents: z.number().int(),
  note: z.string().trim().max(500).nullable().optional(),
});

/** @typedef {z.infer<typeof createBalanceSnapshotSchema>} CreateBalanceSnapshotInput */
