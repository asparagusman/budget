import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// A named income scenario — "Usual", "PL Gov (High)", "PL Torch (Low)" — the
// household is going through parental leave and its income changes in
// phases, so variants stay the unit of thought exactly as in the source
// spreadsheet (phases/05-income.md "Objective").
//
// Deliberately flat: a variant's lines carry no dates of their own. If one
// person's leave phase starts part-way through another's, that combination
// gets its own variant rather than a date range on incomeLines — see
// phases/05-income.md "A known limitation, stated deliberately". Do not
// "fix" this by adding start/end dates here or to income-lines.js.
export const incomeVariants = pgTable("income_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});
