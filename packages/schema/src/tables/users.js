import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Two humans, several devices each. `email` is an identifier only — nothing
// is ever sent to it, there is no password and no email-based recovery. See
// phases/03-auth.md for the full flow.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  email: text("email").unique(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
