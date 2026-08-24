import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bytea } from "./columns.js";
import { users } from "./users.js";

// One row per registered passkey (authenticator), not per user — a user has
// several devices. `credentialId` and `publicKey` come straight from
// @simplewebauthn/server's verification result; `counter` is the signature
// counter, persisted and checked on every assertion to detect a cloned
// authenticator.
export const credentials = pgTable("credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull().unique(),
  publicKey: bytea("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull().default(0),
  transports: text("transports").array(),
  deviceName: text("device_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});
