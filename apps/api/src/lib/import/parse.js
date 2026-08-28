import { createHash } from "node:crypto";
import { equivalent } from "@budget/engine";
import { formula, number, readWorkbook, text, toCents } from "./workbook.js";

/** @import { Cadence, Cents } from "@budget/engine" */

// Turns the household's source workbook into a fully described import plan.
// Nothing here writes to the database — this module's whole job is to say what
// the spreadsheet contains, what it will become, and what is wrong with it.
// Applying the plan is apply.js.
//
// Two rules shape the code below:
//
//   1. Every value comes from a CACHED cell result. The workbook is a Google
//      Sheets export whose formulas are `__xludf.DUMMYFUNCTION` wrappers no
//      engine can evaluate (see workbook.js).
//   2. Every defect is surfaced, never silently handled. The four known ones
//      are listed in phases/11-polish-mobile-import.md and are detected here
//      by their shape — a duplicate (category, name); a category subtotal that
//      does not equal its own members; two sheets pointing at one income row —
//      not by hardcoded row numbers. A workbook edited since that doc was
//      written must still be checked, and a row that moved must still be
//      caught.

/** Rows whose key appears in `selected` are imported; everything else is not. */
/** @typedef {string} RowKey */

/** @typedef {"warning" | "info"} FlagSeverity */

/**
 * @typedef {{
 *   id: string,
 *   severity: FlagSeverity,
 *   title: string,
 *   detail: string,
 *   rowKeys: RowKey[],
 *   defaultDeselected: boolean,
 * }} ImportFlag
 */

const CADENCE_BY_LABEL = /** @type {Record<string, Cadence>} */ ({
  weekly: "weekly",
  fortnightly: "fortnightly",
  monthly: "monthly",
  bimonthly: "every_2_months",
  "every 2 months": "every_2_months",
  quarterly: "quarterly",
  "every 6 months": "every_6_months",
  yearly: "yearly",
  annually: "yearly",
});

// Fixed Costs columns D..G are mutually exclusive "Y" flags naming the bill's
// period. "Bimonthly" is the workbook's word for every two months; the app
// deliberately has no such value (see packages/schema pay-schedules.js).
/** @type {[number, Cadence][]} */
const FIXED_PERIOD_COLUMNS = [
  [4, "monthly"],
  [5, "every_2_months"],
  [6, "quarterly"],
  [7, "yearly"],
];

/** @param {string} label */
function cadenceFromLabel(label) {
  return CADENCE_BY_LABEL[label.trim().toLowerCase()] ?? null;
}

/**
 * "Grace (gov)" is one person with a labelled income line, not a second
 * person. Splitting on the parenthetical is the whole rule, and it is
 * reported in the preview rather than applied quietly — a household where
 * someone's actual name contains brackets would need to know.
 *
 * @param {string} raw
 */
function splitPerson(raw) {
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(raw.trim());
  if (!match) return { name: raw.trim(), label: /** @type {string | null} */ (null) };
  const name = (match[1] ?? "").trim();
  const qualifier = (match[2] ?? "").trim();
  return {
    name: name || raw.trim(),
    label: qualifier ? qualifier.charAt(0).toUpperCase() + qualifier.slice(1) : null,
  };
}

