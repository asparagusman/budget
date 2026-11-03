import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

// A closed set, so the database is what closes it — see phases/README.md
// "Database". It was `text` + Zod through phases 03 and 04, which left the
// repo with both patterns live and unreconciled (todo.md `[P04-2]`); the
// ruling went to the enum, because `auth:invite` and any psql session write
// this column without passing through a Zod schema.
export const invitePurpose = pgEnum("invite_purpose", ["new_user", "new_device"]);

/** @typedef {(typeof invitePurpose.enumValues)[number]} InvitePurpose */

// Single-use, 24h-expiry invite codes — the only way to register after
// bootstrap. Like sessions, only the SHA-256 hash of the raw code is stored;
// the raw code is shown once in the UI (or printed once by the CLI recovery
// command) and never persisted anywhere.
export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  codeHash: text("code_hash").notNull().unique(),
  purpose: invitePurpose("purpose").notNull(),
  // Set for 'new_device' — the existing user the new device signs in as.
  targetUserId: uuid("target_user_id").references(() => users.id, {
    onDelete: "cascade",
  }),
  // Null when minted by the CLI recovery command rather than a logged-in
  // user — see phases/03-auth.md "Recovery".
  createdBy: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});
