import { date, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { costCategories } from "./cost-categories.js";

// One row per category per pay cycle actually entered — `cycleStart` is the
// natural key, derived from the primary pay schedule via the engine's
// `resolveCycle`; cycles are never stored as their own rows (phases/
// 07-variable-costs.md "Schema"). `amountCents` is NOT NULL: a cycle with
// nothing entered has no row at all, never a stored zero — the bulk-upsert
// route deletes the row instead when the operator clears a cell.
//
// If the primary pay schedule's anchor changes, a stored `cycleStart` may no
// longer land on a payday under the new schedule. That row is never deleted
// or remapped automatically — `GET /variable-actuals` flags it
// `isOrphanCycle: true` and leaves discarding it to the operator, same rule
// as orphaned bill instances (phases/06-fixed-costs.md).
export const variableActuals = pgTable(
  "variable_actuals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => costCategories.id, { onDelete: "cascade" }),
    cycleStart: date("cycle_start").notNull(),
    amountCents: integer("amount_cents").notNull(),
    note: text("note"),
  },
  (table) => [
    uniqueIndex("variable_actuals_category_id_cycle_start_unique").on(
      table.categoryId,
      table.cycleStart,
    ),
  ],
);
