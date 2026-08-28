import { mustAt } from "@budget/engine";
import { billInstances, createBillInstanceSchema, listBillInstancesQuerySchema, updateBillInstanceSchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { loadBillModifiers, projectBillInWindow, toEngineBill } from "../lib/bills.js";
import { handleValidation } from "../lib/validation.js";

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createBillInstancesRoutes({ db }) {
  const app = new Hono();

  return app
    // Merged projected + stored across every active bill, one flat list
    // sorted by due date, `isOrphan` flagging any stored row whose date no
    // longer lines up with the bill's current schedule (phases/
    // 06-fixed-costs.md "Instance storage" — the read path every screen in
    // this phase shares).
    .get("/", zValidator("query", listBillInstancesQuerySchema, handleValidation), async (c) => {
      const window = c.req.valid("query");

      const activeBills = await db.query.bills.findMany({
        where: (b, { isNull: isNullCol }) => isNullCol(b.archivedAt),
      });
      const { factorsByBill, stepChangesByBill, historyByBill } = await loadBillModifiers(
        db,
        activeBills.map((b) => b.id),
      );

      const merged = activeBills.flatMap((bill) => {
        const engineBill = toEngineBill(bill, factorsByBill.get(bill.id) ?? [], stepChangesByBill.get(bill.id) ?? []);
        const history = historyByBill.get(bill.id) ?? [];
        const { instances, orphans } = projectBillInWindow(engineBill, history, window);
        return [...instances, ...orphans];
      });
      merged.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

      return c.json({ instances: merged });
    })

    // Materialises a stored row for a projected date — see zod/
    // bill-instances.js for the two shapes this covers. Upserts on
    // (billId, dueDate) rather than erroring on a repeat call, same
    // convention as balance snapshots.
    .post("/", zValidator("json", createBillInstanceSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");

      const bill = await db.query.bills.findFirst({ where: (b, { eq: eqCol }) => eqCol(b.id, data.billId) });
      if (!bill) {
        return c.json({ error: { code: "not_found", message: "Bill not found." } }, 404);
      }

      const isOverride = data.expectedCents !== undefined;
      const values = {
        billId: data.billId,
        dueDate: data.dueDate,
        expectedCents: data.expectedCents ?? null,
        actualCents: data.actualCents ?? null,
        paidOn: data.paidOn ?? null,
        isOverride,
        note: data.note ?? null,
      };

      const [instance] = await db
        .insert(billInstances)
        .values(values)
        .onConflictDoUpdate({ target: [billInstances.billId, billInstances.dueDate], set: values })
        .returning();
      const created = mustAt([instance], 0, "bill instance");

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "bill_instance.upsert",
        entityType: "bill_instance",
        entityId: created.id,
        metadata: data,
      });

      return c.json({ instance: created }, 201);
    })

    .patch("/:id", zValidator("json", updateBillInstanceSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");

      const [updated] = await db.update(billInstances).set(data).where(eq(billInstances.id, id)).returning();
      if (!updated) {
        return c.json({ error: { code: "not_found", message: "Bill instance not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "bill_instance.update",
        entityType: "bill_instance",
        entityId: id,
        metadata: data,
      });

      return c.json({ instance: updated });
    })

    // Not in the phase doc's own route table, but needed for its "realign or
    // delete" orphan action (phases/06-fixed-costs.md "Orphaned instances")
    // — same "the table stayed spare, this fills the one gap the UI needs"
    // reasoning as accounts.js's undocumented `GET /accounts/:id`. This is a
    // deliberate, operator-initiated discard of one row they no longer want,
    // never automatic — the system itself still never silently drops an
    // orphan (see `findOrphanRows` in lib/bills.js, which only ever flags).
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const [deleted] = await db.delete(billInstances).where(eq(billInstances.id, id)).returning();
      if (!deleted) {
        return c.json({ error: { code: "not_found", message: "Bill instance not found." } }, 404);
      }
      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "bill_instance.delete",
        entityType: "bill_instance",
        entityId: id,
        metadata: { billId: deleted.billId, dueDate: deleted.dueDate },
      });
      return c.json({ ok: true });
    });
}
