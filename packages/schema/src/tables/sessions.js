import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

// One row per signed-in browser — which is to say, per approved device. The
// cookie carries a random token; only its SHA-256 hash is ever stored, so a
// database dump grants no access on its own. `lastSeenAt` is refreshed at
// most once an hour (see apps/api's lib/session.js) to keep this table's
// writes down.
//
// How the browser holding this session got in. A closed set, so it is an
// enum (phases/README.md "Database").
//
// `device` is a device someone approved (or the household's first, at
// bootstrap). `recovery_password` is deliberately not equal to it: a session
// opened with the recovery password reaches only the screens that get a
// device approved, and the middleware needs to be able to tell them apart on
// every request, not just at sign-in.
export const sessionAuthMethod = pgEnum("session_auth_method", ["device", "recovery_password"]);

/** @typedef {(typeof sessionAuthMethod.enumValues)[number]} SessionAuthMethod */

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  authMethod: sessionAuthMethod("auth_method").notNull().default("device"),
  // What the household calls this device ("Grace's phone"). Typed on the
  // device when it asked to join, or guessed from its User-Agent.
  deviceName: text("device_name"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
