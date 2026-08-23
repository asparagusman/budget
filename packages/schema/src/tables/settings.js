import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Free-form key/value store: theme, currency/locale, primary pay schedule,
// bills buffer, history lookback, etc. Later phases add rows; this table
// itself never grows new columns for individual settings.
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