/** @param {string} raw */
function stripQuotes(raw) {
  return raw.replace(/^["']+|["']+$/g, "").trim();
}

/**
 * The `Income` sheet: four blocks, each a "Person " header followed by one row
 * per person and a "Total (Fortnightly)" row. The first block has no title of
 * its own — it is the household's ordinary income, and the plan sheets call it
 * "Usual".
 *
 * @param {import("exceljs").Worksheet} sheet
 */
function parseIncome(sheet) {
  /** @type {{ key: RowKey, name: string, headerRow: number, totalRow: number, spreadsheetTotalCents: Cents | null, lines: { key: RowKey, personName: string, label: string | null, amountCents: Cents, cadence: Cadence, sourceRow: number }[] }[]} */
  const variants = [];
  /** @type {Set<string>} */
  const people = new Set();

  for (let row = 1; row <= sheet.rowCount; row += 1) {
    if (text(sheet, row, 1).toLowerCase() !== "person") continue;

    // The block's title sits in column A of the row above the header. The
    // first block has none, and is the baseline the plan sheets divide.
    const title = row > 1 ? text(sheet, row - 1, 1) : "";
    const name = title && !title.toLowerCase().startsWith("person") ? title : "Usual";

    /** @type {{ key: RowKey, personName: string, label: string | null, amountCents: Cents, cadence: Cadence, sourceRow: number }[]} */
    const lines = [];
    let totalRow = row;
    /** @type {Cents | null} */
    let spreadsheetTotalCents = null;

    for (let r = row + 1; r <= sheet.rowCount; r += 1) {
      const label = text(sheet, r, 1);
      if (label === "") break;
      if (label.toLowerCase().startsWith("total")) {
        totalRow = r;
        const total = number(sheet, r, 2);
        spreadsheetTotalCents = total === null ? null : toCents(total);
        break;
      }
      const amount = number(sheet, r, 2);
      const cadence = cadenceFromLabel(text(sheet, r, 3));
      if (amount === null || cadence === null) continue;
      const person = splitPerson(label);
      people.add(person.name);
      lines.push({
        key: `income:${r}`,
        personName: person.name,
        label: person.label,
        amountCents: toCents(amount),
        cadence,
        sourceRow: r,
      });
    }

    if (lines.length > 0) {
      variants.push({ key: `variant:${row}`, name, headerRow: row, totalRow, spreadsheetTotalCents, lines });
    }
  }

  return { variants, people: [...people] };
}

/**
 * The `Fixed Costs` sheet: one row per bill, grouped by a category name that
 * only appears on the group's first row, with hand-typed "Subtotal" rows the
 * new model does not need (it derives subtotals from category membership).
 *
 * Those subtotal rows are still READ, because comparing each one against its
 * own members is how the Car-category omission is detected rather than
 * assumed.
 *
 * @param {import("exceljs").Worksheet} sheet
 */
function parseFixedCosts(sheet) {
  /** @type {{ key: RowKey, categoryName: string, name: string, amountCents: Cents, frequency: Cadence, annualCents: Cents | null, sourceRow: number, derivedName: boolean }[]} */
  const bills = [];
  /** @type {string[]} */
  const categories = [];
  /** @type {Map<string, { memberAnnualCents: Cents, subtotalAnnualCents: Cents | null, subtotalRow: number | null }>} */
  const subtotals = new Map();

  let currentCategory = "";
  let lastItemName = "";
  /** @type {Cents | null} */
  let spreadsheetAnnualTotalCents = null;

  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const colA = text(sheet, row, 1);
    const colB = text(sheet, row, 2);

    // The TOTAL block at the bottom restates the grand total at six
    // cadences. Its yearly figure is the number the reconciliation compares
    // against; nothing below it is a bill.
    if (colA.toUpperCase() === "TOTAL") {
      for (let r = row; r <= sheet.rowCount; r += 1) {
        if (text(sheet, r, 2).toLowerCase() === "yearly") {
          const yearly = number(sheet, r, 8);
          spreadsheetAnnualTotalCents = yearly === null ? null : toCents(yearly);
        }
      }
      break;
    }

    if (colA !== "") {
      currentCategory = colA;
      if (!categories.includes(colA)) categories.push(colA);
    }

    if (colB.toLowerCase() === "subtotal") {
      const cached = number(sheet, row, 8);
      const entry = subtotals.get(currentCategory) ?? { memberAnnualCents: 0, subtotalAnnualCents: null, subtotalRow: null };
      entry.subtotalAnnualCents = cached === null ? null : toCents(cached);
      entry.subtotalRow = row;
      subtotals.set(currentCategory, entry);
      continue;
    }

    const amount = number(sheet, row, 3);
    if (amount === null || currentCategory === "") continue;

    const frequency = FIXED_PERIOD_COLUMNS.find(([col]) => text(sheet, row, col).toUpperCase() === "Y")?.[1];
    if (!frequency) continue;

    // "& LP" is the workbook's shorthand for the partner's copy of the row
    // above — a second real bill, not a continuation of the first.
    let name = colB;
    let derivedName = false;
    if (name === "" || name === "&" || /^&\s*lp$/i.test(name)) {
      name = name === "" ? currentCategory : `${lastItemName} (LP)`;
      derivedName = true;
    } else {
      lastItemName = name;
    }

    const annual = number(sheet, row, 8);
    const annualCents = annual === null ? null : toCents(annual);

    const entry = subtotals.get(currentCategory) ?? { memberAnnualCents: 0, subtotalAnnualCents: null, subtotalRow: null };
    entry.memberAnnualCents += annualCents ?? 0;
    subtotals.set(currentCategory, entry);

    bills.push({
      key: `bill:${row}`,
      categoryName: currentCategory,
      name,
      amountCents: toCents(amount),
      frequency,
      annualCents,
      sourceRow: row,
      derivedName,
    });
  }

  return { bills, categories, subtotals, spreadsheetAnnualTotalCents };
}

/**
 * The `Variable Costs` sheet: a group name in column A ("Essentials",
 * "Non-Essentials") that carries down, an item in column B, and a monthly
 * amount in column C. "Good Life" imports as non-essential, which is what the
 * group it sits in says, and what phase 07 means by the flag.
 *
 * @param {import("exceljs").Worksheet} sheet
 */
function parseVariableCosts(sheet) {
  /** @type {{ key: RowKey, name: string, isEssential: boolean, monthlyCents: Cents, sourceRow: number }[]} */
  const categories = [];
  /** @type {Cents | null} */
  let essentialsSubtotalCents = null;
  /** @type {Cents | null} */
  let totalCents = null;
  let essential = true;

  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const group = text(sheet, row, 1);
    const item = text(sheet, row, 2);
    if (group !== "") essential = !/non/i.test(group);

    const monthly = number(sheet, row, 3);
    if (item.toLowerCase() === "subtotal") {
      if (essential && monthly !== null) essentialsSubtotalCents = toCents(monthly);
      continue;
    }
    if (item.toLowerCase() === "total") {
      if (monthly !== null) totalCents = toCents(monthly);
      continue;
    }
    if (item === "" || monthly === null) continue;

    categories.push({
      key: `variable:${row}`,
      name: stripQuotes(item),
      isEssential: essential,
      monthlyCents: toCents(monthly),
      sourceRow: row,
    });
  }

  return { categories, essentialsSubtotalCents, totalCents };
}

