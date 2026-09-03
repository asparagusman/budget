import { addDaysIso, mustAt, projectPaydays } from "@budget/engine";
import {
  billHistoryQuerySchema,
  billInstances,
  billSeasonalFactors,
  billStepChanges,
  bills,
  createBillSchema,
  createBillStepChangeSchema,
  replaceBillSeasonalFactorsSchema,
  updateBillSchema,
  upsertBillHistorySchema,
} from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { amountModelFieldError, loadBillModifiers } from "../lib/bills.js";
import { writeAuditLog } from "../lib/audit.js";
import { isUniqueViolation } from "../lib/db-errors.js";
import { todayIso } from "../lib/dates.js";
import { handleValidation } from "../lib/validation.js";

/**
 * @param {{ month: number, factor: number }[]} factorRows
 */
function factorsToRecord(factorRows) {
  return Object.fromEntries(factorRows.map((f) => [f.month, f.factor]));
}

/**
 * @param {import("@budget/schema").Db} db
 * @param {string} id
 */
async function loadBillWithModifiers(db, id) {
  const bill = await db.query.bills.findFirst({ where: (b, { eq: eqCol }) => eqCol(b.id, id) });
  if (!bill) return null;
  const { factorsByBill, stepChangesByBill, historyByBill } = await loadBillModifiers(db, [id]);
  return {
    ...bill,
    seasonalFactors: factorsToRecord(factorsByBill.get(id) ?? []),
    stepChanges: stepChangesByBill.get(id) ?? [],
    history: (historyByBill.get(id) ?? []).map((i) => ({
      dueDate: i.dueDate,
      actualCents: i.actualCents,
      expectedCents: i.expectedCents,
      isOverride: i.isOverride,
    })),
  };
}

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createBillsRoutes({ db }) {
  const app = new Hono();

  return app
    // Every active bill, each with its factors, step changes and entered
    // history embedded — one request for the /costs/fixed list, which
    // recomputes amount-model previews client-side via @budget/engine while
    // the operator is mid-edit (same "compute client-side from pure engine
    // output" pattern as the pay-schedule preview in admin settings).
    //
    // `history` is the whole reason a preview can be trusted: without the
    // entered actuals a `rolling_average` bill projects to its base, so the
    // screen would print an amount the server never budgets with. Only the
    // four columns `projectInstances` reads are sent, not the whole
    // instance row.
    .get("/", async (c) => {
      const rows = await db.query.bills.findMany({
        where: (b, { isNull: isNullCol }) => isNullCol(b.archivedAt),
        orderBy: (b, { asc }) => [asc(b.sortOrder), asc(b.name)],
      });
      const { factorsByBill, stepChangesByBill, historyByBill } = await loadBillModifiers(
        db,
        rows.map((r) => r.id),
      );
      const result = rows.map((row) => ({
        ...row,
        seasonalFactors: factorsToRecord(factorsByBill.get(row.id) ?? []),
        stepChanges: stepChangesByBill.get(row.id) ?? [],
        history: (historyByBill.get(row.id) ?? []).map((i) => ({
          dueDate: i.dueDate,
          actualCents: i.actualCents,
          expectedCents: i.expectedCents,
          isOverride: i.isOverride,
        })),
      }));
      return c.json({ bills: result });
    })

    .get("/:id", async (c) => {
      const id = c.req.param("id");
      const bill = await loadBillWithModifiers(db, id);
      if (!bill) {
        return c.json({ error: { code: "not_found", message: "Bill not found." } }, 404);
      }
      const recentInstances = await db.query.billInstances.findMany({
        where: (i, { eq: eqCol }) => eqCol(i.billId, id),
        orderBy: (i, { desc }) => [desc(i.dueDate)],
        limit: 12,
      });
      return c.json({ bill: { ...bill, recentInstances } });
    })

    .post("/", zValidator("json", createBillSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");

      const category = await db.query.costCategories.findFirst({
        where: (cat, { eq: eqCol }) => eqCol(cat.id, data.categoryId),
      });
      if (!category) {
        return c.json({ error: { code: "not_found", message: "Cost category not found." } }, 404);
      }

      const modelError = amountModelFieldError(data);
      if (modelError) {
        return c.json({ error: { code: "invalid_bill", message: modelError } }, 400);
      }

      const created = await db.insert(bills).values(data).returning();
      const bill = mustAt(created, 0, "created bill");

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "bill.create",
        entityType: "bill",
        entityId: bill.id,
        metadata: data,
      });

      return c.json({ bill: { ...bill, seasonalFactors: {}, stepChanges: [], history: [] } }, 201);
    })

    .patch("/:id", zValidator("json", updateBillSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");

      const current = await db.query.bills.findFirst({ where: (b, { eq: eqCol }) => eqCol(b.id, id) });
      if (!current) {
        return c.json({ error: { code: "not_found", message: "Bill not found." } }, 404);
      }

      const categoryId = data.categoryId;
      if (categoryId) {
        // Captured to a local: narrowing a property access doesn't survive
        // into the closure below (same reasoning as income-lines.js's PATCH
        // handler).
        const category = await db.query.costCategories.findFirst({
          where: (cat, { eq: eqCol }) => eqCol(cat.id, categoryId),
        });
        if (!category) {
          return c.json({ error: { code: "not_found", message: "Cost category not found." } }, 404);
        }
      }

      const modelError = amountModelFieldError({
        amountModel: data.amountModel ?? current.amountModel,
        escalationPct: "escalationPct" in data ? data.escalationPct : current.escalationPct,
        rollingWindow: "rollingWindow" in data ? data.rollingWindow : current.rollingWindow,
      });
      if (modelError) {
        return c.json({ error: { code: "invalid_bill", message: modelError } }, 400);
      }

      const [updated] = await db.update(bills).set(data).where(eq(bills.id, id)).returning();
      if (!updated) {
        return c.json({ error: { code: "not_found", message: "Bill not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "bill.update",
        entityType: "bill",
        entityId: id,
        metadata: data,
      });

      return c.json({ bill: await loadBillWithModifiers(db, id) });
    })

    // Archive, never a hard delete — bill_instances (real history) and
    // bill_step_changes/bill_seasonal_factors (real decisions the operator
    // made) must keep resolving to a name.
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const [archived] = await db
        .update(bills)
        .set({ archivedAt: new Date() })
        .where(and(eq(bills.id, id), isNull(bills.archivedAt)))
        .returning();
      if (!archived) {
        return c.json({ error: { code: "not_found", message: "Bill not found." } }, 404);
      }
      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "bill.archive",
        entityType: "bill",
        entityId: id,
      });
      return c.json({ ok: true });
    })

    // Always replaces the full 12-month curve in one call — never a partial
    // update (phases/06-fixed-costs.md "Schema"). `factors[0]` is January.
    .put(
      "/:id/seasonal-factors",
      zValidator("json", replaceBillSeasonalFactorsSchema, handleValidation),
      async (c) => {
        const billId = c.req.param("id");
        const { factors } = c.req.valid("json");

        const bill = await db.query.bills.findFirst({ where: (b, { eq: eqCol }) => eqCol(b.id, billId) });
        if (!bill) {
          return c.json({ error: { code: "not_found", message: "Bill not found." } }, 404);
        }

        const rows = await db.transaction(async (tx) => {
          const written = [];
          for (const [index, factor] of factors.entries()) {
            const [row] = await tx
              .insert(billSeasonalFactors)
              .values({ billId, month: index + 1, factor })
              .onConflictDoUpdate({
                target: [billSeasonalFactors.billId, billSeasonalFactors.month],
                set: { factor },
              })
              .returning();
            written.push(mustAt([row], 0, "seasonal factor"));
          }
          return written;
        });

        await writeAuditLog(db, {
          actorId: getUserId(c),
          action: "bill.seasonal_factors.replace",
          entityType: "bill",
          entityId: billId,
          metadata: { factors },
        });

        return c.json({ seasonalFactors: factorsToRecord(rows) });
      },
    )

    .post(
      "/:id/step-changes",
      zValidator("json", createBillStepChangeSchema, handleValidation),
      async (c) => {
        const billId = c.req.param("id");
        const data = c.req.valid("json");

        const bill = await db.query.bills.findFirst({ where: (b, { eq: eqCol }) => eqCol(b.id, billId) });
        if (!bill) {
          return c.json({ error: { code: "not_found", message: "Bill not found." } }, 404);
        }

        try {
          const created = await db
            .insert(billStepChanges)
            .values({ billId, ...data })
            .returning();
          const stepChange = mustAt(created, 0, "created step change");

          await writeAuditLog(db, {
            actorId: getUserId(c),
            action: "bill_step_change.create",
            entityType: "bill_step_change",
            entityId: stepChange.id,
            metadata: { billId, ...data },
          });

          return c.json({ stepChange }, 201);
        } catch (err) {
          if (isUniqueViolation(err)) {
            return c.json(
              {
                error: {
                  code: "duplicate_effective_date",
                  message: "This bill already has a step change effective from that date.",
                },
              },
              400,
            );
          }
          throw err;
        }
      },
    )

    // The reverse-sequential entry scaffold (phases/06-fixed-costs.md "the
    // entry scaffold"): walk backward from the most recent due date at or
    // before today. `from` is generously over-sized (366 days per period
    // plus slack) rather than exactly right, since it's cheap to over-fetch
    // occurrences and then take the last N — the alternative is duplicating
    // projectPaydays' own occurrence-interval table here just to size the
    // window precisely.
    .get("/:id/history", zValidator("query", billHistoryQuerySchema, handleValidation), async (c) => {
      const billId = c.req.param("id");
      const { periods } = c.req.valid("query");

      const bill = await db.query.bills.findFirst({ where: (b, { eq: eqCol }) => eqCol(b.id, billId) });
      if (!bill) {
        return c.json({ error: { code: "not_found", message: "Bill not found." } }, 404);
      }

      const today = todayIso();
      const window = { from: addDaysIso(today, -(periods * 366 + 30)), to: addDaysIso(today, 1) };
      const dueDates = projectPaydays({ anchorDate: bill.anchorDate, cadence: bill.frequency }, window);
      const newestFirst = dueDates.slice(-periods).reverse();

      const historyRows = await db.query.billInstances.findMany({
        where: (i, { eq: eqCol }) => eqCol(i.billId, billId),
      });
      const actualByDate = new Map(historyRows.map((r) => [r.dueDate, r.actualCents]));

      const slots = newestFirst.map((dueDate, index) => ({
        ordinal: index + 1,
        label: index === 0 ? "Previous bill" : `${index + 1} bills ago`,
        dueDate,
        actualCents: actualByDate.get(dueDate) ?? null,
      }));

      return c.json({ billId, slots });
    })

    // One bulk upsert of everything entered on the history screen — a single
    // transaction so a failure partway through never leaves some slots saved
    // and others not (phases/06-fixed-costs.md "Save is a single bulk
    // upsert").
    .put("/:id/history", zValidator("json", upsertBillHistorySchema, handleValidation), async (c) => {
      const billId = c.req.param("id");
      const { entries } = c.req.valid("json");

      const bill = await db.query.bills.findFirst({ where: (b, { eq: eqCol }) => eqCol(b.id, billId) });
      if (!bill) {
        return c.json({ error: { code: "not_found", message: "Bill not found." } }, 404);
      }

      const saved = await db.transaction(async (tx) => {
        const written = [];
        for (const entry of entries) {
          const [row] = await tx
            .insert(billInstances)
            .values({ billId, dueDate: entry.dueDate, actualCents: entry.actualCents })
            .onConflictDoUpdate({
              target: [billInstances.billId, billInstances.dueDate],
              set: { actualCents: entry.actualCents },
            })
            .returning();
          written.push(mustAt([row], 0, "bill instance"));
        }
        return written;
      });

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "bill_history.upsert",
        entityType: "bill",
        entityId: billId,
        metadata: { entries },
      });

      return c.json({ billInstances: saved });
    });
}
