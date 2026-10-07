import { diffAllocations } from "@budget/engine";
import { allocationComputeQuerySchema, allocationPreviewQuerySchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import {
  computeVersionAllocation,
  findVersionByStatus,
  linesForVersion,
  loadAllocationContext,
  resolveCurrentTransfers,
  serializeInputs,
  serializeVersion,
  stageGoalsForVersion,
  variantGrossPerMonthCents,
} from "../lib/allocation.js";
import { todayIso } from "../lib/dates.js";
import { handleValidation } from "../lib/validation.js";

/** @import { AllocationContext } from "../lib/allocation.js" */

/**
 * @param {import("@budget/schema").Db} db
 * @param {string} id
 */
async function findPlan(db, id) {
  return (
    (await db.query.allocationPlans.findFirst({ where: (p, { eq: eqCol }) => eqCol(p.id, id) })) ?? null
  );
}

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createAllocationRoutes({ db }) {
  const app = new Hono();

  /**
   * @param {AllocationContext} context
   * @param {import("@budget/engine").Cents} grossPerMonthCents
   * @param {import("../lib/allocation.js").StoredAllocationVersion} version
   */
  async function resolveVersionPayload(context, grossPerMonthCents, version) {
    const [lineRows, stageGoalRows] = await Promise.all([
      linesForVersion(db, version.id),
      stageGoalsForVersion(db, version.id),
    ]);
    return {
      version: serializeVersion(version, lineRows, { stageGoalRows }),
      result: computeVersionAllocation(context, grossPerMonthCents, lineRows, stageGoalRows),
    };
  }

  return app
    // Assembles `AllocationInput` from the phases that own each figure and
    // hands the engine's `AllocationResult` back verbatim. It computes
    // nothing itself (phases/08-allocation.md "/allocation/compute").
    .get("/compute", zValidator("query", allocationComputeQuerySchema, handleValidation), async (c) => {
      const { versionId } = c.req.valid("query");
      const on = c.req.valid("query").on ?? todayIso();

      const version = await db.query.allocationVersions.findFirst({
        where: (v, { eq: eqCol }) => eqCol(v.id, versionId),
      });
      if (!version) {
        return c.json({ error: { code: "not_found", message: "Allocation version not found." } }, 404);
      }
      const plan = await findPlan(db, version.planId);
      if (!plan) {
        return c.json({ error: { code: "not_found", message: "Allocation plan not found." } }, 404);
      }

      const context = await loadAllocationContext(db, on);
      if (!context.incomeLandingAccountId) {
        return c.json(
          {
            error: {
              code: "no_income_landing_account",
              message: "Mark an account as income landing in Accounts before allocating.",
            },
          },
          400,
        );
      }

      const grossPerMonthCents = await variantGrossPerMonthCents(db, plan.incomeVariantId);
      const payload = await resolveVersionPayload(context, grossPerMonthCents, version);

      return c.json({
        plan: { id: plan.id, name: plan.name, incomeVariantId: plan.incomeVariantId },
        inputs: serializeInputs(context, grossPerMonthCents),
        version: payload.version,
        result: payload.result,
        warnings: context.warnings,
      });
    })

    // One request powers the whole editing experience: the assembled inputs,
    // both versions computed, and the transfer-by-transfer diff between them
    // (phases/08-allocation.md "/allocation/preview").
    //
    // `inputs` is the same for both versions by construction — one household,
    // one date — which is what lets the editor recompute the draft locally
    // through the same engine on every keystroke instead of asking the server
    // again. The preview is live because the arithmetic is pure, not because
    // this endpoint is fast.
    .get("/preview", zValidator("query", allocationPreviewQuerySchema, handleValidation), async (c) => {
      const { planId } = c.req.valid("query");
      const on = c.req.valid("query").on ?? todayIso();

      const plan = await findPlan(db, planId);
      if (!plan) {
        return c.json({ error: { code: "not_found", message: "Allocation plan not found." } }, 404);
      }

      const context = await loadAllocationContext(db, on);
      if (!context.incomeLandingAccountId) {
        return c.json(
          {
            error: {
              code: "no_income_landing_account",
              message: "Mark an account as income landing in Accounts before allocating.",
            },
          },
          400,
        );
      }

      const grossPerMonthCents = await variantGrossPerMonthCents(db, plan.incomeVariantId);
      const [activeVersion, draftVersion] = await Promise.all([
        findVersionByStatus(db, planId, "active"),
        findVersionByStatus(db, planId, "draft"),
      ]);

      const active = activeVersion ? await resolveVersionPayload(context, grossPerMonthCents, activeVersion) : null;
      const draft = draftVersion ? await resolveVersionPayload(context, grossPerMonthCents, draftVersion) : null;

      // "Current" is what the bank is doing: the amounts recorded when the
      // active version was applied. `active.result` stays today's
      // recomputation of the same version (the editor's starting point and
      // the dashboard's live figure), so the two are separate fields rather
      // than one quietly standing in for the other.
      const resolvedCurrent =
        active && activeVersion ? resolveCurrentTransfers(activeVersion, active.result, context.payCadence) : null;

      return c.json({
        plan: { id: plan.id, name: plan.name, incomeVariantId: plan.incomeVariantId },
        inputs: serializeInputs(context, grossPerMonthCents),
        active,
        draft,
        current: resolvedCurrent?.current ?? null,
        // Null rather than an empty array when there is nothing to compare:
        // a first-ever plan has no active version, and "no changes" and "no
        // baseline to change from" must not look the same on screen. Against
        // the recorded amounts when there are any, so an unchanged draft
        // applied after a bill moved still lists the orders to edit.
        diff: resolvedCurrent && draft ? diffAllocations(resolvedCurrent.baseline, draft.result) : null,
        warnings: context.warnings,
      });
    });
}
