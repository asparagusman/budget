import { sql } from "drizzle-orm";
import { boolean, date, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { people } from "./people.js";

// Values match packages/engine's `Cadence` union verbatim (see
// packages/engine/src/cadence.js) — never reintroduce "bimonthly";
// `every_2_months` exists specifically to kill that ambiguity.
export const cadence = pgEnum("cadence", [
  "weekly",
  "fortnightly",
  "monthly",
  "every_2_months",
  "quarterly",
  "every_6_months",
  "yearly",
]);

export const paySchedules = pgTable(
  "pay_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    // Any known payday — the engine's `projectPaydays` derives the whole
    // series from this. No payday list is ever stored (phases/
    // 04-accounts-people.md "Semantics worth stating plainly").
    anchorDate: date("anchor_date").notNull(),
    cadence: cadence("cadence").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    // At most one primary pay schedule — the schedule that defines the
    // household's transfer cycle (phase 08).
    uniqueIndex("pay_schedules_primary_unique").on(table.isPrimary).where(sql`${table.isPrimary}`),
  ],
);
