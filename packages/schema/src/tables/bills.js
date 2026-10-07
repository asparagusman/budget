import { boolean, date, integer, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.js";
import { costCategories } from "./cost-categories.js";
import { cadence } from "./pay-schedules.js";
import { people } from "./people.js";

// Resolution order (phases/06-fixed-costs.md "Amount models", implemented in
// packages/engine/src/bills.js): baseAmountCents -> the latest applicable
// stepChange replaces it outright -> the model's own modifier applies to
// that base -> a stored instance with isOverride beats all of the above.
export const amountModel = pgEnum("amount_model", ["flat", "seasonal", "rolling_average", "escalating"]);

export const bills = pgTable("bills", {
  id: uuid("id").primaryKey().defaultRandom(),
  categoryId: uuid("category_id")
    .notNull()
    .references(() => costCategories.id),
  name: text("name").notNull(),
  // Null = shared/household, same convention as income lines never having a
  // "shared" person row.
  ownerPersonId: uuid("owner_person_id").references(() => people.id),
  paidFromAccountId: uuid("paid_from_account_id").references(() => accounts.id),
  baseAmountCents: integer("base_amount_cents").notNull(),
  // Column named `frequency` (matching phases/06-fixed-costs.md's schema)
  // even though it reuses pay-schedules.js's `cadence` enum type — a bill's
  // own vocabulary, same enum values.
  frequency: cadence("frequency").notNull(),
  // A known due date; projectInstances derives the whole series from it, the
  // same "anchor + cadence, never a stored occurrence list" rule as pay
  // schedules (phases/04-accounts-people.md).
  anchorDate: date("anchor_date").notNull(),
  // False while `anchorDate` is a placeholder rather than a real due date.
  // The source workbook has no due dates at all, so the importer anchors
  // every bill it creates to one date the operator picked, and the calendar,
  // the bills buffer, the balance curve and the contribution window are all
  // computed from it. The dashboard keeps saying so until each one is set
  // (routes/bills.js flips it on a changed date, or on an explicit confirm).
  // Defaults to true: a bill entered by hand was entered with its real date.
  dueDateConfirmed: boolean("due_date_confirmed").notNull().default(true),
  amountModel: amountModel("amount_model").notNull().default("flat"),
  // 'escalating' only — % per year.
  escalationPct: numeric("escalation_pct", { precision: 5, scale: 2, mode: "number" }),
  // 'rolling_average' only — N past actuals to average.
  rollingWindow: integer("rolling_window"),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});
