import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { incomeVariants } from "./income-variants.js";
import { cadence } from "./pay-schedules.js";
import { people } from "./people.js";

// One row per person's income within a variant — "Salary", "Gov PPL",
// "Employer PPL (half pay)". No archivedAt: a line is edited or removed
// freely as part of shaping its variant (phases/05-income.md "Schema"); only
// the variant itself is archived. `cadence` reuses pay-schedules.js's enum
// rather than redeclaring it — Postgres enums are a single global type, and
// this is the same union as packages/engine's `Cadence`.
export const incomeLines = pgTable("income_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => incomeVariants.id, { onDelete: "cascade" }),
  personId: uuid("person_id")
    .notNull()
    .references(() => people.id),
  label: text("label"),
  amountCents: integer("amount_cents").notNull(),
  cadence: cadence("cadence").notNull(),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
});
