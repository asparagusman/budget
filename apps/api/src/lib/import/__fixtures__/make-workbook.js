import ExcelJS from "exceljs";

// A synthetic workbook with the SHAPE of the household's source spreadsheet
// and none of its figures.
//
// The real workbook is gitignored — it holds the household's actual financial
// position — so before this file existed a fresh clone ran one placeholder
// test instead of the parser suite, and every structural rule the importer
// implements was uncovered on any machine but one (todo.md `[P11-15]`).
//
// It is a GENERATOR rather than a committed .xlsx because the four defects
// below are the whole point of the fixture, and a defect encoded in a binary
// blob is one nobody can see in a diff. Every quirk here is deliberate and
// commented:
//
//   1. Two Rent rows with no item name of their own, so both take their
//      category's name and the second reads as a duplicate.
//   2. A Car subtotal that omits its own "& LP" rows.
//   3. Two plan sheets whose gross formula points at one income row.
//   4. Free-text transfer destinations that need mapping to accounts.
//
// Google Sheets exports its formulas as `__xludf.DUMMYFUNCTION` wrappers with
// the real number cached beside them, so the gross cells here are written as
// `{ formula, result }` too — the parser reads the cached result and must
// never try to evaluate the formula (see workbook.js).

/** @typedef {string | number | null} CellValue */

/**
 * Writes a sheet from a row-major grid. `null` leaves a cell genuinely empty,
 * which several of the parser's rules turn on — an empty column B is what
 * makes a bill take its category's name.
 *
 * @param {ExcelJS.Workbook} workbook
 * @param {string} name
 * @param {CellValue[][]} grid
 */
function addSheet(workbook, name, grid) {
  const sheet = workbook.addWorksheet(name);
  for (const [r, row] of grid.entries()) {
    for (const [c, value] of row.entries()) {
      if (value === null || value === undefined) continue;
      sheet.getRow(r + 1).getCell(c + 1).value = value;
    }
  }
  return sheet;
}

// Income: four blocks, each a "Person" header, one row per person, and a
// "Total (Fortnightly)" row. The first block has no title — it is the
// household's ordinary income, which the plan sheets call "Usual".
//
// The total ROWS are load-bearing: a plan sheet says which variant it divides
// by pointing a formula at one of them, so 5, 11, 17 and 23 below are what
// `=Income!$E$11` in two different sheets ends up meaning.
const INCOME = [
  [null],
  ["Person ", "Amount", "Frequency"],
  ["Ada", 3000, "Fortnightly"],
  // Bracketed: one person with a labelled line, not a second person.
  ["Ben (gov)", 2200, "Fortnightly"],
  ["Total (Fortnightly)", 5200],
  [null],
  ["PL Gov (High)"],
  ["Person ", "Amount", "Frequency"],
  ["Ada", 900, "Fortnightly"],
  ["Ben (gov)", 2200, "Fortnightly"],
  ["Total (Fortnightly)", 3100],
  [null],
  ["PL Torch (Low)"],
  ["Person ", "Amount", "Frequency"],
  ["Ada", 900, "Fortnightly"],
  ["Ben", 1500, "Fortnightly"],
  ["Total (Fortnightly)", 2400],
  [null],
  ["PL Balanced"],
  ["Person ", "Amount", "Frequency"],
  ["Ada", 900, "Fortnightly"],
  ["Ben", 1850, "Fortnightly"],
  ["Total (Fortnightly)", 2750],
];

/** The income row each variant's "Total (Fortnightly)" sits on. */
export const INCOME_TOTAL_ROWS = { usual: 5, govHigh: 11, torchLow: 17, balanced: 23 };

// Fixed Costs: A category (carried down), B item, C amount, D..G a "Y" in
// exactly one period column, H the annual figure. Hand-typed "Subtotal" rows
// and a TOTAL block at the bottom.
const FIXED_COSTS = [
  ["Category", "Item", "Amount", "Monthly", "Bimonthly", "Quarterly", "Yearly", "Yearly $"],
  // Defect 1. Neither Rent row names itself, so both import as "Rent" and the
  // second is a duplicate of the first — which is exactly how the real
  // workbook's phantom rent row reads.
  ["Rent", null, 1200, "Y", null, null, null, 14400],
  [null, null, 1200, "Y", null, null, null, 14400],
  [null, "Subtotal", null, null, null, null, null, 28800],
  ["Car", "Ambulance Cover", 100, null, null, null, "Y", 100],
  // "& LP" is the partner's copy of the row above: a second real bill with no
  // name of its own.
  [null, "& LP", 100, null, null, null, "Y", 100],
  [null, "Roadside Assist", 120, null, null, null, "Y", 120],
  [null, "& LP", 120, null, null, null, "Y", 120],
  // Defect 2. 220.00, when the four rows above it add up to 440.00 — a
  // hand-typed range that missed both "& LP" rows.
  [null, "Subtotal", null, null, null, null, null, 220],
  ["Utilities", "Power", 420, null, null, "Y", null, 1680],
  [null, "Water", 180, null, null, "Y", null, 720],
  [null, "Subtotal", null, null, null, null, null, 2400],
  ["TOTAL"],
  // 28800 + 220 + 2400: the workbook's own grand total, and therefore one
  // that carries the Car omission with it.
  [null, "Yearly", null, null, null, null, null, 31420],
];

// Variable Costs: a group in A that carries down, an item in B, a monthly
// amount in C. The quoted item exercises the parser's quote stripping.
const VARIABLE_COSTS = [
  ["Group", "Item", "Monthly"],
  ["Essentials", "Groceries", 1200],
  [null, "Fuel", 400],
  [null, "Subtotal", 1600],
  ["Non-Essentials", '"Good Life"', 650],
  [null, "Subtotal", 650],
  [null, "Total", 2250],
];

