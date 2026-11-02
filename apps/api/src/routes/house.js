import { mustAt } from "@budget/engine";
import {
  createHouseScenarioSchema,
  houseQuerySchema,
  houseScenarios,
  houseSettingsSchema,
  settings,
  updateHouseScenarioSchema,
} from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { todayIso } from "../lib/dates.js";
import { HOUSE_SETTINGS_KEY, lenderLimitFieldError, loadHouse } from "../lib/house.js";
import { handleValidation } from "../lib/validation.js";

/**
 * Buying a house: saved purchase scenarios and the household-wide settings
 * they're read against. Like goals, this REPORTS — nothing in this file writes
 * an allocation line, a balance or a budget. Results are computed by the
 * engine in the browser from what `GET /` returns, so the edit dialog can
 * preview a change before it's saved.
 *
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createHouseRoutes({ db }) {
  const app = new Hono();

  return app
    .get("/", zValidator("query", houseQuerySchema, handleValidation), async (c) => {
      const on = c.req.valid("query").on ?? todayIso();
      return c.json(await loadHouse(db, { on }));
    })

    // Replaced whole: the sheet always sends every field, and a merge would
    // keep a category the operator just unticked.
    .put("/settings", zValidator("json", houseSettingsSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");
      await db
        .insert(settings)
        .values({ key: HOUSE_SETTINGS_KEY, value: data })
        .onConflictDoUpdate({ target: settings.key, set: { value: data, updatedAt: new Date() } });

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "house.settings.update",
        entityType: "settings",
        entityId: HOUSE_SETTINGS_KEY,
        metadata: data,
      });

      return c.json({ settings: data });
    })

    .post("/scenarios", zValidator("json", createHouseScenarioSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");
      const fieldError = lenderLimitFieldError(data);
      if (fieldError) {
        return c.json({ error: { code: "invalid_request", message: fieldError } }, 400);
      }

      const last = await db.query.houseScenarios.findFirst({
        orderBy: (s, { desc: descCol }) => descCol(s.sortOrder),
      });
      const created = await db
        .insert(houseScenarios)
        .values({ ...data, note: data.note ?? null, sortOrder: (last?.sortOrder ?? -1) + 1 })
        .returning();
      const scenario = mustAt(created, 0, "created house scenario");

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "house_scenario.create",
        entityType: "house_scenario",
        entityId: scenario.id,
        metadata: data,
      });

      return c.json({ scenario }, 201);
    })

    .patch("/scenarios/:id", zValidator("json", updateHouseScenarioSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");

      const current = await db.query.houseScenarios.findFirst({ where: (s, { eq: eqCol }) => eqCol(s.id, id) });
      if (!current) {
        return c.json({ error: { code: "not_found", message: "Scenario not found." } }, 404);
      }
      // The merged row, not the delta: switching to Help to Buy without
      // sending a limit is the mistake worth catching.
      const fieldError = lenderLimitFieldError({
        scheme: data.scheme ?? current.scheme,
        lenderLimitCents: "lenderLimitCents" in data ? data.lenderLimitCents : current.lenderLimitCents,
      });
      if (fieldError) {
        return c.json({ error: { code: "invalid_request", message: fieldError } }, 400);
      }

      const [updated] = await db.update(houseScenarios).set(data).where(eq(houseScenarios.id, id)).returning();
      if (!updated) {
        return c.json({ error: { code: "not_found", message: "Scenario not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "house_scenario.update",
        entityType: "house_scenario",
        entityId: id,
        metadata: data,
      });

      return c.json({ scenario: updated });
    })

    // A hard delete: a scenario holds no history — every figure it shows is
    // computed from the budget, which survives it.
    .delete("/scenarios/:id", async (c) => {
      const id = c.req.param("id");
      const [deleted] = await db.delete(houseScenarios).where(eq(houseScenarios.id, id)).returning();
      if (!deleted) {
        return c.json({ error: { code: "not_found", message: "Scenario not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "house_scenario.delete",
        entityType: "house_scenario",
        entityId: id,
        metadata: { name: deleted.name },
      });

      return c.json({ ok: true });
    });
}
