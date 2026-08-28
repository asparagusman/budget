import { mustAt } from "@budget/engine";
import {
  allocationPlans,
  createIncomeVariantSchema,
  incomeLines,
  incomeVariants,
  updateIncomeVariantSchema,
  variantSchedule,
} from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { getPrimaryPayCadence, serializeVariant } from "../lib/income.js";
import { handleValidation } from "../lib/validation.js";

/**
 * @param {import("@budget/schema").Db} db
 * @param {string} variantId
 */
async function linesFor(db, variantId) {
  return db.query.incomeLines.findMany({
    where: (l, { eq: eqCol }) => eqCol(l.variantId, variantId),
    orderBy: (l, { asc }) => [asc(l.sortOrder)],
  });
}

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createIncomeVariantsRoutes({ db }) {
  const app = new Hono();

  return app
    // Variants with lines and computed totals — one request for the whole
    // /income screen (phases/05-income.md "API"). `hasPrimaryPaySchedule`
    // lets the UI show the "set a primary pay schedule" prompt without a
    // second round trip.
    .get("/", async (c) => {
      const payCadence = await getPrimaryPayCadence(db);
      const rows = await db.query.incomeVariants.findMany({
        where: (v, { isNull: isNullCol }) => isNullCol(v.archivedAt),
        orderBy: (v, { asc }) => [asc(v.sortOrder), asc(v.name)],
      });
      const variants = [];
      for (const variant of rows) {
        variants.push(serializeVariant(variant, await linesFor(db, variant.id), payCadence));
      }
      return c.json({ variants, hasPrimaryPaySchedule: payCadence !== null });
    })

    .post("/", zValidator("json", createIncomeVariantSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");
      const created = await db.insert(incomeVariants).values(data).returning();
      const variant = mustAt(created, 0, "created income variant");

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "income_variant.create",
        entityType: "income_variant",
        entityId: variant.id,
        metadata: data,
      });

      return c.json({ variant: serializeVariant(variant, [], await getPrimaryPayCadence(db)) }, 201);
    })

    // The direct answer to the flat-variant limitation (phases/05-income.md
    // "Objective") — how the operator builds the next leave phase from the
    // current one without retyping every line.
    .post("/:id/duplicate", async (c) => {
      const id = c.req.param("id");
      const source = await db.query.incomeVariants.findFirst({ where: (v, { eq: eqCol }) => eqCol(v.id, id) });
      if (!source) {
        return c.json({ error: { code: "not_found", message: "Income variant not found." } }, 404);
      }
      const sourceLines = await linesFor(db, id);

      // One transaction so a failure partway through never leaves a variant
      // with only some of its lines copied.
      const duplicate = await db.transaction(async (tx) => {
        const createdVariants = await tx
          .insert(incomeVariants)
          .values({ name: `${source.name} (copy)`, notes: source.notes, sortOrder: source.sortOrder })
          .returning();
        const newVariant = mustAt(createdVariants, 0, "duplicated income variant");

        if (sourceLines.length > 0) {
          await tx.insert(incomeLines).values(
            sourceLines.map((line) => ({
              variantId: newVariant.id,
              personId: line.personId,
              label: line.label,
              amountCents: line.amountCents,
              cadence: line.cadence,
              notes: line.notes,
              sortOrder: line.sortOrder,
            })),
          );
        }
        return newVariant;
      });

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "income_variant.duplicate",
        entityType: "income_variant",
        entityId: duplicate.id,
        metadata: { sourceId: id },
      });

      const payCadence = await getPrimaryPayCadence(db);
      return c.json({ variant: serializeVariant(duplicate, await linesFor(db, duplicate.id), payCadence) }, 201);
    })

    .patch("/:id", zValidator("json", updateIncomeVariantSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");
      const [updated] = await db.update(incomeVariants).set(data).where(eq(incomeVariants.id, id)).returning();
      if (!updated) {
        return c.json({ error: { code: "not_found", message: "Income variant not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "income_variant.update",
        entityType: "income_variant",
        entityId: id,
        metadata: data,
      });

      return c.json({ variant: serializeVariant(updated, await linesFor(db, id), await getPrimaryPayCadence(db)) });
    })

    // Archive, never a hard delete. A variant referenced by the schedule or
    // by an allocation plan must not vanish out from under it — refused with
    // a message naming what references it (phases/05-income.md "Acceptance
    // criteria").
    .delete("/:id", async (c) => {
      const id = c.req.param("id");

      const scheduleCount = await db.$count(variantSchedule, eq(variantSchedule.variantId, id));
      if (scheduleCount > 0) {
        return c.json(
          {
            error: {
              code: "referenced",
              message: `This variant is used by ${scheduleCount} schedule ${scheduleCount === 1 ? "entry" : "entries"} — remove ${scheduleCount === 1 ? "it" : "them"} from the timeline first.`,
            },
          },
          400,
        );
      }

      // An allocation plan's whole reason for existing is the variant it
      // divides, so archiving one out from under it would leave a plan
      // computing against nothing.
      const planCount = await db.$count(
        allocationPlans,
        and(eq(allocationPlans.incomeVariantId, id), isNull(allocationPlans.archivedAt)),
      );
      if (planCount > 0) {
        return c.json(
          {
            error: {
              code: "referenced",
              message: `This variant is used by ${planCount} allocation plan${planCount === 1 ? "" : "s"} — archive ${planCount === 1 ? "it" : "them"} first.`,
            },
          },
          400,
        );
      }

      const [archived] = await db
        .update(incomeVariants)
        .set({ archivedAt: new Date() })
        .where(and(eq(incomeVariants.id, id), isNull(incomeVariants.archivedAt)))
        .returning();
      if (!archived) {
        return c.json({ error: { code: "not_found", message: "Income variant not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "income_variant.archive",
        entityType: "income_variant",
        entityId: id,
      });

      return c.json({ ok: true });
    });
}
