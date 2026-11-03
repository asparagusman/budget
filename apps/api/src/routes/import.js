import { importCommitFormSchema, importCommitSchema, importPreviewFormSchema } from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { loadAllocationContext } from "../lib/allocation.js";
import { createBackup, exclusively } from "../lib/backup.js";
import { loadSetup } from "../lib/dashboard.js";
import { todayIso } from "../lib/dates.js";
import {
  applyImport,
  describeReimport,
  ImportSelectionError,
  importNextSteps,
  reconcileImport,
} from "../lib/import/apply.js";
import { parseImport } from "../lib/import/parse.js";
import { handleValidation } from "../lib/validation.js";

// The one-time migration path off the spreadsheet.
//
// Two endpoints, and the file is uploaded to BOTH. Preview parses and returns
// everything it found; commit re-parses the same file and writes only what the
// operator ticked. Re-parsing rather than trusting the preview payload back is
// deliberate: the reconciliation summary's whole claim is "this is what your
// spreadsheet says", and that claim is worthless if the numbers took a round
// trip through a form the client could have altered. It also means the server
// holds no import session — nothing to expire, nothing to leak.
//
// Both take their multipart body through a zValidator, like every other route
// here. That is not decoration: `hc` types a call from its route's validator,
// so a route without one cannot be reached through the typed client at all,
// and apps/web had to hand-write both the request and the response shape for
// these two (todo.md `[P11-14]`). The size and emptiness checks that used to
// live in `readUpload` are the schema's now.

const UNREADABLE = {
  error: {
    code: "unreadable_workbook",
    message: "That file could not be read as an .xlsx workbook.",
  },
};

/**
 * The uploaded workbook as bytes.
 *
 * `Buffer.alloc` + `set` rather than `Buffer.from(arrayBuffer)`: the copy is
 * trivial at this size and the result is a Buffer over a plain ArrayBuffer,
 * which is what exceljs's reader wants without any casting.
 *
 * @param {File} file
 */
async function toBuffer(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const buffer = Buffer.alloc(bytes.byteLength);
  buffer.set(bytes);
  return buffer;
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
 * `backups` is where the safety backup before a commit goes (lib/backup.js).
 *
 * @param {{ db: import("@budget/schema").Db, backups: { dir: string, appVersion: string } }} deps
 */
export function createImportRoutes({ db, backups }) {
  const app = new Hono();

  /** @param {import("@budget/schema").Db} database */
  const activeAccounts = (database) =>
    database.query.accounts.findMany({ where: (a, { isNull }) => isNull(a.archivedAt) });

  return app
    // Parse and describe. Writes nothing.
    .post("/preview", zValidator("form", importPreviewFormSchema, handleValidation), async (c) => {
      const { file } = c.req.valid("form");
      const accounts = await activeAccounts(db);

      /** @type {import("../lib/import/parse.js").ImportPlan} */
      let preview;
      try {
        preview = await parseImport(await toBuffer(file), {
          fileName: file.name || "workbook.xlsx",
          accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
        });
      } catch (err) {
        console.error("Import preview failed:", err);
        return c.json(UNREADABLE, 400);
      }

      return c.json({
        preview,
        // The date the preview offers as a default for every imported bill
        // and budget. Sent from here rather than computed in the browser so
        // the server's calendar day is the one that gets used.
        defaultAnchorDate: todayIso(),
        accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type })),
        // What importing this file over what is already here would change,
        // row by row, plus the plain rules for what a re-import ever
        // touches. Outside the parse's try: a failure reading the database
        // is a 500, not an unreadable workbook.
        reimport: await describeReimport(db, preview),
      });
    })

    // Re-parse, apply the operator's selection, and report what landed beside
    // what the spreadsheet said.
    .post("/commit", zValidator("form", importCommitFormSchema, handleValidation), async (c) => {
      const form = c.req.valid("form");

      /** @type {unknown} */
      let json;
      try {
        json = JSON.parse(form.selection);
      } catch {
        return c.json({ error: { code: "invalid_request", message: "Import selection is not valid JSON." } }, 400);
      }

      // Validated here rather than in the form schema: a multipart part is a
      // string, so the JSON inside it is a second, nested body with its own
      // failure modes and its own message.
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

      const accounts = await activeAccounts(db);

      /** @type {import("../lib/import/parse.js").ImportPlan} */
      let plan;
      try {
        plan = await parseImport(await toBuffer(form.file), {
          fileName: form.file.name || "workbook.xlsx",
          accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
        });
      } catch (err) {
        console.error("Import commit parse failed:", err);
        return c.json(UNREADABLE, 400);
      }

      // Taken after the file and the selection have been accepted and before
      // anything is written, so a commit that turns out to be a mistake can be
      // undone with Restore. If it can't be taken, the import doesn't go ahead.
      await exclusively(() =>
        createBackup(db, { dir: backups.dir, appVersion: backups.appVersion, kind: "before-import" }),
      );

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

      // Every account a destination now points at, archived or not, by name —
      // so the summary labels each transfer with the account it went to.
      const mappedIds = [...new Set(Object.values(applied.accountIdByDestination))];
      const mappedAccounts =
        mappedIds.length > 0
          ? await db.query.accounts.findMany({ where: (a, { inArray }) => inArray(a.id, mappedIds) })
          : [];

      const reconciliation = reconcileImport({
        plan,
        selection,
        accountIdByDestination: applied.accountIdByDestination,
        accountNameById: Object.fromEntries(mappedAccounts.map((a) => [a.id, a.name])),
        incomeLandingAccountId,
        householdPayCadence: context.hasPrimaryPaySchedule ? context.payCadence : null,
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
        // The cadence the reconciliation's per-pay figures are stated in —
        // the workbook's own where it says, see `reconcileImport` — which is
        // what the summary's "per …" headings have to name. Not necessarily
        // the household's: that is `householdPayCadence`.
        payCadence: reconciliation.cadence.payCadence,
        householdPayCadence: context.hasPrimaryPaySchedule ? context.payCadence : null,
        hasPrimaryPaySchedule: context.hasPrimaryPaySchedule,
        nextSteps: importNextSteps({
          importedPlans: applied.importedPlans,
          incomeLandingAccountId: context.incomeLandingAccountId,
          hasPrimaryPaySchedule: context.hasPrimaryPaySchedule,
          createdAccountNames: applied.createdAccountNames,
          createdBillCount: applied.createdBillCount,
          anchorDate: selection.anchorDate,
        }),
        // The one "still to do" list — the dashboard's setup checklist,
        // derived from the database as it now stands — so this page shows the
        // same list the dashboard keeps after the operator navigates away.
        setup: await loadSetup(db, todayIso()),
      });
    });
}