/**
 * One allocation plan sheet. Its structure is walked rather than indexed by
 * row: "Subtotal" closes a stage and "Remaining" opens the next, which is
 * what makes `PL Balanced` — seven stage-2 rows where the others have six —
 * parse correctly without a special case.
 *
 * @param {import("exceljs").Worksheet} sheet
 * @param {string} planName
 */
function parsePlanSheet(sheet, planName) {
  let headerRow = 0;
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    if (text(sheet, row, 1) === "Category" && text(sheet, row, 2) === "Division") {
      headerRow = row;
      break;
    }
  }
  if (headerRow === 0) return null;

  /** @type {{ key: RowKey, stage: number, label: string, basis: string, value: number | null, goalPct: number | null, destination: string, destinationKey: string | null, monthlyCents: Cents | null, sourceRow: number }[]} */
  const lines = [];
  let stage = 1;

  for (let row = headerRow + 1; row <= sheet.rowCount; row += 1) {
    const colA = text(sheet, row, 1);
    const colB = text(sheet, row, 2);
    if (colA.toLowerCase() === "total") break;
    if (colB.toLowerCase() === "subtotal") continue;
    if (colB.toLowerCase() === "remaining") {
      stage += 1;
      continue;
    }
    if (colB === "") continue;

    const pctOfGross = number(sheet, row, 3);
    const pctOfRemaining = number(sheet, row, 4);
    const monthly = number(sheet, row, 5);
    const goalPct = number(sheet, row, 8);
    const destination = text(sheet, row, 11);

    // The spreadsheet encoded basis POSITIONALLY and said nothing about it;
    // making it explicit is the point of the app's allocation model
    // (phases/08-allocation.md "Why explicit basis"). Stage 1's two rows are
    // the fixed and variable totals carried in from other sheets; a stage-2
    // row with a percentage is a percentage of gross; a stage-3 row's
    // percentage is of what is left. Anything else with only a monthly
    // figure is a flat amount.
    /** @type {string} */
    let basis;
    /** @type {number | null} */
    let value = null;
    if (stage === 1 && /^fixed$/i.test(colB)) {
      basis = "from_fixed_costs";
    } else if (stage === 1 && /^variable$/i.test(colB)) {
      basis = "from_variable_essentials";
    } else if (stage <= 2 && pctOfGross !== null) {
      basis = "pct_of_gross";
      value = pctOfGross;
    } else if (pctOfRemaining !== null) {
      basis = "pct_of_remaining";
      value = pctOfRemaining;
    } else if (monthly !== null) {
      basis = "fixed_amount";
      value = toCents(monthly);
    } else {
      continue;
    }

    lines.push({
      key: `plan:${sheet.name}:${row}`,
      stage,
      label: colB,
      basis,
      value,
      goalPct,
      destination,
      destinationKey: destination === "" ? null : `dest:${normaliseDestination(destination)}`,
      monthlyCents: monthly === null ? null : toCents(monthly),
      sourceRow: row,
    });
  }

  // `=Income!E17` in B2 is the sheet's own statement of which variant it
  // divides. Two sheets naming the same row is the evidence for flag 3.
  const sourceFormula = formula(sheet, 2, 2) ?? "";
  const variantRefRow = Number(/Income!\$?E\$?(\d+)/.exec(sourceFormula)?.[1] ?? NaN);

  // The workbook's own transfer list, kept purely so the reconciliation can
  // show it beside what the engine computes.
  /** @type {{ label: string, amountCents: Cents }[]} */
  const spreadsheetTransfers = [];
  /** @type {Cents | null} */
  let spreadsheetTransferTotalCents = null;
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    if (text(sheet, row, 1) !== "Transfers") continue;
    let col = 2;
    while (text(sheet, row, col) !== "") {
      const amount = number(sheet, row + 1, col);
      if (amount !== null) {
        spreadsheetTransfers.push({ label: text(sheet, row, col), amountCents: toCents(amount) });
      }
      col += 1;
    }
    const total = number(sheet, row + 1, col);
    spreadsheetTransferTotalCents = total === null ? null : toCents(total);
    break;
  }

  const grossMonthly = number(sheet, 2, 2);
  const grossPerPay = number(sheet, 4, 2);

  return {
    key: `plan:${sheet.name}`,
    name: planName,
    sheet: sheet.name,
    variantRefRow: Number.isFinite(variantRefRow) ? variantRefRow : null,
    title: text(sheet, 1, 1),
    lines,
    spreadsheetTransfers,
    spreadsheetTransferTotalCents,
    spreadsheetGrossPerMonthCents: grossMonthly === null ? null : toCents(grossMonthly),
    spreadsheetGrossPerPayCents: grossPerPay === null ? null : toCents(grossPerPay),
  };
}

