// Golden fixtures transcribed from the real household spreadsheet (see
// `.claude/plans/phases/01-engine.md`). Fixture A reproduces the workbook
// **including its two bugs** — an unlabelled duplicate Rent bill that
// inflates the Car category's spreadsheet subtotal, and a "Weeks to save"
// label on a figure that is actually fortnights — to prove the engine models
// the real sheet rather than an idealised version of it. Fixture B
// (`corrected.ts`) is the same data with that duplicate bill removed.
//
// Only `baseAmountCents`, `frequency` and `amountModel: 'flat'` matter for
// these fixtures — every bill in the real sheet is a flat recurring amount,
// so `anchorDate` is arbitrary (chosen as the fixture "today") and no
// instance-projection edge case is exercised here; that behaviour has its
// own dedicated tests in `bills.test.ts`.
import { toCents } from "../money.js";

/** @import { Cents } from "../money.js" */
/** @import { Bill } from "../bills.js" */
/** @import { AllocationLine } from "../allocation.js" */

export const TODAY = "2026-01-01";

/**
 * @param {string} id
 * @param {number} dollars
 * @param {Bill["frequency"]} frequency
 * @returns {Bill}
 */
function bill(id, dollars, frequency) {
  return {
    id,
    baseAmountCents: toCents(dollars),
    frequency,
    anchorDate: TODAY,
    amountModel: "flat",
  };
}

/** @type {Bill[]} */
export const FIXED_COST_BILLS = [
  // Entertainment
  bill("stan", 17.0, "monthly"),
  bill("spotify", 19.99, "monthly"),
  bill("disney_plus", 15.99, "monthly"),
  // Utilities
  bill("internet", 90.0, "monthly"),
  bill("gas", 175.0, "every_2_months"),
  bill("electricity", 320.0, "quarterly"),
  bill("water", 100.0, "quarterly"),
  bill("ambulance_cover", 51.94, "yearly"),
  bill("ambulance_cover_lp", 51.94, "yearly"),
  bill("phone", 29.0, "monthly"),
  bill("phone_lp", 29.0, "monthly"),
  // Rent
  bill("rent", 2129.0, "monthly"),
  // Car
  bill("car_rego", 235.38, "quarterly"),
  bill("car_rego_lp", 242.46, "quarterly"),
  bill("car_insurance", 696.0, "yearly"),
  bill("car_insurance_lp", 115.89, "monthly"),
  bill("roadside_assist", 116.1, "yearly"),
  bill("roadside_assist_lp", 116.1, "yearly"),
  // Rent — the spreadsheet's second bug: an unlabelled duplicate Rent line.
  // Present in Fixture A, deleted in Fixture B.
  bill("rent_unlabelled_duplicate", 642.21, "monthly"),
];

// Bug #1: the spreadsheet's Car-category subtotal formula was a hand-typed
// cell range that missed both Roadside Assist rows, and the workbook's grand
// total rolls up the category subtotals rather than re-summing every bill —
// so the roadside bills are silently absent from BOTH the Car subtotal and
// the overall total, even though they're real bills the household pays.
// Fixture A's total must reproduce that omission exactly; Fixture B (which
// derives subtotals from category membership, not a manual range) includes
// them, and its total is bigger only by the difference this creates minus
// the deleted duplicate Rent bill.
export const ROADSIDE_ASSIST_BILL_IDS = ["roadside_assist", "roadside_assist_lp"];
export const FIXED_COST_BILLS_AS_SPREADSHEET_TOTAL = FIXED_COST_BILLS.filter(
  (b) => !ROADSIDE_ASSIST_BILL_IDS.includes(b.id),
);

export const CATEGORY_BILL_IDS = {
  entertainment: ["stan", "spotify", "disney_plus"],
  utilities: ["internet", "gas", "electricity", "water", "ambulance_cover", "ambulance_cover_lp", "phone", "phone_lp"],
  rent: ["rent", "rent_unlabelled_duplicate"],
  car: ["car_rego", "car_rego_lp", "car_insurance", "car_insurance_lp", "roadside_assist", "roadside_assist_lp"],
};

// Variable costs (monthly, given directly — no cadence conversion involved).
/** @type {Cents} */
export const VARIABLE_ESSENTIALS_MONTHLY_CENTS = toCents(71 + 1061 + 979); // Personal + Home + Transport = 2111
/** @type {Cents} */
export const VARIABLE_NON_ESSENTIAL_MONTHLY_CENTS = toCents(1143); // "Good Life"

// Income, "Usual" variant (fortnightly).
/** @type {Cents} */
export const GRACE_USUAL_FORTNIGHTLY_CENTS = toCents(2634.38);
/** @type {Cents} */
export const LACHLAN_USUAL_FORTNIGHTLY_CENTS = toCents(2207.23);
/** @type {Cents} */
export const GROSS_USUAL_FORTNIGHTLY_CENTS = (GRACE_USUAL_FORTNIGHTLY_CENTS +
  LACHLAN_USUAL_FORTNIGHTLY_CENTS);

// Other income variants (fortnightly totals), for `resolveVariant` structural
// tests — the dollar figures aren't re-verified downstream, only "Usual"
// feeds the allocation fixture below.
export const INCOME_VARIANTS_FORTNIGHTLY_CENTS = {
  usual: GROSS_USUAL_FORTNIGHTLY_CENTS,
  pl_gov_high: (toCents(1896.2) + toCents(2207.23)),
  pl_torch_low: (toCents(1444.69) + toCents(2207.23)),
  pl_balanced: (toCents(1670.445) + toCents(2207.23)),
};

export const INCOME_LANDING_ACCOUNT_ID = "income_bills";

// Allocation lines, "Usual" variant — order and stages exactly as documented.
/** @type {AllocationLine[]} */
export const ALLOCATION_LINES = [
  { id: "fixed", stage: 1, label: "Fixed", basis: "from_fixed_costs", value: null, goalPct: null, accountId: INCOME_LANDING_ACCOUNT_ID },
  { id: "variable", stage: 1, label: "Variable", basis: "from_variable_essentials", value: null, goalPct: null, accountId: "2up" },
  { id: "invest", stage: 2, label: "Invest", basis: "pct_of_gross", value: 8, goalPct: 10, accountId: "raiz" },
  { id: "save_house", stage: 2, label: "Save (House)", basis: "pct_of_gross", value: 8, goalPct: 10, accountId: "ubank_house" },
  { id: "save_holiday", stage: 2, label: "Save (Holiday)", basis: "pct_of_gross", value: 8, goalPct: 10, accountId: "ubank_holiday" },
  { id: "tithe_church", stage: 2, label: "Tithe (Church)", basis: "pct_of_gross", value: 7, goalPct: 7, accountId: "newhope" },
  { id: "tithe_generosity", stage: 2, label: "Tithe (Generosity)", basis: "pct_of_gross", value: 2, goalPct: 3, accountId: "ubank_generosity" },
  { id: "bill_shock_save", stage: 2, label: "Bill Shock Save", basis: "pct_of_gross", value: 3, goalPct: null, accountId: "ubank_mojo" },
  { id: "eating_out", stage: 3, label: "Eating Out", basis: "pct_of_remaining", value: 50, goalPct: null, accountId: "2up" },
  { id: "personal_prize", stage: 3, label: "Personal Prize", basis: "pct_of_remaining", value: 50, goalPct: null, accountId: "2up" },
];
