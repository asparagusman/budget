import { auditLog } from "@budget/schema";

/**
 * Every table with an operator-editable financial field gets an entry here
 * on write (phases/README.md "Database"); this phase's user/credential/
 * session/invite management is the first such writer. `actorId` is null
 * only for the CLI recovery command, which has no logged-in user.
 *
 * @param {import("@budget/schema").Db} db
 * @param {{
 *   actorId: string | null,
 *   action: string,
 *   entityType: string,
 *   entityId: string,
 *   metadata?: Record<string, unknown>,
 * }} entry
 */
export async function writeAuditLog(db, entry) {
  await db.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadata: entry.metadata ?? null,
  });
}
