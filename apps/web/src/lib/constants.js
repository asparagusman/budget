import { OCCURRENCES_PER_YEAR } from "@budget/engine";

// apps/web never imports @budget/schema — that would pull drizzle-orm into
// the client bundle — so the account_type enum's values are intentionally
// duplicated here rather than derived. Keep this list in sync with
// packages/schema/src/tables/accounts.js.
export const ACCOUNT_TYPES = /** @type {const} */ (["transaction", "savings", "investment", "external"]);

/** @type {Record<(typeof ACCOUNT_TYPES)[number], string>} */
export const ACCOUNT_TYPE_LABELS = {
  transaction: "Transaction",
  savings: "Savings",
  investment: "Investment",
  external: "External",
};

// Cadence values come straight from @budget/engine (a legitimate runtime
// dependency, unlike @budget/schema) rather than being duplicated — this
// object's keys are packages/engine/src/cadence.js's `Cadence` union.
export const CADENCES = /** @type {(import("@budget/engine").Cadence)[]} */ (Object.keys(OCCURRENCES_PER_YEAR));

/** @type {Record<import("@budget/engine").Cadence, string>} */
export const CADENCE_LABELS = {
  weekly: "Weekly",
  fortnightly: "Fortnightly",
  monthly: "Monthly",
  every_2_months: "Every 2 months",
  quarterly: "Quarterly",
  every_6_months: "Every 6 months",
  yearly: "Yearly",
};

// The noun for ONE period of each cadence — "per fortnight", not "per
// fortnightly". Spelled out rather than derived from CADENCE_LABELS: "every 2
// months" has no singular a suffix rule would find, and a duration in the
// wrong unit is the exact mistake that made the source spreadsheet understate
// every emergency-fund timeline by half (phases/09-goals-projections.md
// "/goals").
/** @type {Record<import("@budget/engine").Cadence, [string, string]>} */
export const CADENCE_PERIOD_NOUNS = {
  weekly: ["week", "weeks"],
  fortnightly: ["fortnight", "fortnights"],
  monthly: ["month", "months"],
  every_2_months: ["two-month period", "two-month periods"],
  quarterly: ["quarter", "quarters"],
  every_6_months: ["half-year", "half-years"],
  yearly: ["year", "years"],
};

// `@budget/schema` isn't a dependency here either (same reasoning as
// ACCOUNT_TYPES above) — kept in sync by hand with
// packages/schema/src/tables/bills.js's `amountModel` enum.
export const AMOUNT_MODELS = /** @type {const} */ (["flat", "seasonal", "rolling_average", "escalating"]);

/** @type {Record<(typeof AMOUNT_MODELS)[number], string>} */
export const AMOUNT_MODEL_LABELS = {
  flat: "Flat",
  seasonal: "Seasonal",
  rolling_average: "Rolling average",
  escalating: "Escalating",
};

export const MONTH_LABELS = /** @type {const} */ ([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]);

// `@budget/schema` isn't a dependency here (same reasoning as ACCOUNT_TYPES
// above) — kept in sync by hand with packages/schema/src/tables/allocation.js's
// `allocationBasis` enum, which is itself the engine's `Basis` union verbatim.
export const ALLOCATION_BASES = /** @type {(import("@budget/engine").Basis)[]} */ ([
  "from_fixed_costs",
  "from_variable_essentials",
  "pct_of_gross",
  "pct_of_remaining",
  "fixed_amount",
  "sweep",
]);

/** @type {Record<import("@budget/engine").Basis, string>} */
export const ALLOCATION_BASIS_LABELS = {
  from_fixed_costs: "Fixed-cost total",
  from_variable_essentials: "Essentials total",
  pct_of_gross: "% of gross",
  pct_of_remaining: "% of remaining",
  fixed_amount: "Fixed amount",
  sweep: "Sweep",
};

// The spreadsheet encoded a line's basis positionally and said nothing about
// it, which is exactly why changing one number "threw out all the transfers"
// — the operator could not see what each row was a percentage *of*
// (phases/08-allocation.md "Why explicit basis"). Every row states it.
/** @type {Record<import("@budget/engine").Basis, string>} */
export const ALLOCATION_BASIS_HINTS = {
  from_fixed_costs: "The whole fixed-cost total from Fixed Costs. No value to set.",
  from_variable_essentials: "The whole essential total from Variable Costs. No value to set.",
  pct_of_gross: "A percentage of gross income.",
  pct_of_remaining: "A percentage of what's left when this stage starts.",
  fixed_amount: "A set amount per month, whatever else moves.",
  sweep: "Splits everything left at this stage, by weight.",
};

// What the value input holds for each basis: a percentage, dollars, a
// relative weight, or nothing at all.
/** @type {Record<import("@budget/engine").Basis, "percent" | "money" | "weight" | "none">} */
export const ALLOCATION_BASIS_VALUE_KIND = {
  from_fixed_costs: "none",
  from_variable_essentials: "none",
  pct_of_gross: "percent",
  pct_of_remaining: "percent",
  fixed_amount: "money",
  sweep: "weight",
};
