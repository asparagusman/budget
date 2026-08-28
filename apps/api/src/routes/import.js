import { importCommitSchema } from "@budget/schema";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { loadAllocationContext } from "../lib/allocation.js";
import { todayIso } from "../lib/dates.js";
import { applyImport, ImportSelectionError, importNextSteps, reconcileImport } from "../lib/import/apply.js";
import { parseImport } from "../lib/import/parse.js";

// The one-time migration path off the spreadsheet.
//
// Two endpoints, and the file is uploaded to BOTH. Preview parses and returns
// everything it found; commit re-parses the same file and writes only what the
// operator ticked. Re-parsing rather than trusting the preview payload back is
// deliberate: the reconciliation summary's whole claim is "this is what your
// spreadsheet says", and that claim is worthless if the numbers took a round
// trip through a form the client could have altered. It also means the server
// holds no import session — nothing to expire, nothing to leak.

// The source workbook is ~40kB. Ten megabytes is far more headroom than any
// household spreadsheet needs and still small enough to parse in memory
// without thinking about it.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const NO_FILE = {
  error: { code: "invalid_request", message: "Attach a .xlsx file to import." },
};

/**
 * Pulls the uploaded workbook out of a multipart body.
 *
 * @param {import("hono").Context} c
 * @returns {Promise<{ buffer: Buffer, fileName: string } | { error: { code: string, message: string } }>}
 */
async function readUpload(c) {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return NO_FILE;
  if (file.size === 0) return NO_FILE;
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      error: {
        code: "file_too_large",
        message: `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.`,
      },
    };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Buffer.alloc + set rather than Buffer.from(arrayBuffer): the copy is
  // trivial at this size and the result is a Buffer over a plain ArrayBuffer,
  // which is what exceljs's reader wants without any casting.
  const buffer = Buffer.alloc(bytes.byteLength);
  buffer.set(bytes);
  return { buffer, fileName: file.name || "workbook.xlsx" };
}

/**
 * The account whose id makes a transfer a no-op. Prefers whatever the
 * operator has already flagged; falls back to the destination the spreadsheet
 * itself labels "no move required", which is the same statement in the
 * workbook's own words. Never invents one.
 *
 * @param {string | null} flagged
 * @param {import("../lib/import/parse.js").ImportPlan} plan
 * @param {Record<string, string>} accountIdByDestination
 */
function resolveLandingAccountId(flagged, plan, accountIdByDestination) {
  if (flagged) return flagged;
  const noMove = plan.destinations.find((d) => /no move required/i.test(d.raw));
  return (noMove && accountIdByDestination[noMove.key]) ?? null;
}

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createImportRoutes({ db }) {
  const app = new Hono();

  return app
    // Parse and describe. Writes nothing.
    .post("/preview", async (c) => {
      const upload = await readUpload(c);
      if ("error" in upload) return c.json(upload, 400);

      const accounts = await db.query.accounts.findMany({
        where: (a, { isNull }) => isNull(a.archivedAt),
      });

      try {
        const preview = await parseImport(upload.buffer, {
          fileName: upload.fileName,
          accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
        });
        return c.json({
          preview,
          // The date the preview offers as a default for every imported bill
          // and budget. Sent from here rather than computed in the browser so
          // the server's calendar day is the one that gets used.
          defaultAnchorDate: todayIso(),
          accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type })),
        });
      } catch (err) {
        console.error("Import preview failed:", err);
        return c.json(
          {
            error: {
              code: "unreadable_workbook",
              message: "That file could not be read as an .xlsx workbook.",
            },
          },
          400,
        );
      }
    })

    // Re-parse, apply the operator's selection, and report what landed beside
    // what the spreadsheet said.
    .post("/commit", async (c) => {
      const upload = await readUpload(c);
      if ("error" in upload) return c.json(upload, 400);

      const body = await c.req.parseBody();
      const raw = body.selection;
      if (typeof raw !== "string") {
        return c.json(
          { error: { code: "invalid_request", message: "Missing the import selection." } },
          400,
        );
      }

      /** @type {unknown} */
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        return c.json({ error: { code: "invalid_request", message: "Import selection is not valid JSON." } }, 400);
      }

      const parsedSelection = importCommitSchema.safeParse(json);
      if (!parsedSelection.success) {
        return c.json(
          {
            error: {
              code: "invalid_request",
              message: "Invalid import selection.",
              fields: parsedSelection.error.flatten().fieldErrors,
            },
          },
          400,
        );
      }
      const selection = parsedSelection.data;

      const accounts = await db.query.accounts.findMany({
        where: (a, { isNull }) => isNull(a.archivedAt),
      });

      /** @type {import("../lib/import/parse.js").ImportPlan} */
      let plan;
      try {
        plan = await parseImport(upload.buffer, {
          fileName: upload.fileName,
          accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
        });
      } catch (err) {
        console.error("Import commit parse failed:", err);
        return c.json(
          { error: { code: "unreadable_workbook", message: "That file could not be read as an .xlsx workbook." } },
          400,
        );
      }

      let applied;
      try {
        applied = await applyImport(db, { plan, selection, actorId: getUserId(c) });
      } catch (err) {
        if (err instanceof ImportSelectionError) {
          return c.json({ error: { code: "invalid_selection", message: err.message } }, 400);
        }
        throw err;
      }

      // Read the household's own context back AFTER the write, so the
      // reconciliation and the next-steps list describe the database as it
      // now stands rather than as it was.
      const context = await loadAllocationContext(db, selection.anchorDate);
      const incomeLandingAccountId = resolveLandingAccountId(
        context.incomeLandingAccountId,
        plan,
        applied.accountIdByDestination,
      );

      const reconciliation = reconcileImport({
        plan,
        selection,
        accountIdByDestination: applied.accountIdByDestination,
        incomeLandingAccountId,
        payCadence: context.payCadence,
      });

      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "import.commit",
        entityType: "import",
        entityId: plan.fileHash,
        // The counts and the file's identity, never its contents — an audit
        // row is not the place to keep a copy of the household's finances.
        metadata: { fileName: plan.fileName, ...applied.counts },
      });

      return c.json({
        counts: applied.counts,
        createdAccountNames: applied.createdAccountNames,
        reconciliation,
        payCadence: context.payCadence,
        hasPrimaryPaySchedule: context.hasPrimaryPaySchedule,
        nextSteps: importNextSteps({
          importedPlans: applied.importedPlans,
          incomeLandingAccountId: context.incomeLandingAccountId,
          hasPrimaryPaySchedule: context.hasPrimaryPaySchedule,
          createdAccountNames: applied.createdAccountNames,
        }),
      });
    });
}