// Projections: an opening balance in B and a MONTHLY growth rate in D. The
// app stores growth annually, so 0.0041/month has to compound to 0.050325/yr
// rather than multiply to 0.0492.
const PROJECTIONS = [
  ["Account", "Current", "Notes", "Monthly rate"],
  ["House", 25403, null, 0.0041],
  ["Raiz", 8200, null, 0.0055],
  ["Mojo", 9500, null, 0.0041],
];

/**
 * One allocation plan sheet. Stages are separated by "Subtotal"/"Remaining"
 * rows rather than by fixed row numbers, so `extraStage2` can add a row to
 * one sheet without every later row moving in the parser's eyes — which is
 * the property the real "PL Buffer" row tests.
 *
 * @param {{
 *   title: string,
 *   incomeRow: number,
 *   grossPerMonth: number,
 *   grossPerPay: number,
 *   extraStage2?: CellValue[],
 * }} spec
 */
function planSheet({ title, incomeRow, grossPerMonth, grossPerPay, extraStage2 }) {
  /** @type {CellValue[][]} */
  const rows = [
    [title],
    // Defect 3 lives here: two sheets are given the same `incomeRow`, so both
    // claim to divide one income variant. The cached result is what the
    // parser reads; the formula is only ever read as evidence of which row.
    ["Gross (Monthly)", /** @type {any} */ ({ formula: `Income!$E$${incomeRow}`, result: grossPerMonth })],
    [null],
    ["Gross (Per Pay)", grossPerPay],
    // Defect 4: destinations, here and in column K below, are free text.
    ["Transfers", "ubank (House)", "ubank (Mojo)", "2UP"],
    [null, 800, 1126.67, 3103.33, 5030],
    ["Category", "Division", "% Gross", "% Remaining", "Monthly", null, null, "Goal %", null, null, "Destination"],
    // Stage 1: the two totals carried in from the other sheets. The app makes
    // that explicit as a basis; the spreadsheet only implied it by position.
    ["Stage 1", "Fixed", null, null, 2636.67, null, null, null, null, null, "Income + Bills (No move required)"],
    [null, "Variable", null, null, 1600, null, null, null, null, null, "Income + Bills (No move required)"],
    [null, "Subtotal", null, null, 4236.67],
    [null, "Remaining", null, null, 7030],
    ["Stage 2", "Mojo", 10, null, 1126.67, null, null, 10, null, null, "to ubank (Mojo)"],
    [null, "House", 7.1, null, 800, null, null, 8, null, null, "to ubank (House)"],
    [null, "Giving", 5, null, 563.33, null, null, 5, null, null, "to ubank (Generosity)"],
    [null, "Investing", 4, null, 450.67, null, null, 5, null, null, "to Raiz"],
  ];
  if (extraStage2) rows.push(extraStage2);
  rows.push(
    [null, "Subtotal", null, null, 2940.67],
    [null, "Remaining", null, null, 4089.33],
    // Stage 3 divides what is left, so its percentages are of the remainder.
    ["Stage 3", "Spending", null, 75, 3067, null, null, null, null, null, "to 2UP"],
    [null, "Buffer", null, 25, 1022.33, null, null, null, null, null, "Income + Bills (No move required)"],
    ["Total", null, null, null, 11266.67],
  );
  return rows;
}

/**
 * The whole fixture workbook as bytes, ready for `parseImport`.
 *
 * Generated once per caller and reused: two `write()` calls produce different
 * zip bytes, and the parser's file hash is meant to be a property of the
 * WORKBOOK, not of the moment it was written.
 *
 * @returns {Promise<Buffer>}
 */
export async function makeFixtureWorkbook() {
  const workbook = new ExcelJS.Workbook();

  addSheet(workbook, "Income", INCOME);
  addSheet(workbook, "Fixed Costs", FIXED_COSTS);
  addSheet(workbook, "Variable Costs", VARIABLE_COSTS);
  addSheet(workbook, "Projections", PROJECTIONS);

  addSheet(
    workbook,
    "Income Division",
    planSheet({ title: "Phase 1I", incomeRow: INCOME_TOTAL_ROWS.usual, grossPerMonth: 11266.67, grossPerPay: 5200 }),
  );
  // These two both point at the high-leave income row, and both carry the
  // same in-sheet title — the workbook's own copy-paste, preserved.
  addSheet(
    workbook,
    "PL (Gov)",
    planSheet({ title: "Phase 1I", incomeRow: INCOME_TOTAL_ROWS.govHigh, grossPerMonth: 6716.67, grossPerPay: 3100 }),
  );
  addSheet(
    workbook,
    "PL (Torch)",
    planSheet({ title: "Phase 1I", incomeRow: INCOME_TOTAL_ROWS.govHigh, grossPerMonth: 5200, grossPerPay: 2400 }),
  );
  addSheet(
    workbook,
    "PL Balanced",
    planSheet({
      title: "Phase 1B",
      incomeRow: INCOME_TOTAL_ROWS.balanced,
      grossPerMonth: 5958.33,
      grossPerPay: 2750,
      // A flat amount where every other stage-2 row is a percentage. This is
      // the row that only parses correctly because stages are walked.
      extraStage2: [null, "PL Buffer", null, null, 489.14, null, null, null, null, null, "Income + Bills (No move required)"],
    }),
  );

  // Named in the phase doc as skipped, and reported as skipped rather than
  // silently dropped.
  addSheet(workbook, "Assets", [[null]]);
  addSheet(workbook, "Income Division_OLD", [["Phase 1H"], ["Superseded"]]);

  const written = await workbook.xlsx.writeBuffer();
  return Buffer.from(written);
}
