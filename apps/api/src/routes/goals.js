import { mustAt } from "@budget/engine";
import { createGoalSchema, goals, goalsQuerySchema, updateGoalSchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { todayIso } from "../lib/dates.js";
import { loadGoals, targetModeFieldError } from "../lib/goals.js";
import { handleValidation } from "../lib/validation.js";

// A goal's detail view draws the whole path to the target rather than a
// card-sized sketch of it.
const DETAIL_CURVE_POINTS = 400;

/**
 * @param {import("@budget/schema").Db} db
 * @param {string} accountId
 */
async function accountError(db, accountId) {
  const account = await db.query.accounts.findFirst({ where: (a, { eq: eqCol }) => eqCol(a.id, accountId) });
  if (!account) return { status: /** @type {const} */ (404), code: "not_found", message: "Account not found." };
  // `external` accounts receive transfers and never hold a balance, so there
  // is nothing for a goal to measure progress against
  // (phases/09-goals-projections.md "Schema").
  if (account.type === "external") {
    return {
      status: /** @type {const} */ (400),
      code: "invalid_account",
      message: "External accounts can't have goals — they don't hold a balance.",
    };
  }
  return null;
}

/**
 * Goals REPORT. Nothing in this file writes an allocation line, and nothing
 * suggests one — the boundary this phase exists inside
 * (phases/09-goals-projections.md "Advisory only").
 *
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createGoalsRoutes({ db }) {
  const app = new Hono();

  return app
    // Every goal with its computed projection, plus the household summary.
    // Everything here is computed on read: no ETA, progress or resolved
    // target is ever stored.
    .get("/", zValidator("query", goalsQuerySchema, handleValidation), async (c) => {
      const on = c.req.valid("query").on ?? todayIso();
      return c.json(await loadGoals(db, { on }));
    })

    .post("/", zValidator("json", createGoalSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");

      const accountProblem = await accountError(db, data.accountId);
      if (accountProblem) {
        return c.json(
          { error: { code: accountProblem.code, message: accountProblem.message } },
          accountProblem.status,
        );
      }
      const fieldError = targetModeFieldError(data);
      if (fieldError) {
        return c.json({ error: { code: "invalid_request", message: fieldError } }, 400);
      }

      const created = await db
        .insert(goals)
        .values({
          accountId: data.accountId,
          name: data.name,
          targetMode: data.targetMode,
          // The unused half of the pair is stored null rather than left as
          // whatever the form last held — a months goal carrying a stale
          // dollar target would resolve correctly and read wrong.
          targetAmountCents: data.targetMode === "amount" ? data.targetAmountCents ?? null : null,
          targetMonths: data.targetMode === "months_of_expenses" ? data.targetMonths ?? null : null,
          targetDate: data.targetDate ?? null,
          note: data.note ?? null,
          status: data.status,
        })
        .returning();
      const goal = mustAt(created, 0, "created goal");

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "goal.create",
        entityType: "goal",
        entityId: goal.id,
        metadata: data,
      });

      return c.json({ goal }, 201);
    })

    .get("/:id", zValidator("query", goalsQuerySchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const on = c.req.valid("query").on ?? todayIso();
      const payload = await loadGoals(db, { on, goalId: id, curvePoints: DETAIL_CURVE_POINTS });
      const goal = payload.goals[0];
      if (!goal) {
        return c.json({ error: { code: "not_found", message: "Goal not found." } }, 404);
      }
      return c.json({ ...goal, summary: payload.summary, warnings: payload.warnings });
    })

    .patch("/:id", zValidator("json", updateGoalSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");

      const current = await db.query.goals.findFirst({ where: (g, { eq: eqCol }) => eqCol(g.id, id) });
      if (!current) {
        return c.json({ error: { code: "not_found", message: "Goal not found." } }, 404);
      }

      if (data.accountId) {
        const accountProblem = await accountError(db, data.accountId);
        if (accountProblem) {
          return c.json(
            { error: { code: accountProblem.code, message: accountProblem.message } },
            accountProblem.status,
          );
        }
      }

      // Validate the merged row, not the delta: switching mode without
      // sending the matching target is the mistake worth catching.
      const nextMode = data.targetMode ?? current.targetMode;
      const merged = {
        targetMode: nextMode,
        targetAmountCents:
          "targetAmountCents" in data ? data.targetAmountCents : current.targetAmountCents,
        targetMonths: "targetMonths" in data ? data.targetMonths : current.targetMonths,
      };
      const fieldError = targetModeFieldError(merged);
      if (fieldError) {
        return c.json({ error: { code: "invalid_request", message: fieldError } }, 400);
      }

      const [updated] = await db
        .update(goals)
        .set({
          ...data,
          targetAmountCents: nextMode === "amount" ? merged.targetAmountCents ?? null : null,
          targetMonths: nextMode === "months_of_expenses" ? merged.targetMonths ?? null : null,
        })
        .where(eq(goals.id, id))
        .returning();
      if (!updated) {
        return c.json({ error: { code: "not_found", message: "Goal not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "goal.update",
        entityType: "goal",
        entityId: id,
        metadata: data,
      });

      return c.json({ goal: updated });
    })

    // A hard delete, unlike an account or a bill: a goal holds no history of
    // its own — every figure it reports is computed from balances and the
    // allocation, both of which survive it. An operator who wants to keep the
    // record sets `status` to achieved or abandoned instead.
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const [deleted] = await db.delete(goals).where(eq(goals.id, id)).returning();
      if (!deleted) {
        return c.json({ error: { code: "not_found", message: "Goal not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "goal.delete",
        entityType: "goal",
        entityId: id,
        metadata: { name: deleted.name, accountId: deleted.accountId },
      });

      return c.json({ ok: true });
    });
}
