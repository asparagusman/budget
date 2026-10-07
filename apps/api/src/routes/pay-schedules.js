import { mustAt } from "@budget/engine";
import {
  createPayScheduleSchema,
  paySchedules,
  updatePayScheduleSchema,
} from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, ne } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { isUniqueViolation } from "../lib/db-errors.js";
import { handleValidation } from "../lib/validation.js";

const PRIMARY_CONFLICT = {
  error: {
    code: "primary_conflict",
    message: "Another schedule is already the primary one.",
  },
};

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createPaySchedulesRoutes({ db }) {
  const app = new Hono();

  return app
    .get("/", async (c) => {
      const rows = await db.query.paySchedules.findMany({
        where: (p, { isNull: isNullCol }) => isNullCol(p.archivedAt),
        orderBy: (p, { asc }) => [asc(p.anchorDate)],
      });
      return c.json({ paySchedules: rows });
    })

    .post("/", zValidator("json", createPayScheduleSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");

      const person = await db.query.people.findFirst({
        where: (p, { eq: eqCol }) => eqCol(p.id, data.personId),
      });
      if (!person) {
        return c.json({ error: { code: "not_found", message: "Person not found." } }, 404);
      }

      // Pre-check for a friendly message; the partial unique index on
      // pay_schedules.is_primary is the actual guarantee under a race. Live
      // rows only, matching that index — an archived schedule is not the
      // primary one, whatever it used to be.
      if (data.isPrimary) {
        const existing = await db.$count(
          paySchedules,
          and(eq(paySchedules.isPrimary, true), isNull(paySchedules.archivedAt)),
        );
        if (existing > 0) return c.json(PRIMARY_CONFLICT, 400);
      }

      try {
        const created = await db.insert(paySchedules).values(data).returning();
        const schedule = mustAt(created, 0, "created pay schedule");

        await writeAuditLog(db, {
          actorId: getUserId(c),
          action: "pay_schedule.create",
          entityType: "pay_schedule",
          entityId: schedule.id,
          metadata: data,
        });

        return c.json({ paySchedule: schedule }, 201);
      } catch (err) {
        if (isUniqueViolation(err)) return c.json(PRIMARY_CONFLICT, 400);
        throw err;
      }
    })

    .patch("/:id", zValidator("json", updatePayScheduleSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");

      if (data.isPrimary) {
        const target = await db.query.paySchedules.findFirst({ where: (p, { eq: eqCol }) => eqCol(p.id, id) });
        // The index no longer covers archived rows, so it would let an archived
        // schedule hold the flag beside a live one — a primary nothing can see.
        if (target?.archivedAt) {
          return c.json(
            { error: { code: "archived", message: "An archived schedule can't be the primary one." } },
            400,
          );
        }
        const existing = await db.$count(
          paySchedules,
          and(eq(paySchedules.isPrimary, true), isNull(paySchedules.archivedAt), ne(paySchedules.id, id)),
        );
        if (existing > 0) return c.json(PRIMARY_CONFLICT, 400);
      }

      try {
        const [updated] = await db.update(paySchedules).set(data).where(eq(paySchedules.id, id)).returning();
        if (!updated) {
          return c.json({ error: { code: "not_found", message: "Pay schedule not found." } }, 404);
        }

        await writeAuditLog(db, {
          actorId: getUserId(c),
          action: "pay_schedule.update",
          entityType: "pay_schedule",
          entityId: id,
          metadata: data,
        });

        return c.json({ paySchedule: updated });
      } catch (err) {
        if (isUniqueViolation(err)) return c.json(PRIMARY_CONFLICT, 400);
        throw err;
      }
    })

    // Archive, never a hard delete — phase 05's income lines and phase 08's
    // allocation both key off a schedule's history.
    //
    // Archiving the primary schedule also gives up the primary flag. Left set,
    // it sat on a row every computation ignores while still being the reason
    // no other schedule could be made primary — and nothing on screen could
    // reach it to clear it.
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const current = await db.query.paySchedules.findFirst({
        where: (p, { and: andCol, eq: eqCol, isNull: isNullCol }) => andCol(eqCol(p.id, id), isNullCol(p.archivedAt)),
      });
      const [archived] = await db
        .update(paySchedules)
        .set({ archivedAt: new Date(), isPrimary: false })
        .where(and(eq(paySchedules.id, id), isNull(paySchedules.archivedAt)))
        .returning();
      if (!archived) {
        return c.json({ error: { code: "not_found", message: "Pay schedule not found." } }, 404);
      }
      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "pay_schedule.archive",
        entityType: "pay_schedule",
        entityId: id,
        metadata: { wasPrimary: current?.isPrimary ?? false },
      });
      return c.json({ ok: true });
    });
}
