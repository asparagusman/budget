import { bills, importCommitFormSchema, importPreviewFormSchema, MAX_IMPORT_UPLOAD_BYTES, people } from "@budget/schema";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listBackups } from "../lib/backup.js";
import { makeFixtureWorkbook } from "../lib/import/__fixtures__/make-workbook.js";
import { createTestDb } from "../test/db.js";
import { seedSettings } from "../test/household.js";
import { createImportRoutes } from "./import.js";

/** @import { Db } from "@budget/schema" */

// The importer is the app's only multipart surface, and its two routes went
// through a hand-written `fetch` on the client until they grew a validator
// (todo.md `[P11-14]`). These tests are about that boundary: what the
// endpoints accept, what they refuse, and that a real .xlsx survives the form
// parser intact.
//
// EVERY request below attaches a substantial file, and that is not incidental.
// Reading a Request built from an in-memory `FormData` whose total body is
// under 8KB comes back, under vitest, as an 8192-byte buffer with unrelated
// process memory after the real bytes — so the multipart parse fails before
// any handler runs, and a test asserting only "400" would pass for entirely
// the wrong reason. Nothing about the server is involved: over a real socket
// the body arrives as a stream and reads back at its own length. The empty
// and oversized cases are therefore tested against the schema that judges
// them, one describe down, rather than through a request that never arrives.

/** @type {Buffer} */
let workbook;
/** @type {Db} */
let db;
/** @type {() => Promise<void>} */
let close;
/** @type {import("hono").Hono} */
let app;
/** @type {string} */
let backupDir;

beforeAll(async () => {
  workbook = await makeFixtureWorkbook();
});

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await seedSettings(db);
  backupDir = await mkdtemp(path.join(tmpdir(), "budget-import-"));
  app = new Hono().route("/import", createImportRoutes({ db, backups: { dir: backupDir, appVersion: "test" } }));
});

afterEach(async () => {
  await close();
  await rm(backupDir, { recursive: true, force: true });
});

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const workbookFile = () => new File([new Uint8Array(workbook)], "fixture.xlsx", { type: XLSX });

/** @param {"preview" | "commit"} path @param {Blob} file @param {string} [selection] */
function post(path, file, selection) {
  const body = new FormData();
  body.set("file", file, "fixture.xlsx");
  if (selection !== undefined) body.set("selection", selection);
  return app.request(`/import/${path}`, { method: "POST", body });
}

/** @param {Response} res @returns {Promise<any>} */
function json(res) {
  return res.json();
}

describe("the multipart body both endpoints accept", () => {
  const file = () => new File(["x".repeat(64)], "fixture.xlsx", { type: XLSX });

  it("requires a file", () => {
    expect(importPreviewFormSchema.safeParse({}).success).toBe(false);
    // Hono parses a multipart field into either a string or a File. A
    // workbook that arrived as a string is a bug in the caller, not a file to
    // try reading.
    expect(importPreviewFormSchema.safeParse({ file: "fixture.xlsx" }).success).toBe(false);
  });

  it("refuses an empty file rather than reporting an empty workbook", () => {
    const result = importPreviewFormSchema.safeParse({ file: new File([], "fixture.xlsx", { type: XLSX }) });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Attach a .xlsx file");
  });

  it("refuses a file past the size limit", () => {
    const tooBig = new File([new Uint8Array(MAX_IMPORT_UPLOAD_BYTES + 1)], "huge.xlsx", { type: XLSX });
    const result = importPreviewFormSchema.safeParse({ file: tooBig });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("10MB");
  });

  it("requires a selection alongside the file on commit", () => {
    expect(importCommitFormSchema.safeParse({ file: file() }).success).toBe(false);
    expect(importCommitFormSchema.safeParse({ file: file(), selection: "" }).success).toBe(false);
    expect(importCommitFormSchema.safeParse({ file: file(), selection: "{}" }).success).toBe(true);
  });
});

