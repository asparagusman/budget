import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// One row per household member. Deliberately small and standalone — pay
// schedules (this phase) and income lines (phase 05) hang off a person by
// id; nothing about who the people are is hardcoded anywhere else.
export const people = pgTable("people", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});
