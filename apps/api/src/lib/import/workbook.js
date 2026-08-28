import { Readable } from "node:stream";
import ExcelJS from "exceljs";

// Cell-level reading for the spreadsheet importer.
//
// The source workbook is a Google Sheets export, and that shapes everything
// here: its formula cells carry `__xludf.DUMMYFUNCTION("…")` wrappers that no
// engine will ever evaluate, so the ONLY trustworthy number in a formula cell
// is the cached result Sheets wrote alongside it. Never try to evaluate a
// formula from this workbook — read `result` (phases/11-polish-mobile-import.md,
// workstream C "Approach").

/**
 * exceljs models a cell's value as one of: a primitive, `{ formula, result }`,
 * `{ sharedFormula, result }`, `{ richText }`, `{ text, hyperlink }`, or an
 * error object. This flattens all of those to the cached display value.
 *
 * @param {import("exceljs").Cell} cell
 * @returns {string | number | boolean | Date | null}
 */
export function cellValue(cell) {
  const value = cell.value;
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    if ("result" in value) {
      const result = value.result;
      // An error result (`#REF!`, `#VALUE!`) is a cell with no usable value,
      // not a value of its own.
      if (result === null || result === undefined || typeof result === "object") return null;
      return result;
    }
    if ("richText" in value) return value.richText.map((run) => run.text).join("");
    if ("text" in value) return value.text;
    if (value instanceof Date) return value;
    return null;
  }
  return value;
}

/**
 * The cached value as trimmed text, or "" when the cell is empty.
 *
 * @param {import("exceljs").Worksheet} sheet
 * @param {number} row
 * @param {number} col
 */
export function text(sheet, row, col) {
  const value = cellValue(sheet.getRow(row).getCell(col));
  if (value === null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

/**
 * The cached value as a finite number, or null. Strings are accepted (a
 * hand-typed "1,061" is still a number the operator meant), but only when
 * they parse cleanly — "Y" and "-" must come back as null, not NaN or 0.
 *
 * @param {import("exceljs").Worksheet} sheet
 * @param {number} row
 * @param {number} col
 */
export function number(sheet, row, col) {
  const value = cellValue(sheet.getRow(row).getCell(col));
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,\s]/g, "");
    if (cleaned === "") return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The cell's formula source, if it has one. Used for exactly one thing: the
 * `=Income!E17` reference that says which income variant a plan sheet divides
 * — and, because two plan sheets share that same reference, the evidence for
 * flag 3 (phases/11-polish-mobile-import.md, workstream C, item 3).
 *
 * @param {import("exceljs").Worksheet} sheet
 * @param {number} row
 * @param {number} col
 */
export function formula(sheet, row, col) {
  const value = sheet.getRow(row).getCell(col).value;
  if (value && typeof value === "object" && "formula" in value && typeof value.formula === "string") {
    return value.formula;
  }
  return null;
}

/**
 * Dollars (as the workbook stores them) to integer cents.
 *
 * `Math.round` rather than a truncation: the workbook holds float artefacts
 * like `1670.4450000000002`, and truncating those loses a cent per row in a
 * way that only shows up as a total that will not reconcile.
 *
 * @param {number} dollars
 * @returns {import("@budget/engine").Cents}
 */
export function toCents(dollars) {
  return Math.round(dollars * 100);
}

/**
 * Loads a workbook from bytes already in memory.
 *
 * Via `read(stream)` rather than the more obvious `load(buffer)`: exceljs
 * ships `declare interface Buffer extends ArrayBuffer {}` in its own
 * index.d.ts, so its `load` signature asks for something a Node Buffer is
 * not and never can be. The stream overload is correctly typed, takes the
 * same bytes, and needs no cast — which matters here, because a cast is how
 * a genuinely wrong argument would get through silently
 * (phases/README.md, "Never use a JSDoc cast to stand in for a `!`").
 *
 * @param {Buffer} buffer
 */
export async function readWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.read(Readable.from(buffer));
  return workbook;
}