/**
 * The `Projections` sheet: an opening balance and a MONTHLY growth rate per
 * account. The app stores growth annually, so the rate is compounded up here
 * — `(1 + m)^12 - 1`, not `m * 12`. At the household's own 0.0041/month the
 * difference between those two is a fifth of a percent a year, which
 * compounds into real money over a five-year projection.
 *
 * @param {import("exceljs").Worksheet} sheet
 */
function parseProjections(sheet) {
  /** @type {{ key: RowKey, accountName: string, destinationKey: string, amountCents: Cents, monthlyRate: number | null, annualGrowthRate: number | null, sourceRow: number }[]} */
  const rows = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const name = text(sheet, row, 1);
    if (name === "") continue;
    const current = number(sheet, row, 2);
    if (current === null) continue;
    const monthlyRate = number(sheet, row, 4);
    rows.push({
      key: `balance:${row}`,
      accountName: name,
      destinationKey: `dest:${normaliseDestination(name)}`,
      amountCents: toCents(current),
      monthlyRate,
      annualGrowthRate: monthlyRate === null ? null : Number(((1 + monthlyRate) ** 12 - 1).toFixed(6)),
      sourceRow: row,
    });
  }
  return rows;
}

/**
 * Free-text destinations ("to ubank (House)", "Income + Bills (No move
 * required)") scored against the accounts that already exist. A suggestion is
 * never applied on its own — the operator confirms every mapping, and nothing
 * creates an account unless they explicitly ask for one
 * (phases/11-polish-mobile-import.md, workstream C, item 4).
 *
 * @param {string} raw
 */
