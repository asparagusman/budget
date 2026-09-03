import { mustAt } from "@budget/engine";
import {
  allocationPlans,
  allocationVersions,
  applyAllocationDraftSchema,
  createAllocationPlanSchema,
  updateAllocationPlanSchema,
} from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import {
  applyDraftVersion,
  createDraftVersion,
  findNewestVersion,
  findVersionByStatus,
  serializeVersion,
  serializeVersionById,
  versionsForPlan,
} from "../lib/allocation.js";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { handleValidation } from "../lib/validation.js";

/** @import { StoredAllocationVersion } from "../lib/allocation.js" */

/**
 * The summary a plan list needs about one of its versions — enough to render
 * "v3 · active since 14 Mar" without pulling every line of every version.
 *
 * @param {StoredAllocationVersion} version
 */
function versionSummary(version) {
  return {
    id: version.id,
    version: version.version,
    status: version.status,
    note: version.note,
    createdAt: version.createdAt.toISOString(),
    activatedAt: version.activatedAt ? version.activatedAt.toISOString() : null,
  };
}

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
export function createAllocationPlansRoutes({ db }) {
  const app = new Hono();

  return app
    // Every plan with its active and draft version summaries — one request
    // for the plan selector and the "you have unapplied changes" state
    // (phases/08-allocation.md "API").
    .get("/", async (c) => {
      const [plans, versions, variants] = await Promise.all([
        db.query.allocationPlans.findMany({
          where: (p, { isNull: isNullCol }) => isNullCol(p.archivedAt),
          orderBy: (p, { asc }) => [asc(p.name)],
        }),
        db.query.allocationVersions.findMany(),
        db.query.incomeVariants.findMany(),
      ]);

      const variantNameById = new Map(variants.map((v) => [v.id, v.name]));
      const variantOrderById = new Map(variants.map((v) => [v.id, v.sortOrder]));

      // Ordered by the income variant's own order first, so the household's
      // usual plan leads and the exception plans follow — the same order they
      // read in on /income. Plans carry no sort order of their own; the
      // variant they divide is the thing being sequenced.
      const ordered = [...plans].sort(
        (a, b) =>
          (variantOrderById.get(a.incomeVariantId) ?? 0) - (variantOrderById.get(b.incomeVariantId) ?? 0) ||
          a.name.localeCompare(b.name),
      );

      return c.json({
        plans: ordered.map((plan) => {
          const own = versions.filter((v) => v.planId === plan.id);
          const active = own.find((v) => v.status === "active") ?? null;
          const draft = own.find((v) => v.status === "draft") ?? null;
          return {
            id: plan.id,
            name: plan.name,
            incomeVariantId: plan.incomeVariantId,
            // Archived variants still render a name on a historic plan
            // rather than an empty cell (phases/04-accounts-people.md's same
            // rule for archived accounts).
            incomeVariantName: variantNameById.get(plan.incomeVariantId) ?? null,
            activeVersion: active ? versionSummary(active) : null,
            draftVersion: draft ? versionSummary(draft) : null,
            versionCount: own.length,
          };
        }),
      });
    })

    // A new plan starts with an empty draft rather than an active version:
    // an allocation with no lines leaves every dollar unallocated, and that
    // is not a state to make live behind the operator's back.
    .post("/", zValidator("json", createAllocationPlanSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");

      const variant = await db.query.incomeVariants.findFirst({
        where: (v, { eq: eqCol }) => eqCol(v.id, data.incomeVariantId),
      });
      if (!variant) {
        return c.json({ error: { code: "not_found", message: "Income variant not found." } }, 404);
      }

      const created = await db.insert(allocationPlans).values(data).returning();
      const plan = mustAt(created, 0, "created allocation plan");
      const draft = await createDraftVersion(db, {
        planId: plan.id,
        source: null,
        createdBy: getUserId(c),
      });

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "allocation_plan.create",
        entityType: "allocation_plan",
        entityId: plan.id,
        metadata: data,
      });

      return c.json({ plan, draft: serializeVersion(draft, []) }, 201);
    })

    .patch("/:id", zValidator("json", updateAllocationPlanSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");

      if (data.incomeVariantId) {
        const variant = await db.query.incomeVariants.findFirst({
          where: (v, { eq: eqCol }) => eqCol(v.id, data.incomeVariantId ?? ""),
        });
        if (!variant) {
          return c.json({ error: { code: "not_found", message: "Income variant not found." } }, 404);
        }
      }

      const [updated] = await db.update(allocationPlans).set(data).where(eq(allocationPlans.id, id)).returning();
      if (!updated) {
        return c.json({ error: { code: "not_found", message: "Allocation plan not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "allocation_plan.update",
        entityType: "allocation_plan",
        entityId: id,
        metadata: data,
      });

      return c.json({ plan: updated });
    })

    // Archive, never a hard delete — an applied allocation is the record of
    // what the standing transfers were, and that has to survive the operator
    // tidying up their plan list.
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const [archived] = await db
        .update(allocationPlans)
        .set({ archivedAt: new Date() })
        .where(and(eq(allocationPlans.id, id), isNull(allocationPlans.archivedAt)))
        .returning();
      if (!archived) {
        return c.json({ error: { code: "not_found", message: "Allocation plan not found." } }, 404);
      }

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "allocation_plan.archive",
        entityType: "allocation_plan",
        entityId: id,
      });

      return c.json({ ok: true });
    })

    // History, newest first, with each version's lines — the timeline can
    // diff any two versions client-side without a request per version.
    .get("/:id/versions", async (c) => {
      const id = c.req.param("id");
      const plan = await findPlan(db, id);
      if (!plan) {
        return c.json({ error: { code: "not_found", message: "Allocation plan not found." } }, 404);
      }

      const [versions, users] = await Promise.all([versionsForPlan(db, id), db.query.users.findMany()]);
      const nameById = new Map(users.map((u) => [u.id, u.displayName]));

      const withLines = [];
      for (const version of versions) {
        withLines.push(
          await serializeVersionById(db, version, {
            createdByName: version.createdBy ? nameById.get(version.createdBy) ?? null : null,
          }),
        );
      }

      return c.json({ versions: withLines });
    })

    // Idempotent: a draft already open is returned as-is rather than forked.
    // Two people editing the same plan share one draft — this household has
    // two users on one dataset (phases/08-allocation.md "Constraints").
    .post("/:id/draft", async (c) => {
      const id = c.req.param("id");
      const plan = await findPlan(db, id);
      if (!plan) {
        return c.json({ error: { code: "not_found", message: "Allocation plan not found." } }, 404);
      }

      const existing = await findVersionByStatus(db, id, "draft");
      if (existing) {
        return c.json({ draft: await serializeVersionById(db, existing), created: false });
      }

      // Copy from the active version, or — for a plan whose active version
      // was archived without a replacement — from the newest version there
      // is, which is the operator's most recent intent either way.
      const source = (await findVersionByStatus(db, id, "active")) ?? (await findNewestVersion(db, id));
      const draft = await createDraftVersion(db, { planId: id, source, createdBy: getUserId(c) });

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "allocation_version.draft_create",
        entityType: "allocation_version",
        entityId: draft.id,
        metadata: { planId: id, basedOnVersionId: source?.id ?? null },
      });

      return c.json({ draft: await serializeVersionById(db, draft), created: true }, 201);
    })

    // Discard. A hard delete, unlike almost everything else here: a draft
    // that was never applied is not history, it's abandoned work.
    .delete("/:id/draft", async (c) => {
      const id = c.req.param("id");
      const draft = await findVersionByStatus(db, id, "draft");
      if (!draft) {
        return c.json({ error: { code: "not_found", message: "No draft to discard." } }, 404);
      }

      await db.delete(allocationVersions).where(eq(allocationVersions.id, draft.id));

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "allocation_version.discard",
        entityType: "allocation_version",
        entityId: draft.id,
        metadata: { planId: id, version: draft.version },
      });

      return c.json({ ok: true });
    })

    // Apply. Never validates the allocation first: a plan whose unallocated
    // figure isn't zero is the operator's call to make, and this app does not
    // resolve conflicts on their behalf (phases/README.md "The one rule").
    .post("/:id/draft/apply", zValidator("json", applyAllocationDraftSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const { note } = c.req.valid("json");

      const draft = await findVersionByStatus(db, id, "draft");
      if (!draft) {
        return c.json({ error: { code: "not_found", message: "No draft to apply." } }, 404);
      }
      const active = await findVersionByStatus(db, id, "active");

      const applied = await applyDraftVersion(db, { draft, active, note });

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "allocation_version.apply",
        entityType: "allocation_version",
        entityId: applied.id,
        metadata: { planId: id, version: applied.version, archivedVersionId: active?.id ?? null },
      });

      return c.json({ version: await serializeVersionById(db, applied) });
    });
}
