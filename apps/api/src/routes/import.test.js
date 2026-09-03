import { importCommitFormSchema, importPreviewFormSchema, MAX_IMPORT_UPLOAD_BYTES } from "@budget/schema";
import { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

beforeAll(async () => {
  workbook = await makeFixtureWorkbook();
});

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await seedSettings(db);
  app = new Hono().route("/import", createImportRoutes({ db }));
});

afterEach(async () => {
  await close();
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