function normaliseDestination(raw) {
  return raw
    .toLowerCase()
    .replace(/^to\s+/, "")
    .replace(/\(no move required\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Dice coefficient over character bigrams — a similarity measure that handles
 * "ubank (House)" vs "ubank House" and "2UP" vs "2Up" without either an exact
 * match or a dependency.
 *
 * @param {string} a
 * @param {string} b
 */
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  /** @type {Map<string, number>} */
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const count = bigrams.get(gram) ?? 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      hits += 1;
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

/**
 * @param {string} raw
 * @param {{ id: string, name: string }[]} accounts
 */
function suggestAccounts(raw, accounts) {
  const needle = normaliseDestination(raw);
  return accounts
    .map((account) => ({
      accountId: account.id,
      name: account.name,
      score: Number(similarity(needle, normaliseDestination(account.name)).toFixed(3)),
    }))
    .filter((s) => s.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

/** Sheets the phase doc says to skip, and why. */
const IGNORED_SHEETS = {
  Assets: "Empty in the source workbook — nothing to import.",
  "Income Division_OLD": "Superseded by the current Income Division sheet.",
};

/**
 * Parses the workbook into an import plan: every entity it will create, every
 * row individually keyed so it can be deselected, and every defect flagged
 * with an explanation.
 *
 * @param {Buffer} buffer
 * @param {{ fileName: string, accounts: { id: string, name: string }[] }} context
 */
export async function parseImport(buffer, { fileName, accounts }) {
  const workbook = await readWorkbook(buffer);
  // `new Uint8Array(...)` rather than hashing the Buffer directly: apps/web
  // typechecks this file too (it reaches it through `import("@budget/api")
  // .ApiRoutes`), and under web's DOM lib a Node Buffer and the ambient
  // ArrayBufferView are not the same type. A plain Uint8Array is, in both.
  const fileHash = createHash("sha256").update(new Uint8Array(buffer)).digest("hex");

  /** @param {string} name */
  const sheet = (name) => workbook.getWorksheet(name) ?? null;

  const incomeSheet = sheet("Income");
  const fixedSheet = sheet("Fixed Costs");
  const variableSheet = sheet("Variable Costs");
  const projectionsSheet = sheet("Projections");

  const income = incomeSheet ? parseIncome(incomeSheet) : { variants: [], people: [] };
  const fixed = fixedSheet
    ? parseFixedCosts(fixedSheet)
    : { bills: [], categories: [], subtotals: new Map(), spreadsheetAnnualTotalCents: null };
  const variable = variableSheet
    ? parseVariableCosts(variableSheet)
    : { categories: [], essentialsSubtotalCents: null, totalCents: null };
  const balances = projectionsSheet ? parseProjections(projectionsSheet) : [];

  // Every remaining sheet with a Category/Division header is an allocation
  // plan. Discovered rather than listed, so a fifth parental-leave scenario
  // added to the workbook imports without a code change.
  const handled = new Set(["Income", "Fixed Costs", "Variable Costs", "Projections"]);
  /** @type {NonNullable<ReturnType<typeof parsePlanSheet>>[]} */
  const plans = [];
  /** @type {{ name: string, reason: string }[]} */
  const ignoredSheets = [];

  for (const ws of workbook.worksheets) {
    if (handled.has(ws.name)) continue;
    const reason = /** @type {Record<string, string>} */ (IGNORED_SHEETS)[ws.name];
    if (reason) {
      ignoredSheets.push({ name: ws.name, reason });
      continue;
    }
    // "Income Division" is the Usual plan; the rest are named after their
    // own sheet. Their in-sheet titles are not usable — two of them are both
    // called "Phase 1I", which is flag 3.
    const planName = ws.name === "Income Division" ? "Usual" : ws.name;
    const parsed = parsePlanSheet(ws, planName);
    if (parsed) plans.push(parsed);
    else ignoredSheets.push({ name: ws.name, reason: "No Category/Division header — not an allocation plan." });
  }

  /** @type {ImportFlag[]} */
  const flags = [];

  // ---- flag 1: a duplicate (category, name) fixed cost --------------------
  /** @type {Map<string, number>} */
  const seenBills = new Map();
  /** @type {Set<RowKey>} */
  const deselectedByDefault = new Set();
  for (const bill of fixed.bills) {
    const key = `${bill.categoryName} ${bill.name}`.toLowerCase();
    const firstRow = seenBills.get(key);
    if (firstRow === undefined) {
      seenBills.set(key, bill.sourceRow);
      continue;
    }
    deselectedByDefault.add(bill.key);
    flags.push({
      id: `duplicate-bill:${bill.key}`,
      severity: "warning",
      title: `Duplicate bill: ${bill.name}`,
      detail:
        `Row ${bill.sourceRow} of Fixed Costs repeats "${bill.name}" in ${bill.categoryName}, already on row ${firstRow}, ` +
        `at ${(bill.amountCents / 100).toFixed(2)} ${bill.frequency.replace(/_/g, " ")} — ` +
        `${(equivalent(bill.amountCents, bill.frequency, "yearly") / 100).toFixed(2)} a year. ` +
        "It is a confirmed error in the source workbook, so it is deselected. Select it only if it is a real second bill.",
      rowKeys: [bill.key],
      defaultDeselected: true,
    });
  }

  // ---- flag 2: a category subtotal that does not equal its own members ----
  for (const [categoryName, entry] of fixed.subtotals) {
    if (entry.subtotalAnnualCents === null) continue;
    const delta = entry.memberAnnualCents - entry.subtotalAnnualCents;
    if (Math.abs(delta) < 100) continue;
    const missing = fixed.bills.filter(
      (b) => b.categoryName === categoryName && (b.annualCents ?? 0) > 0,
    );
    flags.push({
      id: `subtotal-mismatch:${categoryName}`,
      severity: "info",
      title: `${categoryName} subtotal excludes some of its own rows`,
      detail:
        `The workbook's ${categoryName} subtotal is ${(entry.subtotalAnnualCents / 100).toFixed(2)} a year, but its ` +
        `${missing.length} rows add up to ${(entry.memberAnnualCents / 100).toFixed(2)} — a hand-typed cell range that ` +
        `missed ${(delta / 100).toFixed(2)}. This app derives subtotals from category membership, so importing every row ` +
        `raises ${categoryName} by that amount. Expected, not alarming: the bills were always real.`,
      rowKeys: fixed.bills.filter((b) => b.categoryName === categoryName).map((b) => b.key),
      defaultDeselected: false,
    });
  }

  // ---- flag 3: two plan sheets dividing the same income variant -----------
  /** @type {Map<number, typeof plans>} */
  const byVariantRef = new Map();
  for (const plan of plans) {
    if (plan.variantRefRow === null) continue;
    const list = byVariantRef.get(plan.variantRefRow) ?? [];
    list.push(plan);
    byVariantRef.set(plan.variantRefRow, list);
  }
  for (const [refRow, sharing] of byVariantRef) {
    if (sharing.length < 2) continue;
    const variantName = income.variants.find((v) => v.totalRow === refRow)?.name ?? `Income row ${refRow}`;
    flags.push({
      id: `shared-variant:${refRow}`,
      severity: "warning",
      title: `${sharing.map((p) => p.sheet).join(" and ")} divide the same income`,
      detail:
        `Both sheets read Income!E${refRow} (${variantName})` +
        (sharing.every((p) => p.title === sharing[0]?.title) ? `, and both are titled "${sharing[0]?.title}"` : "") +
        ". They are duplicates of each other. Pick the income variant each plan should divide before importing — " +
        "nothing is guessed.",
      rowKeys: sharing.map((p) => p.key),
      defaultDeselected: false,
    });
  }

  // ---- flag 4: free-text destinations need mapping ------------------------
  /** @type {Map<string, { key: string, raw: string, usedBy: string[], suggestions: ReturnType<typeof suggestAccounts> }>} */
  const destinations = new Map();
  for (const plan of plans) {
    for (const line of plan.lines) {
      if (line.destination === "") continue;
      const key = `dest:${normaliseDestination(line.destination)}`;
      const existing = destinations.get(key);
      if (existing) {
        if (!existing.usedBy.includes(plan.name)) existing.usedBy.push(plan.name);
        continue;
      }
      destinations.set(key, {
        key,
        raw: line.destination,
        usedBy: [plan.name],
        suggestions: suggestAccounts(line.destination, accounts),
      });
    }
  }
  // Projections names its accounts too ("House", "Raiz"). They go through
  // the same mapping step rather than a second one — an account is an
  // account, and matching one list is less work than matching two.
  for (const balance of balances) {
    const existing = destinations.get(balance.destinationKey);
    if (existing) {
      if (!existing.usedBy.includes("Projections")) existing.usedBy.push("Projections");
      continue;
    }
    destinations.set(balance.destinationKey, {
      key: balance.destinationKey,
      raw: balance.accountName,
      usedBy: ["Projections"],
      suggestions: suggestAccounts(balance.accountName, accounts),
    });
  }

  if (destinations.size > 0) {
    flags.push({
      id: "destination-mapping",
      severity: "warning",
      title: `${destinations.size} transfer destinations need an account`,
      detail:
        "The spreadsheet names destinations as free text. Map each one to an account before importing. " +
        "No account is created unless you ask for it by name.",
      rowKeys: [],
      defaultDeselected: false,
    });
  }

  // Bills carry a derived name ("& LP" became "<row above> (LP)"); say so
  // rather than letting the operator discover it in the bill list.
  const partnerCopies = fixed.bills.filter((b) => b.derivedName && b.name.endsWith(" (LP)"));
  if (partnerCopies.length > 0) {
    flags.push({
      id: "derived-bill-names-lp",
      severity: "info",
      title: `${partnerCopies.length} bills were named from the row above`,
      detail:
        `The workbook writes a partner's copy of a bill as "& LP" with no name of its own. Those rows import as ` +
        `${partnerCopies.map((b) => `"${b.name}"`).join(", ")}. Rename any of them on Fixed Costs afterwards.`,
      rowKeys: partnerCopies.map((b) => b.key),
      defaultDeselected: false,
    });
  }

  const unnamed = fixed.bills.filter((b) => b.derivedName && !b.name.endsWith(" (LP)"));
  if (unnamed.length > 0) {
    flags.push({
      id: "derived-bill-names-category",
      severity: "info",
      title: `${unnamed.length} bills had no name of their own`,
      detail:
        `Rows ${unnamed.map((b) => b.sourceRow).join(", ")} of Fixed Costs have a category but no item name, so each ` +
        "imports under its category name. That is also why the second Rent row reads as a duplicate above — it is one.",
      rowKeys: unnamed.map((b) => b.key),
      defaultDeselected: false,
    });
  }

  const withQualifier = income.variants.flatMap((v) => v.lines).filter((l) => l.label !== null);
  if (withQualifier.length > 0) {
    flags.push({
      id: "person-qualifiers",
      severity: "info",
      title: "Bracketed income rows became labelled lines, not extra people",
      detail:
        `Rows like "${withQualifier[0]?.personName} (${withQualifier[0]?.label?.toLowerCase()})" import as one person ` +
        "with a labelled income line. If a household member's real name contains brackets, fix it after importing.",
      rowKeys: withQualifier.map((l) => l.key),
      defaultDeselected: false,
    });
  }

  return {
    fileName,
    fileHash,
    people: income.people.map((name) => ({ key: `person:${name}`, name })),
    variants: income.variants.map((variant) => ({
      key: variant.key,
      name: variant.name,
      totalRow: variant.totalRow,
      spreadsheetTotalPerPayCents: variant.spreadsheetTotalCents,
      lines: variant.lines,
    })),
    fixedCategories: fixed.categories.map((name) => ({ key: `fixed-category:${name}`, name })),
    bills: fixed.bills.map((bill) => ({
      key: bill.key,
      categoryName: bill.categoryName,
      name: bill.name,
      amountCents: bill.amountCents,
      frequency: bill.frequency,
      perYearCents: equivalent(bill.amountCents, bill.frequency, "yearly"),
      sourceRow: bill.sourceRow,
      defaultSelected: !deselectedByDefault.has(bill.key),
    })),
    variableCategories: variable.categories,
    plans: plans.map((plan) => ({
      key: plan.key,
      name: plan.name,
      sheet: plan.sheet,
      title: plan.title,
      variantKey: income.variants.find((v) => v.totalRow === plan.variantRefRow)?.key ?? null,
      variantAmbiguous: (byVariantRef.get(plan.variantRefRow ?? -1)?.length ?? 0) > 1,
      lines: plan.lines,
      spreadsheetTransfers: plan.spreadsheetTransfers,
      spreadsheetTransferTotalCents: plan.spreadsheetTransferTotalCents,
      spreadsheetGrossPerMonthCents: plan.spreadsheetGrossPerMonthCents,
      spreadsheetGrossPerPayCents: plan.spreadsheetGrossPerPayCents,
    })),
    balances,
    destinations: [...destinations.values()],
    ignoredSheets,
    flags,
    // What the workbook itself claims, kept beside what the app derives so
    // the post-import reconciliation can show both.
    spreadsheet: {
      fixedTotalPerYearCents: fixed.spreadsheetAnnualTotalCents,
      variableEssentialsPerMonthCents: variable.essentialsSubtotalCents,
      variableTotalPerMonthCents: variable.totalCents,
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof parseImport>>} ImportPlan */
