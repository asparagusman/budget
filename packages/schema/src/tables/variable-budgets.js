import { date, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { costCategories } from "./cost-categories.js";
import { cadence } from "./pay-schedules.js";

// Dated so a change of plan doesn't rewrite history — a new row is a new
// plan from `effectiveFrom` forward, it never edits an earlier row's own
// amount (phases/07-variable-costs.md "Schema"). The budget in force for a
// date is the latest row with `effectiveFrom <= date` (see the engine's
// `resolveVariableBudget`); the allocation always reads the *current* one.
// No `archivedAt` — a mistaken row is corrected or removed directly, same
// "genuinely disposable" reasoning as a bill step change.
export const variableBudgets = pgTable(
  "variable_budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => costCategories.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    cadence: cadence("cadence").notNull().default("monthly"),
    effectiveFrom: date("effective_from").notNull(),
    note: text("note"),
  },
  (table) => [
    uniqueIndex("variable_budgets_category_id_effective_from_unique").on(
      table.categoryId,
      table.effectiveFrom,
    ),
  ],
);
