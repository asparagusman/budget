import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Two humans, several devices each. `email` is an identifier only — nothing
// is ever sent to it, and there is no email-based recovery. See
// phases/03-auth.md for the full flow.
//
// A device gets in by being approved from a device that is already in (see
// device-requests.js). Exactly one user may also hold a RECOVERY password,
// and it does exactly one job: get someone far enough in to approve a device
// when every approved device is gone. A session opened with it is marked as
// such and is confined to the recovery surface (see sessions.authMethod and
// middleware/auth.js), so it can never be used to read a figure directly.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name").notNull(),
    email: text("email").unique(),
    isActive: boolean("is_active").notNull().default(true),
    // scrypt, salted per user, in the `scrypt$N$r$p$salt$hash` format
    // apps/api/src/lib/password.js writes and reads. Null for every user
    // without one, which is all of them until someone sets it.
    recoveryPasswordHash: text("recovery_password_hash"),
    recoveryPasswordSetAt: timestamp("recovery_password_set_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // At most one recovery password in the household, enforced here rather
    // than only in the route — the same partial-unique-index trick
    // `accounts.is_income_landing` uses. One password is a door the operator
    // can keep track of; a second is one they cannot.
    uniqueIndex("users_recovery_password_unique")
      .on(sql`((${table.recoveryPasswordHash} IS NOT NULL))`)
      .where(sql`${table.recoveryPasswordHash} is not null`),
  ],
);