describe("POST /import/preview", () => {
  it("parses an uploaded workbook and offers today as the anchor date", async () => {
    const res = await post("preview", workbookFile());
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.preview.fileName).toBe("fixture.xlsx");
    expect(body.preview.bills.length).toBeGreaterThan(0);
    expect(body.preview.flags.some((/** @type {any} */ f) => f.id.startsWith("duplicate-bill:"))).toBe(true);
    // The anchor is the SERVER's calendar day, not the browser's.
    expect(body.defaultAnchorDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // No accounts exist yet, so every destination is unmapped and nothing is
    // suggested — the operator maps them all before commit will accept it.
    expect(body.accounts).toEqual([]);
    expect(body.preview.destinations.every((/** @type {any} */ d) => d.suggestions.length === 0)).toBe(true);
  });

  it("writes nothing", async () => {
    await post("preview", workbookFile());
    const { bills, people } = await import("@budget/schema");
    expect(await db.$count(bills)).toBe(0);
    expect(await db.$count(people)).toBe(0);
  });

  it("says a file it cannot read is unreadable, rather than failing as a 500", async () => {
    const notAWorkbook = new File(["not a workbook ".repeat(1000)], "notes.txt", { type: "text/plain" });
    const res = await post("preview", notAWorkbook);
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("unreadable_workbook");
  });
});

