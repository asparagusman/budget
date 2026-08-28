import { date, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { incomeVariants } from "./income-variants.js";

// Tells the app which variant is active on any given date — the calendar
// layer on top of the flat variants above (phases/05-income.md "Objective").
// No archivedAt: a schedule entry is genuinely disposable, edited or removed
// directly as the operator reshapes the timeline (phases/README.md
// "Database" — soft delete only where the operator might want a row back).
//
// `endsOn` null means open-ended — "this variant, from here on". The
// engine's `resolveVariant` (packages/engine/src/calendar.js) reads rows here
// as-is; it never picks a winner among overlapping entries and never
// silently assumes a variant across a gap.
export const variantSchedule = pgTable("variant_schedule", {
  id: uuid("id").primaryKey().defaultRandom(),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => incomeVariants.id, { onDelete: "cascade" }),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on"),
  notes: text("notes"),
});
