import { boolean, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Shared by fixed costs (this phase) and variable costs (phase 07) — one
// enum, one table, both phases' categories live side by side and a screen
// can query either slice with `?kind=`.
export const costKind = pgEnum("cost_kind", ["fixed", "variable"]);

export const costCategories = pgTable("cost_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  // e.g. "Entertainment", "Utilities", "Rent", "Car".
  name: text("name").notNull(),
  kind: costKind("kind").notNull(),
  // Read by phase 07 to separate essential from discretionary variable
  // spend; every fixed-cost category is essential by definition, hence the
  // default rather than a per-row choice on this phase's screens.
  isEssential: boolean("is_essential").notNull().default(true),
  // Token name (e.g. "chart-line-2"), never a hex literal — see phases/
  // README.md "Aesthetic target".
  colour: text("colour"),
  sortOrder: integer("sort_order").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});