describe("POST /import/commit", () => {
  /** @type {any} */
  let preview;

  beforeEach(async () => {
    preview = (await json(await post("preview", workbookFile()))).preview;
  });

  /** Every destination mapped to an account created by name. */
  function allDestinations() {
    /** @type {Record<string, any>} */
    const destinations = {};
    for (const destination of preview.destinations) {
      destinations[destination.key] = { create: { name: destination.raw, type: "transaction" } };
    }
    return destinations;
  }

  /** Everything the preview left ticked, which is every row but the duplicate rent one. */
  function allSelected() {
    return [
      ...preview.people.map((/** @type {any} */ p) => p.key),
      ...preview.variants.map((/** @type {any} */ v) => v.key),
      ...preview.variants.flatMap((/** @type {any} */ v) => v.lines.map((/** @type {any} */ l) => l.key)),
      ...preview.fixedCategories.map((/** @type {any} */ c) => c.key),
      ...preview.bills.filter((/** @type {any} */ b) => b.defaultSelected).map((/** @type {any} */ b) => b.key),
      ...preview.variableCategories.map((/** @type {any} */ c) => c.key),
    ];
  }

  /** @param {unknown} selection */
  const commit = (selection) =>
    post("commit", workbookFile(), typeof selection === "string" ? selection : JSON.stringify(selection));

  it("refuses a selection that is not JSON", async () => {
    const res = await commit("{oops");
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toContain("not valid JSON");
  });

  it("refuses a selection that is JSON but not a selection", async () => {
    const res = await commit({ anchorDate: "yesterday" });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.message).toBe("Invalid import selection.");
    // The field errors are what the screen puts next to the offending input.
    expect(Object.keys(body.error.fields)).toContain("anchorDate");
  });

  it("imports the ticked rows and reconciles them against the workbook", async () => {
    const res = await commit({
      anchorDate: "2026-03-13",
      selected: allSelected(),
      destinations: allDestinations(),
      planVariants: {},
    });

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.counts.bills).toBe(7);
    expect(body.counts.people).toBe(2);
    // The duplicate rent row was deselected, so what landed is 17,240.00 a
    // year against the workbook's own 31,420.00 — the gap is exactly the two
    // defects the preview flagged, and the summary is what says so.
    expect(body.reconciliation.fixedCosts.importedPerYearCents).toBe(1_724_000);
    expect(body.reconciliation.fixedCosts.spreadsheetPerYearCents).toBe(3_142_000);
    // Nothing is finished until the operator sets what the workbook cannot
    // say — it holds no pay schedule at all.
    expect(body.hasPrimaryPaySchedule).toBe(false);
    expect(body.nextSteps.length).toBeGreaterThan(0);
  });

  it("takes a before-import backup first, and not for a commit it refuses", async () => {
    await commit({ anchorDate: "yesterday" });
    expect(await listBackups(backupDir)).toEqual([]);

    await commit({ anchorDate: "2026-03-13", selected: allSelected(), destinations: allDestinations(), planVariants: {} });
    const backups = await listBackups(backupDir);
    expect(backups.map((b) => b.kind)).toEqual(["before-import"]);
  });

  it("creates only the accounts it was asked to, by name", async () => {
    await commit({
      anchorDate: "2026-03-13",
      selected: allSelected(),
      destinations: allDestinations(),
      planVariants: {},
    });
    const listed = await db.query.accounts.findMany();
    expect(listed.map((a) => a.name).sort()).toEqual(
      preview.destinations.map((/** @type {any} */ d) => d.raw).sort(),
    );
  });

  it("dates every bill it creates as a placeholder, and hands over to the dashboard's list", async () => {
    const body = await json(
      await commit({ anchorDate: "2026-03-13", selected: allSelected(), destinations: allDestinations(), planVariants: {} }),
    );

    const stored = await db.query.bills.findMany();
    expect(stored.length).toBe(7);
    expect(stored.every((b) => b.anchorDate === "2026-03-13" && b.dueDateConfirmed === false)).toBe(true);

    expect(body.nextSteps.some((/** @type {string} */ s) => s.includes("7 new bills are dated 2026-03-13"))).toBe(true);
    // Pay schedules moved to /income; the old Settings path must not be sent.
    expect(body.nextSteps.join(" ")).not.toContain("Settings");
    expect(body.nextSteps.join(" ")).toContain("Pay schedules on Income");
    expect(body.nextSteps.at(-1)).toContain("dashboard's setup checklist keeps the list");

    // The list itself, derived from the database as it now stands: the same
    // one the dashboard shows, so it outlives this page.
    const keys = body.setup.steps.map((/** @type {any} */ s) => s.key);
    expect(keys).toContain("due_dates");
    const dueDates = body.setup.steps.find((/** @type {any} */ s) => s.key === "due_dates");
    expect(dueDates.label).toBe("Set the real due date of 7 imported bills");
    expect(dueDates.href).toBe("/costs/fixed");
    expect(body.setup.steps.find((/** @type {any} */ s) => s.key === "people").done).toBe(true);
    expect(body.setup.complete).toBe(false);
  });

  it("reconciles in the workbook's own cadence, with the accounts each transfer went to", async () => {
    const usual = preview.plans.find((/** @type {any} */ p) => p.name === "Usual");
    const body = await json(
      await commit({
        anchorDate: "2026-03-13",
        selected: [...allSelected(), ...usual.lines.map((/** @type {any} */ l) => l.key)],
        destinations: allDestinations(),
        planVariants: {},
      }),
    );

    // No pay schedule exists, which used to mean monthly — and every variant
    // reading "differs" against the workbook's fortnightly totals.
    expect(body.hasPrimaryPaySchedule).toBe(false);
    expect(body.householdPayCadence).toBeNull();
    expect(body.reconciliation.cadence).toEqual({ payCadence: "fortnightly", source: "workbook" });
    expect(body.payCadence).toBe("fortnightly");
    for (const variant of body.reconciliation.variants) {
      expect(variant.importedPerPayCents, variant.name).toBe(variant.spreadsheetPerPayCents);
    }

    const [plan] = body.reconciliation.plans;
    expect(plan.reconciles).toBe(true);
    // Every imported transfer is labelled with the account it went to, and
    // with the workbook's own words for it.
    for (const transfer of plan.importedTransfers) {
      expect(transfer.accountName).toEqual(expect.any(String));
      expect(transfer.destinations.length).toBeGreaterThan(0);
    }
    const house = plan.importedTransfers.find((/** @type {any} */ t) => t.accountName === "to ubank (House)");
    expect(house.destinations).toEqual(["to ubank (House)"]);
    // And the workbook's own transfer list lines up against the same accounts.
    const sheetHouse = plan.spreadsheetTransfers.find((/** @type {any} */ t) => t.label === "ubank (House)");
    expect(sheetHouse.accountId).toBe(house.accountId);
    expect(sheetHouse.accountName).toBe("to ubank (House)");
  });

  it("re-imports without touching archived rows or anything the operator tuned", async () => {
    const selection = { anchorDate: "2026-03-13", selected: allSelected(), destinations: allDestinations(), planVariants: {} };
    await commit(selection);

    // The operator's work since the first import: Power gets a real due date,
    // an escalation model, a new amount and a place in the list; Water is
    // archived; and Ada is archived as a person.
    const power = await db.query.bills.findFirst({ where: eq(bills.name, "Power") });
    const water = await db.query.bills.findFirst({ where: eq(bills.name, "Water") });
    const ada = await db.query.people.findFirst({ where: eq(people.name, "Ada") });
    if (!power || !water || !ada) throw new Error("the first import did not land");
    await db
      .update(bills)
      .set({
        anchorDate: "2026-04-10",
        dueDateConfirmed: true,
        amountModel: "escalating",
        escalationPct: 3,
        baseAmountCents: 50_000,
        sortOrder: 42,
      })
      .where(eq(bills.id, power.id));
    const archivedAt = new Date("2026-03-20T00:00:00Z");
    await db.update(bills).set({ archivedAt }).where(eq(bills.id, water.id));
    await db.update(people).set({ archivedAt }).where(eq(people.id, ada.id));

    // The preview says what a re-import would overwrite before anything is written.
    const again = await json(await post("preview", workbookFile()));
    expect(again.reimport.matchedCount).toBeGreaterThan(0);
    expect(again.reimport.rules.some((/** @type {string} */ r) => r.startsWith("Bills: only the amount and the frequency"))).toBe(true);
    const powerRow = again.preview.bills.find((/** @type {any} */ b) => b.name === "Power");
    const overwrite = again.reimport.overwrites.find((/** @type {any} */ o) => o.rowKeys.includes(powerRow.key));
    expect(overwrite.kind).toBe("bill");
    expect(overwrite.changes).toEqual([{ field: "amount", from: 50_000, to: 42_000 }]);
    expect(overwrite.message).toBe("Power (Utilities): amount 500.00 → 420.00.");
    // An archived row is not matched, so it can't be overwritten either.
    const waterRow = again.preview.bills.find((/** @type {any} */ b) => b.name === "Water");
    expect(again.reimport.overwrites.some((/** @type {any} */ o) => o.rowKeys.includes(waterRow.key))).toBe(false);

    const res = await commit({ ...selection, anchorDate: "2026-03-27" });
    expect(res.status).toBe(200);

    // Power took the workbook's amount and kept everything else.
    const tuned = await db.query.bills.findFirst({ where: eq(bills.id, power.id) });
    expect(tuned).toMatchObject({
      baseAmountCents: 42_000,
      frequency: "quarterly",
      amountModel: "escalating",
      escalationPct: 3,
      anchorDate: "2026-04-10",
      dueDateConfirmed: true,
      sortOrder: 42,
    });

    // The archived Water was left exactly as it was, and a visible one exists.
    const waters = await db.query.bills.findMany({ where: eq(bills.name, "Water") });
    expect(waters).toHaveLength(2);
    const untouched = waters.find((b) => b.id === water.id);
    expect(untouched?.archivedAt).toEqual(archivedAt);
    const fresh = waters.find((b) => b.id !== water.id);
    expect(fresh).toMatchObject({ archivedAt: null, anchorDate: "2026-03-27", dueDateConfirmed: false });

    // Same for the archived person: a new, live Ada rather than income lines
    // quietly attached to someone nobody can see.
    const adas = await db.query.people.findMany({ where: eq(people.name, "Ada") });
    expect(adas.filter((p) => p.archivedAt === null)).toHaveLength(1);
    const incomeLines = await db.query.incomeLines.findMany({ where: (l, { eq: eqCol }) => eqCol(l.personId, ada.id) });
    const before = incomeLines.length;
    expect(before).toBeGreaterThan(0);
    const liveAda = adas.find((p) => p.archivedAt === null);
    const liveLines = await db.query.incomeLines.findMany({
      where: (l, { eq: eqCol }) => eqCol(l.personId, liveAda?.id ?? ""),
    });
    expect(liveLines.length).toBe(before);
  });

  it("refuses to invent an account for an unmapped destination", async () => {
    const res = await commit({
      anchorDate: "2026-03-13",
      // A plan LINE is what needs a destination; the plan's own key alone
      // imports nothing and needs nothing.
      selected: [...allSelected(), ...preview.plans[0].lines.map((/** @type {any} */ l) => l.key)],
      destinations: {},
      planVariants: {},
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe("invalid_selection");
    expect(body.error.message).toContain("Still unmapped");
  });
});
