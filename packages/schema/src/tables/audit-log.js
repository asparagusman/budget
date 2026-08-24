import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";

// Every table with an operator-editable financial field gets a row here on
// write (see phases/README.md "Database"). This phase is the first with
// writes worth auditing (user/credential/session/invite management) and
// every phase after reuses this same table rather than inventing its own.
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Null when the action was taken by the CLI recovery command rather than
  // a logged-in user (see phases/03-auth.md "Recovery").
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  // e.g. 'user.deactivate', 'credential.remove', 'invite.create'.
  action: text("action").notNull(),
  // e.g. 'user', 'credential', 'session', 'invite' — paired with entityId to
  // point at the affected row without a foreign key, since the entity table
  // varies per row.
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  // Free-form context (e.g. { displayName } for a deactivated user) — never
  // a raw secret: no session tokens, no invite codes, no credential bytes.
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
