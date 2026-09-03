import { settings, updateSettingsSchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { handleValidation } from "../lib/validation.js";

// Every operator-facing settings key introduced so far (phases/
// 04-accounts-people.md "Settings keys introduced here"). `schema_seed_
// version` also lives in this table but is infrastructure bookkeeping, not
// a setting — deliberately excluded from both the whitelist and the
// response.
const SETTINGS_KEYS = /** @type {const} */ ([
  "currency",
  "locale",
  "billsBufferCents",
  "historyLookbackDefault",
  "billsOpeningBalanceCents",
]);

// Fallback only for a row seed.js hasn't written yet (a fresh database
// queried before `pnpm db:seed` runs) — normal operation always reads the
// real rows below. `<Money>` reads currency/locale from here via
// useSettings(), never inline (phases/README.md "Money").
const SETTINGS_DEFAULTS = {
  currency: "AUD",
  locale: "en-AU",
  billsBufferCents: 0,
  historyLookbackDefault: 6,
  // No override — the balance curve opens from the income-landing account's
  // own latest snapshot instead.
  billsOpeningBalanceCents: null,
};

/** @param {import("@budget/schema").Db} db */
async function readSettings(db) {
  const rows = await db.query.settings.findMany({
    where: (s, { inArray }) => inArray(s.key, SETTINGS_KEYS),
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  return Object.fromEntries(
    SETTINGS_KEYS.map((key) => [key, byKey.has(key) ? byKey.get(key) : SETTINGS_DEFAULTS[key]]),
  );
}

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createSettingsRoutes({ db }) {
  const app = new Hono();

  return app
    .get("/", async (c) => c.json({ settings: await readSettings(db) }))

    .patch("/", zValidator("json", updateSettingsSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");

      for (const [key, value] of Object.entries(data)) {
        await db
          .insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "settings.update",
        entityType: "settings",
        entityId: "settings",
        metadata: data,
      });

      return c.json({ settings: await readSettings(db) });
    });
}
