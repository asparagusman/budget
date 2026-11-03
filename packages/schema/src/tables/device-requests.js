import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

// A browser asking to be let in. It is how every device after the first gets
// a session: the new device creates one of these and shows its `code`, and a
// member on a device that is already signed in approves it, choosing whose
// device it is. The new device's next poll then turns the approved row into a
// session and deletes it — so a row only ever exists while someone is waiting.
//
// The requesting browser holds a random token in a cookie; like sessions, only
// its SHA-256 hash is stored. `code` is not a secret. It is shown on both
// screens so the approver can tell which waiting device is which.
export const deviceRequests = pgTable("device_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  code: text("code").notNull(),
  deviceName: text("device_name").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Set together, by the approval. Null while the request is still waiting.
  approvedUserId: uuid("approved_user_id").references(() => users.id, {
    onDelete: "cascade",
  }),
  approvedBy: uuid("approved_by").references(() => users.id, {
    onDelete: "set null",
  }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
});
