import { boolean, date, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bills } from "./bills.js";

// Holds a row only when there is something a projection cannot reproduce: a
// past instance with an entered `actualCents`, a future instance with a
// manual `isOverride` amount, or an instance marked `paidOn`. Everything
// else is projected on read by the engine's `projectInstances` — there is no
// cron job materialising the full future series into this table (phases/
// 06-fixed-costs.md "Instance storage — store only what must be
// remembered"). Never hard-deleted by anchorDate/frequency changes: an
// orphaned row is real history and stays, flagged, not discarded (same doc,
// "Orphaned instances").
export const billInstances = pgTable(
  "bill_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    billId: uuid("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    dueDate: date("due_date").notNull(),
    // Snapshot of the projection at entry time — nullable because a bare
    // `actualCents` entry (the common case, from the history screen) never
    // needs one; only an `isOverride` row carries a meaningful value here.
    expectedCents: integer("expected_cents"),
    actualCents: integer("actual_cents"),
    paidOn: date("paid_on"),
    isOverride: boolean("is_override").notNull().default(false),
    note: text("note"),
  },
  (table) => [uniqueIndex("bill_instances_bill_id_due_date_unique").on(table.billId, table.dueDate)],
);
