import { date, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bills } from "./bills.js";

// A step change is a new base from `effectiveFrom` onward — it *replaces*
// baseAmountCents rather than modifying it (phases/06-fixed-costs.md
// "Amount models"). Hard delete, same reasoning as a balance snapshot or a
// variant-schedule entry: genuinely disposable, edited or removed directly
// as the operator corrects the timeline (phases/README.md "Database").
export const billStepChanges = pgTable(
  "bill_step_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    billId: uuid("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    effectiveFrom: date("effective_from").notNull(),
    newAmountCents: integer("new_amount_cents").notNull(),
    note: text("note"),
  },
  (table) => [uniqueIndex("bill_step_changes_bill_id_effective_from_unique").on(table.billId, table.effectiveFrom)],
);
