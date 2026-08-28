import { integer, numeric, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { bills } from "./bills.js";

// 'seasonal' bills only. Always written as a full set of 12 rows in one call
// (PUT /bills/:id/seasonal-factors) — never partially, so there is no
// "missing month" state to migrate around, only "no row for this month yet"
// which the engine's `computeExpectedCents` already treats as factor 1.
export const billSeasonalFactors = pgTable(
  "bill_seasonal_factors",
  {
    billId: uuid("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    month: integer("month").notNull(),
    factor: numeric("factor", { precision: 6, scale: 4, mode: "number" }).notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.billId, table.month] })],
);
