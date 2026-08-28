import { readApiError } from "@/lib/api-error.js";

/** @import { Cadence, Cents } from "@budget/engine" */

// The importer is the one place the Hono RPC client cannot carry: `hc` types
// a route's body from its zValidator, and a multipart upload has none to type
// from — the file is read with `c.req.parseBody()` inside the handler. So
// these two calls go through `fetch` with a hand-written response shape.
//
// Everything else in apps/web goes through `api` in lib/api.js. Do not copy
// this pattern for a JSON endpoint; there it would throw away real types for
// nothing.

const apiUrl = import.meta.env.VITE_API_URL;

/** @typedef {{ key: string, name: string }} Named */

/**
 * @typedef {{
 *   key: string,
 *   personName: string,
 *   label: string | null,
 *   amountCents: Cents,
 *   cadence: Cadence,
 *   sourceRow: number,
 * }} PreviewIncomeLine
 */

/**
 * @typedef {{
 *   key: string,
 *   categoryName: string,
 *   name: string,
 *   amountCents: Cents,
 *   frequency: Cadence,
 *   perYearCents: Cents,
 *   sourceRow: number,
 *   defaultSelected: boolean,
 * }} PreviewBill
 */

/**
 * @typedef {{
 *   key: string,
 *   stage: number,
 *   label: string,
 *   basis: string,
 *   value: number | null,
 *   goalPct: number | null,
 *   destination: string,
 *   destinationKey: string | null,
 *   monthlyCents: Cents | null,
 *   sourceRow: number,
 * }} PreviewPlanLine
 */

/**
 * @typedef {{
 *   fileName: string,
 *   fileHash: string,
 *   people: Named[],
 *   variants: { key: string, name: string, totalRow: number, spreadsheetTotalPerPayCents: Cents | null, lines: PreviewIncomeLine[] }[],
 *   fixedCategories: Named[],
 *   bills: PreviewBill[],
 *   variableCategories: { key: string, name: string, isEssential: boolean, monthlyCents: Cents, sourceRow: number }[],
 *   plans: {
 *     key: string, name: string, sheet: string, title: string,
 *     variantKey: string | null, variantAmbiguous: boolean,
 *     lines: PreviewPlanLine[],
 *     spreadsheetTransfers: { label: string, amountCents: Cents }[],
 *     spreadsheetTransferTotalCents: Cents | null,
 *     spreadsheetGrossPerMonthCents: Cents | null,
 *     spreadsheetGrossPerPayCents: Cents | null,
 *   }[],
 *   balances: { key: string, accountName: string, destinationKey: string, amountCents: Cents, monthlyRate: number | null, annualGrowthRate: number | null, sourceRow: number }[],
 *   destinations: { key: string, raw: string, usedBy: string[], suggestions: { accountId: string, name: string, score: number }[] }[],
 *   ignoredSheets: { name: string, reason: string }[],
 *   flags: { id: string, severity: "warning" | "info", title: string, detail: string, rowKeys: string[], defaultDeselected: boolean }[],
 *   spreadsheet: {
 *     fixedTotalPerYearCents: Cents | null,
 *     variableEssentialsPerMonthCents: Cents | null,
 *     variableTotalPerMonthCents: Cents | null,
 *   },
 * }} ImportPreview
 */

/**
 * @typedef {{
 *   preview: ImportPreview,
 *   defaultAnchorDate: string,
 *   accounts: { id: string, name: string, type: "transaction" | "savings" | "investment" | "external" }[],
 * }} ImportPreviewResponse
 */

/**
 * @typedef {{ accountId: string } | { create: { name: string, type: "transaction" | "savings" | "investment" | "external" } }} DestinationChoice
 */

/**
 * @typedef {{
 *   counts: Record<string, number>,
 *   createdAccountNames: string[],
 *   payCadence: Cadence,
 *   hasPrimaryPaySchedule: boolean,
 *   nextSteps: string[],
 *   reconciliation: {
 *     fixedCosts: { spreadsheetPerYearCents: Cents | null, importedPerYearCents: Cents, importedPerMonthCents: Cents, billCount: number, notes: string[] },
 *     variableEssentials: { spreadsheetPerMonthCents: Cents | null, importedPerMonthCents: Cents },
 *     variableNonEssential: { spreadsheetPerMonthCents: Cents | null, importedPerMonthCents: Cents },
 *     variants: { name: string, spreadsheetPerPayCents: Cents | null, importedPerPayCents: Cents, lineCount: number }[],
 *     plans: {
 *       name: string, sheet: string, variantName: string | null,
 *       grossPerPayCents: Cents, spreadsheetGrossPerPayCents: Cents | null,
 *       spreadsheetTransfers: { label: string, amountCents: Cents }[],
 *       spreadsheetTransferTotalCents: Cents | null,
 *       importedTransfers: { accountId: string, perPayCents: Cents, isNoOp: boolean }[],
 *       importedTotalPerPayCents: Cents,
 *       reconciles: boolean,
 *       unallocatedPerMonthCents: Cents,
 *     }[],
 *   },
 * }} ImportResult
 */

/**
 * @param {File} file
 * @returns {Promise<ImportPreviewResponse>}
 */
export async function fetchImportPreview(file) {
  const body = new FormData();
  body.set("file", file);
  const res = await fetch(`${apiUrl}/import/preview`, { method: "POST", credentials: "include", body });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}

/**
 * @param {File} file
 * @param {{
 *   anchorDate: string,
 *   selected: string[],
 *   destinations: Record<string, DestinationChoice>,
 *   planVariants: Record<string, string>,
 * }} selection
 * @returns {Promise<ImportResult>}
 */
export async function commitImport(file, selection) {
  const body = new FormData();
  body.set("file", file);
  body.set("selection", JSON.stringify(selection));
  const res = await fetch(`${apiUrl}/import/commit`, { method: "POST", credentials: "include", body });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json();
}
