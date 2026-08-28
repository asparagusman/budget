import { allocationLines, replaceAllocationLinesSchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  basisValueError,
  createDraftVersion,
  duplicateInjectedBasisError,
  findVersionByStatus,
  isInjectedBasis,
  linesForVersion,
  serializeVersion,
} from "../lib/allocation.js";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { handleValidation } from "../lib/validation.js";

/**
 * @param {import("@budget/schema").Db} db
 * @param {string} id
 */
async function findVersion(db, id) {
  return (
    (await db.query.allocationVersions.findFirst({ where: (v, { eq: eqCol }) => eqCol(v.id, id) })) ?? null
  );
}

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createAllocationVersionsRoutes({ db }) {
  const app = new Hono();

  return app
    // Bulk replace, draft only. An active or archived version's lines are
    // immutable and the API is where that's enforced — immutability is what
    // makes the history trustworthy (phases/08-allocation.md "Constraints").
    .put("/:id/lines", zValidator("json", replaceAllocationLinesSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const { lines } = c.req.valid("json");

      const version = await findVersion(db, id);
      if (!version) {
        return c.json({ error: { code: "not_found", message: "Allocation version not found." } }, 404);
      }
      if (version.status !== "draft") {
        return c.json(
          {
            error: {
              code: "immutable_version",
              message: `Version ${version.version} is ${version.status} — open a draft to make changes.`,
            },
          },
          400,
        );
      }

      const duplicateError = duplicateInjectedBasisError(lines);
      if (duplicateError) {
        return c.json({ error: { code: "invalid_request", message: duplicateError } }, 400);
      }
      for (const line of lines) {
        const valueError = basisValueError(line);
        if (valueError) {
          return c.json({ error: { code: "invalid_request", message: valueError } }, 400);
        }
      }

      const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
      if (accountIds.length > 0) {
        const accounts = await db.query.accounts.findMany({
          where: (a, { inArray }) => inArray(a.id, accountIds),
        });
        if (accounts.length !== accountIds.length) {
          return c.json({ error: { code: "not_found", message: "A destination account no longer exists." } }, 404);
        }
      }

      // Delete-then-insert in one transaction: the whole draft is the unit
      // being saved, and a reorder or a stage move has no meaningful
      // half-applied state (phases/08-allocation.md "PUT .../lines").
      const saved = await db.transaction(async (tx) => {
        await tx.delete(allocationLines).where(eq(allocationLines.versionId, id));
        if (lines.length === 0) return [];
        return tx
          .insert(allocationLines)
          .values(
            lines.map((line, index) => ({
              versionId: id,
              stage: line.stage,
              label: line.label,
              basis: line.basis,
              // The two injected bases take their amount from the fixed-cost
              // and variable-essentials totals, so any `value` sent with one
              // is meaningless — normalised away rather than stored as a
              // number that looks like it does something.
              value: isInjectedBasis(line.basis) ? null : line.value,
              goalPct: line.goalPct ?? null,
              accountId: line.accountId,
              sortOrder: line.sortOrder,
            })),
          )
          .returning();
      });

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "allocation_version.lines_replace",
        entityType: "allocation_version",
        entityId: id,
        metadata: { planId: version.planId, lineCount: saved.length },
      });

      return c.json({ version: serializeVersion(version, saved) });
    })

    // Revert seeds a NEW draft from an old version — it never mutates
    // history, and never silently overwrites a draft somebody else is
    // already editing (phases/08-allocation.md "Version history").
    .post("/:id/revert", async (c) => {
      const id = c.req.param("id");

      const source = await findVersion(db, id);
      if (!source) {
        return c.json({ error: { code: "not_found", message: "Allocation version not found." } }, 404);
      }

      const existingDraft = await findVersionByStatus(db, source.planId, "draft");
      if (existingDraft) {
        return c.json(
          {
            error: {
              code: "draft_exists",
              message: `This plan already has a draft (v${existingDraft.version}). Apply or discard it first.`,
            },
          },
          400,
        );
      }

      const draft = await createDraftVersion(db, {
        planId: source.planId,
        source,
        createdBy: getUserId(c),
        note: `Reverted from v${source.version}.`,
      });

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "allocation_version.revert",
        entityType: "allocation_version",
        entityId: draft.id,
        metadata: { planId: source.planId, revertedFromVersionId: source.id, revertedFrom: source.version },
      });

      return c.json({ draft: serializeVersion(draft, await linesForVersion(db, draft.id)) }, 201);
    });
}
