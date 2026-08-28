import { mustAt, projectPaydays } from "@budget/engine";
import {
  createPayScheduleSchema,
  paySchedules,
  previewPayScheduleQuerySchema,
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
      // pay_schedules.is_primary is the actual guarantee under a race.
      if (data.isPrimary) {
        const existing = await db.$count(paySchedules, eq(paySchedules.isPrimary, true));
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
        const existing = await db.$count(paySchedules, and(eq(paySchedules.isPrimary, true), ne(paySchedules.id, id)));
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
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const [archived] = await db
        .update(paySchedules)
        .set({ archivedAt: new Date() })
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
      });
      return c.json({ ok: true });
    })

    // IsoDate[] via the engine's projectPaydays — no payday list is ever
    // stored, this derives it live from anchorDate + cadence (phases/
    // 04-accounts-people.md "Semantics worth stating plainly").
    .get(
      "/:id/preview",
      zValidator("query", previewPayScheduleQuerySchema, handleValidation),
      async (c) => {
        const id = c.req.param("id");
        const { from, to } = c.req.valid("query");

        const schedule = await db.query.paySchedules.findFirst({
          where: (p, { eq: eqCol }) => eqCol(p.id, id),
        });
        if (!schedule) {
          return c.json({ error: { code: "not_found", message: "Pay schedule not found." } }, 404);
        }

        const paydays = projectPaydays({ anchorDate: schedule.anchorDate, cadence: schedule.cadence }, { from, to });
        return c.json({ paydays });
      },
    );
}
