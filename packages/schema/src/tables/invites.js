import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/** @typedef {'new_user' | 'new_device'} InvitePurpose */

// Single-use, 24h-expiry invite codes — the only way to register after
// bootstrap. Like sessions, only the SHA-256 hash of the raw code is stored;
// the raw code is shown once in the UI (or printed once by the CLI recovery
// command) and never persisted anywhere.
export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  codeHash: text("code_hash").notNull().unique(),
  // 'new_user' | 'new_device' (InvitePurpose above) — plain text rather than
  // a pg enum since this list is closed and tiny and Zod already validates
  // it at every write (see zod/invites.js).
  purpose: text("purpose").notNull(),
  // Set for 'new_device' — the existing user the new passkey attaches to.
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
