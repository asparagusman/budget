import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { createDb } from "./client.js";
import { accounts } from "./tables/accounts.js";
import { allocationLines, allocationPlans, allocationStageGoals, allocationVersions } from "./tables/allocation.js";
import { balanceSnapshots } from "./tables/balance-snapshots.js";
import { goals } from "./tables/goals.js";
import { bills } from "./tables/bills.js";
import { costCategories } from "./tables/cost-categories.js";
import { incomeLines } from "./tables/income-lines.js";
import { incomeVariants } from "./tables/income-variants.js";
import { people } from "./tables/people.js";
import { settings } from "./tables/settings.js";
import { variableBudgets } from "./tables/variable-budgets.js";

// See drizzle.config.js for why this isn't a plain `import "dotenv/config"`.
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env at the repo root and fill it in.",
  );
}

const includeExample = process.argv.includes("--example");

// Seed rows are infrastructure bookkeeping, never household data — no
// paydays, bills or balances belong here (see phases/README.md "The one
// rule"). Every phase appends its own idempotent upserts below.
/** @type {(typeof settings.$inferInsert)[]} */
const seedRows = [
  { key: "schema_seed_version", value: 1 },
  // Real defaults, loaded unconditionally — the operator changes these from
  // Settings on day one, this just gives <Money> something to read before
  // they do (phases/04-accounts-people.md "Settings keys introduced here").
  { key: "currency", value: "AUD" },
  { key: "locale", value: "en-AU" },
  { key: "billsBufferCents", value: 0 },
  { key: "historyLookbackDefault", value: 6 },
];

// Fixed ids (not `defaultRandom()`) so re-running `--example` is idempotent
// — a second run upserts the same rows instead of duplicating them. Names
// and shape come straight from phases/04-accounts-people.md "Example data";
// nothing here is real household data.
const EXAMPLE_PEOPLE_IDS = /** @type {const} */ ([
  "00000000-0000-4000-8000-000000000001", // Grace
  "00000000-0000-4000-8000-000000000002", // Lachlan
]);

/** @type {(typeof people.$inferInsert)[]} */
const examplePeople = [
  { id: EXAMPLE_PEOPLE_IDS[0], name: "Grace", sortOrder: 0 },
  { id: EXAMPLE_PEOPLE_IDS[1], name: "Lachlan", sortOrder: 1 },
];

const EXAMPLE_ACCOUNT_IDS = /** @type {const} */ ([
  "00000000-0000-4000-8000-000000000101", // Income + Bills
  "00000000-0000-4000-8000-000000000102", // 2UP
  "00000000-0000-4000-8000-000000000103", // ubank (House)
  "00000000-0000-4000-8000-000000000104", // ubank (Holiday)
  "00000000-0000-4000-8000-000000000105", // ubank (Generosity)
  "00000000-0000-4000-8000-000000000106", // ubank (Mojo)
  "00000000-0000-4000-8000-000000000107", // Raiz
  "00000000-0000-4000-8000-000000000108", // NewHope
]);

/** @type {(typeof accounts.$inferInsert)[]} */
const exampleAccounts = [
  {
    id: EXAMPLE_ACCOUNT_IDS[0],
    name: "Income + Bills",
    type: "transaction",
    isIncomeLanding: true,
    sortOrder: 0,
  },
  { id: EXAMPLE_ACCOUNT_IDS[1], name: "2UP", type: "transaction", institution: "Up", sortOrder: 1 },
  // Growth rates are stored ANNUALLY (0.050325 = 5.0325% p.a.) and converted
  // to a per-period rate by the engine's `periodRate` — the spreadsheet held
  // them monthly and formatted them as `0%`, so the rate was invisible
  // (phases/09-goals-projections.md "/projections"). These are the exact
  // annual equivalents of its 0.0041/mo and 0.012/mo, to the six decimal
  // places the column holds, which is what makes the projections reproduce
  // phase 01's fixture values to the cent.
  { id: EXAMPLE_ACCOUNT_IDS[2], name: "ubank (House)", type: "savings", institution: "ubank", annualGrowthRate: 0.050325, sortOrder: 2 },
  { id: EXAMPLE_ACCOUNT_IDS[3], name: "ubank (Holiday)", type: "savings", institution: "ubank", annualGrowthRate: 0.050325, sortOrder: 3 },
  {
    id: EXAMPLE_ACCOUNT_IDS[4],
    name: "ubank (Generosity)",
    type: "savings",
    institution: "ubank",
    sortOrder: 4,
  },
  { id: EXAMPLE_ACCOUNT_IDS[5], name: "ubank (Mojo)", type: "savings", institution: "ubank", sortOrder: 5 },
  { id: EXAMPLE_ACCOUNT_IDS[6], name: "Raiz", type: "investment", institution: "Raiz", annualGrowthRate: 0.153896, sortOrder: 6 },
  { id: EXAMPLE_ACCOUNT_IDS[7], name: "NewHope", type: "external", sortOrder: 7 },
];

const EXAMPLE_VARIANT_IDS = /** @type {const} */ ([
  "00000000-0000-4000-8000-000000000201", // Usual
  "00000000-0000-4000-8000-000000000202", // PL Gov (High)
  "00000000-0000-4000-8000-000000000203", // PL Torch (Low)
  "00000000-0000-4000-8000-000000000204", // PL Balanced
]);

/** @type {(typeof incomeVariants.$inferInsert)[]} */
const exampleIncomeVariants = [
  { id: EXAMPLE_VARIANT_IDS[0], name: "Usual", sortOrder: 0 },
  {
    id: EXAMPLE_VARIANT_IDS[1],
    name: "PL Gov (High)",
    notes: "Gov PPL is $189.62/day or $948.10 per 5-day week — 130 days / 26 weeks, with 20 days reserved for the partner.",
    sortOrder: 1,
  },
  {
    id: EXAMPLE_VARIANT_IDS[2],
    name: "PL Torch (Low)",
    notes: "Employer (Torch) PPL: 10 weeks full pay or 20 weeks half pay.",
    sortOrder: 2,
  },
  { id: EXAMPLE_VARIANT_IDS[3], name: "PL Balanced", sortOrder: 3 },
];

const EXAMPLE_INCOME_LINE_IDS = /** @type {const} */ ([
  "00000000-0000-4000-8000-000000000301",
  "00000000-0000-4000-8000-000000000302",
  "00000000-0000-4000-8000-000000000303",
  "00000000-0000-4000-8000-000000000304",
  "00000000-0000-4000-8000-000000000305",
  "00000000-0000-4000-8000-000000000306",
  "00000000-0000-4000-8000-000000000307",
  "00000000-0000-4000-8000-000000000308",
]);

// Fortnightly, dollars -> cents, from phases/05-income.md "Example data".
// No @budget/schema -> @budget/engine dependency exists for a `toCents()`
// call, so these are written as literal cents with the source dollar figure
// in a comment.
/** @type {(typeof incomeLines.$inferInsert)[]} */
const exampleIncomeLines = [
  // Usual
  { id: EXAMPLE_INCOME_LINE_IDS[0], variantId: EXAMPLE_VARIANT_IDS[0], personId: EXAMPLE_PEOPLE_IDS[0], label: "Salary", amountCents: 263438, cadence: "fortnightly", sortOrder: 0 }, // Grace $2634.38
  { id: EXAMPLE_INCOME_LINE_IDS[1], variantId: EXAMPLE_VARIANT_IDS[0], personId: EXAMPLE_PEOPLE_IDS[1], label: "Salary", amountCents: 220723, cadence: "fortnightly", sortOrder: 1 }, // Lachlan $2207.23
  // PL Gov (High)
  { id: EXAMPLE_INCOME_LINE_IDS[2], variantId: EXAMPLE_VARIANT_IDS[1], personId: EXAMPLE_PEOPLE_IDS[0], label: "Gov PPL", amountCents: 189620, cadence: "fortnightly", sortOrder: 0 }, // Grace $1896.20
  { id: EXAMPLE_INCOME_LINE_IDS[3], variantId: EXAMPLE_VARIANT_IDS[1], personId: EXAMPLE_PEOPLE_IDS[1], label: "Salary", amountCents: 220723, cadence: "fortnightly", sortOrder: 1 }, // Lachlan $2207.23
  // PL Torch (Low)
  { id: EXAMPLE_INCOME_LINE_IDS[4], variantId: EXAMPLE_VARIANT_IDS[2], personId: EXAMPLE_PEOPLE_IDS[0], label: "Employer PPL (half pay)", amountCents: 144469, cadence: "fortnightly", sortOrder: 0 }, // Grace $1444.69
  { id: EXAMPLE_INCOME_LINE_IDS[5], variantId: EXAMPLE_VARIANT_IDS[2], personId: EXAMPLE_PEOPLE_IDS[1], label: "Salary", amountCents: 220723, cadence: "fortnightly", sortOrder: 1 }, // Lachlan $2207.23
  // PL Balanced
  { id: EXAMPLE_INCOME_LINE_IDS[6], variantId: EXAMPLE_VARIANT_IDS[3], personId: EXAMPLE_PEOPLE_IDS[0], label: "PPL (balanced)", amountCents: 167045, cadence: "fortnightly", sortOrder: 0 }, // Grace $1670.445 -> nearest cent, see note below
  { id: EXAMPLE_INCOME_LINE_IDS[7], variantId: EXAMPLE_VARIANT_IDS[3], personId: EXAMPLE_PEOPLE_IDS[1], label: "Salary", amountCents: 220723, cadence: "fortnightly", sortOrder: 1 }, // Lachlan $2207.23
];
// PL Balanced's Grace figure ($1670.445) is the exact midpoint of PL Gov
// (High) and PL Torch (Low) and falls on a half-cent — 167044.5 — which
// `amountCents` (an integer column) can't hold. Rounded half-up to 167045
// rather than down, matching `toCents()`'s own half-up rule
// (packages/engine/src/money.js) so this seed value would come out the same
// if the operator ever re-typed it as a dollar amount through the UI.

const EXAMPLE_COST_CATEGORY_IDS = /** @type {const} */ ([
  "00000000-0000-4000-8000-000000000401", // Entertainment
  "00000000-0000-4000-8000-000000000402", // Utilities
  "00000000-0000-4000-8000-000000000403", // Rent
  "00000000-0000-4000-8000-000000000404", // Car
]);

/** @type {(typeof costCategories.$inferInsert)[]} */
const exampleCostCategories = [
  { id: EXAMPLE_COST_CATEGORY_IDS[0], name: "Entertainment", kind: "fixed", sortOrder: 0 },
  { id: EXAMPLE_COST_CATEGORY_IDS[1], name: "Utilities", kind: "fixed", sortOrder: 1 },
  { id: EXAMPLE_COST_CATEGORY_IDS[2], name: "Rent", kind: "fixed", sortOrder: 2 },
  { id: EXAMPLE_COST_CATEGORY_IDS[3], name: "Car", kind: "fixed", sortOrder: 3 },
];

// Fixture B's variable categories (phases/07-variable-costs.md "Example
// data") — a separate id block from the fixed categories above rather than
// extending EXAMPLE_COST_CATEGORY_IDS, so re-running `--example` never
// renumbers an id that's already out in a household's real data.
const EXAMPLE_VARIABLE_CATEGORY_IDS = /** @type {const} */ ([
  "00000000-0000-4000-8000-000000000601", // Personal
  "00000000-0000-4000-8000-000000000602", // Home
  "00000000-0000-4000-8000-000000000603", // Transport
  "00000000-0000-4000-8000-000000000604", // Good Life
]);

/** @type {(typeof costCategories.$inferInsert)[]} */
const exampleVariableCategories = [
  // Essential — deducted by the allocation (phases/07-variable-costs.md
  // "The trap"). `isEssential` defaults to true, so it's left implicit here.
  { id: EXAMPLE_VARIABLE_CATEGORY_IDS[0], name: "Personal", kind: "variable", sortOrder: 0 },
  { id: EXAMPLE_VARIABLE_CATEGORY_IDS[1], name: "Home", kind: "variable", sortOrder: 1 },
  { id: EXAMPLE_VARIABLE_CATEGORY_IDS[2], name: "Transport", kind: "variable", sortOrder: 2 },
  // Non-essential — a benchmark only, never deducted.
  { id: EXAMPLE_VARIABLE_CATEGORY_IDS[3], name: "Good Life", kind: "variable", isEssential: false, sortOrder: 3 },
];

// Same fixed anchor convention as EXAMPLE_BILL_ANCHOR — arbitrary, just old
// enough that `resolveVariableBudget` treats it as the current budget today.
const EXAMPLE_VARIABLE_BUDGET_EFFECTIVE_FROM = "2026-01-01";

const EXAMPLE_VARIABLE_BUDGET_IDS = /** @type {const} */ ([
  "00000000-0000-4000-8000-000000000701",
  "00000000-0000-4000-8000-000000000702",
  "00000000-0000-4000-8000-000000000703",
  "00000000-0000-4000-8000-000000000704",
]);

// Monthly, dollars -> cents, from phases/07-variable-costs.md "Example
// data". Expected summary: essentialPerMonthCents 211100 (Personal + Home +
// Transport), nonEssentialPerMonthCents 114300 (Good Life alone, never added
// into the essential total).
/** @type {(typeof variableBudgets.$inferInsert)[]} */
const exampleVariableBudgets = [
  { id: EXAMPLE_VARIABLE_BUDGET_IDS[0], categoryId: EXAMPLE_VARIABLE_CATEGORY_IDS[0], amountCents: 7100, cadence: "monthly", effectiveFrom: EXAMPLE_VARIABLE_BUDGET_EFFECTIVE_FROM }, // $71.00
  { id: EXAMPLE_VARIABLE_BUDGET_IDS[1], categoryId: EXAMPLE_VARIABLE_CATEGORY_IDS[1], amountCents: 106100, cadence: "monthly", effectiveFrom: EXAMPLE_VARIABLE_BUDGET_EFFECTIVE_FROM }, // $1061.00
  { id: EXAMPLE_VARIABLE_BUDGET_IDS[2], categoryId: EXAMPLE_VARIABLE_CATEGORY_IDS[2], amountCents: 97900, cadence: "monthly", effectiveFrom: EXAMPLE_VARIABLE_BUDGET_EFFECTIVE_FROM }, // $979.00
  { id: EXAMPLE_VARIABLE_BUDGET_IDS[3], categoryId: EXAMPLE_VARIABLE_CATEGORY_IDS[3], amountCents: 114300, cadence: "monthly", effectiveFrom: EXAMPLE_VARIABLE_BUDGET_EFFECTIVE_FROM }, // $1143.00
];
// No variableActuals rows: history is the operator's to enter (same doc,
// "Seed no actuals").

// Allocation plans — one per income variant, exactly as the spreadsheet had
// one sheet per variant (phases/08-allocation.md "Example data"). Ids come
// from their own decimal blocks (8xx plans, 9xx versions, 10xx+ lines) so
// re-running `--example` never renumbers an id already out in a household's
// real data.
const EXAMPLE_ALLOCATION_PLAN_IDS = /** @type {const} */ ([
  "00000000-0000-4000-8000-000000000801", // Usual
  "00000000-0000-4000-8000-000000000802", // PL Gov (High)
  "00000000-0000-4000-8000-000000000803", // PL Torch (Low)
  "00000000-0000-4000-8000-000000000804", // PL Balanced
]);

const EXAMPLE_ALLOCATION_VERSION_IDS = /** @type {const} */ ([
  "00000000-0000-4000-8000-000000000901",
  "00000000-0000-4000-8000-000000000902",
  "00000000-0000-4000-8000-000000000903",
  "00000000-0000-4000-8000-000000000904",
]);

/** @type {(typeof allocationPlans.$inferInsert)[]} */
const exampleAllocationPlans = EXAMPLE_VARIANT_IDS.map((variantId, i) => ({
  id: EXAMPLE_ALLOCATION_PLAN_IDS[i],
  name: exampleIncomeVariants[i]?.name ?? "Plan",
  incomeVariantId: variantId,
}));

// A fixed timestamp rather than `new Date()`: these rows are upserted on
// every `--example` run, and a moving `activatedAt` would make an unchanged
// seed look freshly applied each time.
const EXAMPLE_ALLOCATION_ACTIVATED_AT = new Date("2026-01-01T00:00:00.000Z");

// Seeded straight to `active` (not `draft`) so /allocation has a baseline to
// diff a draft against on day one. `createdBy` is null — no user created
// these, the seed did.
/** @type {(typeof allocationVersions.$inferInsert)[]} */
const exampleAllocationVersions = EXAMPLE_ALLOCATION_PLAN_IDS.map((planId, i) => ({
  id: EXAMPLE_ALLOCATION_VERSION_IDS[i],
  planId,
  version: 1,
  status: /** @type {const} */ ("active"),
  note: "Seeded example allocation.",
  activatedAt: EXAMPLE_ALLOCATION_ACTIVATED_AT,
}));

// Fixture A's allocation lines (phases/01-engine.md, transcribed in
// packages/engine/src/__fixtures__/as-spreadsheet.js) — the household's real
// allocation, stage and order exactly as documented. Against phase 06's
// corrected fixed costs this reproduces Fixture B: stage 1 subtotal
// 5029.656667 (47.9465% of gross), stage 2 subtotal 3776.4558,
// goodLifeFidelityCents -541.042533 (headroom), and
// unallocatedPerMonthCents exactly 0.
//
// `value` means a different thing per basis (see tables/allocation.js): a
// percentage for the two `pct_*` bases, ignored for the two `from_*` ones.
/** @type {{ label: string, stage: number, basis: (typeof allocationLines.$inferInsert)["basis"], value: number | null, goalPct: number | null, accountIndex: number }[]} */
const EXAMPLE_ALLOCATION_LINE_SHAPE = [
  // Stage 1 — the two totals the operator never types by hand: they come
  // from /fixed-costs/summary and /variable-costs/summary. Fixed stays in
  // the income-landing account (bills are debited from it, so nothing
  // moves); essentials transfer out to the joint spending account.
  //
  // `stage` is both the order a line resolves in and the section it belongs
  // to: 1/2/3 are Bills & Essentials, Save Invest & Give, Leftover
  // (`ALLOCATION_SECTIONS` in packages/engine/src/allocation.js).
  { label: "Fixed", stage: 1, basis: "from_fixed_costs", value: null, goalPct: null, accountIndex: 0 },
  { label: "Variable", stage: 1, basis: "from_variable_essentials", value: null, goalPct: null, accountIndex: 1 },
  // Stage 2 — percentages of GROSS, each with the operator's own goal.
  { label: "Invest", stage: 2, basis: "pct_of_gross", value: 8, goalPct: 10, accountIndex: 6 },
  { label: "Save (House)", stage: 2, basis: "pct_of_gross", value: 8, goalPct: 10, accountIndex: 2 },
  { label: "Save (Holiday)", stage: 2, basis: "pct_of_gross", value: 8, goalPct: 10, accountIndex: 3 },
  { label: "Tithe (Church)", stage: 2, basis: "pct_of_gross", value: 7, goalPct: 7, accountIndex: 7 },
  { label: "Tithe (Generosity)", stage: 2, basis: "pct_of_gross", value: 2, goalPct: 3, accountIndex: 4 },
  { label: "Bill Shock Save", stage: 2, basis: "pct_of_gross", value: 3, goalPct: null, accountIndex: 5 },
  // Stage 3 — the prize pool: percentages of what is LEFT, 50/50, so
  // remaining lands on exactly zero.
  { label: "Eating Out", stage: 3, basis: "pct_of_remaining", value: 50, goalPct: null, accountIndex: 1 },
  { label: "Personal Prize", stage: 3, basis: "pct_of_remaining", value: 50, goalPct: null, accountIndex: 1 },
];

// The PL Balanced plan carries one extra line — a `fixed_amount`, the one
// basis no other seeded plan exercises (phases/08-allocation.md "Example
// data"). The spreadsheet held it as 225.755 per fortnight; `value` for this
// basis is cents PER MONTH, so 22575.5c/FN x 26 / 12 = 48913.58c/mo, stored
// to the nearest cent. It lands in Mojo, the household's buffer account.
/** @type {(typeof EXAMPLE_ALLOCATION_LINE_SHAPE)[number]} */
const EXAMPLE_PL_BUFFER_LINE = {
  label: "PL Buffer",
  stage: 2,
  basis: "fixed_amount",
  value: 48914,
  goalPct: null,
  accountIndex: 5,
};

const PL_BALANCED_PLAN_INDEX = 3;
const STAGE_2_LINE_COUNT = 8;

/** @type {(typeof allocationLines.$inferInsert)[]} */
const exampleAllocationLines = EXAMPLE_ALLOCATION_VERSION_IDS.flatMap((versionId, planIndex) => {
  const shape =
    planIndex === PL_BALANCED_PLAN_INDEX
      ? // Spliced in before the stage-3 prize lines so the editor shows it
        // inside stage 2 rather than trailing the plan.
        [
          ...EXAMPLE_ALLOCATION_LINE_SHAPE.slice(0, STAGE_2_LINE_COUNT),
          EXAMPLE_PL_BUFFER_LINE,
          ...EXAMPLE_ALLOCATION_LINE_SHAPE.slice(STAGE_2_LINE_COUNT),
        ]
      : EXAMPLE_ALLOCATION_LINE_SHAPE;
  return shape.map((line, lineIndex) => ({
    // 1001, 1002, … — a flat sequence, 20 ids reserved per plan, formatted
    // into the same uuid shape as the id blocks above.
    id: `00000000-0000-4000-8000-${String(1001 + planIndex * 20 + lineIndex).padStart(12, "0")}`,
    versionId,
    stage: line.stage,
    label: line.label,
    basis: line.basis,
    value: line.value,
    goalPct: line.goalPct,
    accountId: EXAMPLE_ACCOUNT_IDS[line.accountIndex] ?? EXAMPLE_ACCOUNT_IDS[0],
    sortOrder: lineIndex,
  }));
});
// The two Goal % cells the workbook carries on its Running Totals rows, which
// no per-line goal can express: 50% on section A's Subtotal, and the 10% the
// sheet writes against section B's *Remaining* row — which is section C's
// subtotal, because C's two lines split 100% of what B leaves. Section B has
// no goal of its own; the sheet leaves that cell blank and its own lines sum
// to 40%, so the seeded data exercises all three `goalSource` states at once.
/** @type {(typeof allocationStageGoals.$inferInsert)[]} */
const exampleAllocationStageGoals = EXAMPLE_ALLOCATION_VERSION_IDS.flatMap((versionId, planIndex) =>
  [
    { stage: 1, goalPct: 50 },
    { stage: 3, goalPct: 10 },
  ].map((goal, goalIndex) => ({
    // 1901, 1902, … — two ids reserved per plan, in the same uuid shape as
    // the blocks above.
    id: `00000000-0000-4000-8000-${String(1901 + planIndex * 2 + goalIndex).padStart(12, "0")}`,
    versionId,
    stage: goal.stage,
    goalPct: goal.goalPct,
  })),
);

// The fortnightly transfer figures in phases/08-allocation.md's "Example
// data" table assume a FORTNIGHTLY primary pay schedule. None is seeded — a
// payday is real household data and phase 04 deliberately seeds none — so
// /allocation/compute reports monthly figures (with a warning) until the
// operator sets one.

const EXAMPLE_BILL_IDS = /** @type {const} */ ([
  "00000000-0000-4000-8000-000000000501", // Stan
  "00000000-0000-4000-8000-000000000502", // Spotify
  "00000000-0000-4000-8000-000000000503", // Disney+
  "00000000-0000-4000-8000-000000000504", // Internet
  "00000000-0000-4000-8000-000000000505", // Gas
  "00000000-0000-4000-8000-000000000506", // Electricity
  "00000000-0000-4000-8000-000000000507", // Water
  "00000000-0000-4000-8000-000000000508", // Ambulance cover
  "00000000-0000-4000-8000-000000000509", // Ambulance cover (LP)
  "00000000-0000-4000-8000-000000000510", // Phone
  "00000000-0000-4000-8000-000000000511", // Phone (LP)
  "00000000-0000-4000-8000-000000000512", // Rent
  "00000000-0000-4000-8000-000000000513", // Car rego
  "00000000-0000-4000-8000-000000000514", // Car rego (LP)
  "00000000-0000-4000-8000-000000000515", // Car insurance
  "00000000-0000-4000-8000-000000000516", // Car insurance (LP)
  "00000000-0000-4000-8000-000000000517", // Roadside assist
  "00000000-0000-4000-8000-000000000518", // Roadside assist (LP)
]);

// A single fixed anchor date for every seeded bill — arbitrary, but "keeps
// the projection sensible" is all phases/06-fixed-costs.md "Example data"
// asks for; the operator's own bills will each carry a real due date.
const EXAMPLE_BILL_ANCHOR = "2026-01-15";

// Fixture B from phases/01-engine.md (packages/engine/src/__fixtures__/
// as-spreadsheet.js, Fixture A with the unlabelled duplicate Rent bill
// removed) — the household's real fixed costs. `packages/schema` has no
// runtime dependency on `@budget/engine` (no `toCents()` call here — see the
// PL Balanced note above), so amounts are literal cents with the source
// dollar figure in a comment, transcribed from that fixture. All flat, all
// paid from the income-landing account — `paidFromAccountId` defaults to it
// on the /costs/fixed create form too (phases/06-fixed-costs.md "Schema").
/** @type {(typeof bills.$inferInsert)[]} */
const exampleBills = [
  // Entertainment
  { id: EXAMPLE_BILL_IDS[0], categoryId: EXAMPLE_COST_CATEGORY_IDS[0], name: "Stan", paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 1700, frequency: "monthly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 0 }, // $17.00
  { id: EXAMPLE_BILL_IDS[1], categoryId: EXAMPLE_COST_CATEGORY_IDS[0], name: "Spotify", paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 1999, frequency: "monthly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 1 }, // $19.99
  { id: EXAMPLE_BILL_IDS[2], categoryId: EXAMPLE_COST_CATEGORY_IDS[0], name: "Disney+", paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 1599, frequency: "monthly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 2 }, // $15.99
  // Utilities
  { id: EXAMPLE_BILL_IDS[3], categoryId: EXAMPLE_COST_CATEGORY_IDS[1], name: "Internet", paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 9000, frequency: "monthly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 0 }, // $90.00
  { id: EXAMPLE_BILL_IDS[4], categoryId: EXAMPLE_COST_CATEGORY_IDS[1], name: "Gas", paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 17500, frequency: "every_2_months", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 1 }, // $175.00
  { id: EXAMPLE_BILL_IDS[5], categoryId: EXAMPLE_COST_CATEGORY_IDS[1], name: "Electricity", paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 32000, frequency: "quarterly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 2 }, // $320.00
  { id: EXAMPLE_BILL_IDS[6], categoryId: EXAMPLE_COST_CATEGORY_IDS[1], name: "Water", paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 10000, frequency: "quarterly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 3 }, // $100.00
  { id: EXAMPLE_BILL_IDS[7], categoryId: EXAMPLE_COST_CATEGORY_IDS[1], name: "Ambulance cover", ownerPersonId: EXAMPLE_PEOPLE_IDS[0], paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 5194, frequency: "yearly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 4 }, // $51.94
  { id: EXAMPLE_BILL_IDS[8], categoryId: EXAMPLE_COST_CATEGORY_IDS[1], name: "Ambulance cover", ownerPersonId: EXAMPLE_PEOPLE_IDS[1], paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 5194, frequency: "yearly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 5 }, // $51.94
  { id: EXAMPLE_BILL_IDS[9], categoryId: EXAMPLE_COST_CATEGORY_IDS[1], name: "Phone", ownerPersonId: EXAMPLE_PEOPLE_IDS[0], paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 2900, frequency: "monthly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 6 }, // $29.00
  { id: EXAMPLE_BILL_IDS[10], categoryId: EXAMPLE_COST_CATEGORY_IDS[1], name: "Phone", ownerPersonId: EXAMPLE_PEOPLE_IDS[1], paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 2900, frequency: "monthly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 7 }, // $29.00
  // Rent — Fixture B only, the spreadsheet's unlabelled duplicate Rent bill
  // is a genuine error and must not be seeded (phases/06-fixed-costs.md
  // "Example data").
  { id: EXAMPLE_BILL_IDS[11], categoryId: EXAMPLE_COST_CATEGORY_IDS[2], name: "Rent", paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 212900, frequency: "monthly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 0 }, // $2129.00
  // Car — the Car subtotal (4230.24, not the spreadsheet's 3998.04) is the
  // assertion that matters: both Roadside Assist rows below must be included
  // in it (phases/06-fixed-costs.md "Example data").
  { id: EXAMPLE_BILL_IDS[12], categoryId: EXAMPLE_COST_CATEGORY_IDS[3], name: "Car rego", ownerPersonId: EXAMPLE_PEOPLE_IDS[0], paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 23538, frequency: "quarterly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 0 }, // $235.38
  { id: EXAMPLE_BILL_IDS[13], categoryId: EXAMPLE_COST_CATEGORY_IDS[3], name: "Car rego", ownerPersonId: EXAMPLE_PEOPLE_IDS[1], paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 24246, frequency: "quarterly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 1 }, // $242.46
  { id: EXAMPLE_BILL_IDS[14], categoryId: EXAMPLE_COST_CATEGORY_IDS[3], name: "Car insurance", ownerPersonId: EXAMPLE_PEOPLE_IDS[0], paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 69600, frequency: "yearly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 2 }, // $696.00
  { id: EXAMPLE_BILL_IDS[15], categoryId: EXAMPLE_COST_CATEGORY_IDS[3], name: "Car insurance", ownerPersonId: EXAMPLE_PEOPLE_IDS[1], paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 11589, frequency: "monthly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 3 }, // $115.89
  { id: EXAMPLE_BILL_IDS[16], categoryId: EXAMPLE_COST_CATEGORY_IDS[3], name: "Roadside assist", ownerPersonId: EXAMPLE_PEOPLE_IDS[0], paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 11610, frequency: "yearly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 4 }, // $116.10
  { id: EXAMPLE_BILL_IDS[17], categoryId: EXAMPLE_COST_CATEGORY_IDS[3], name: "Roadside assist", ownerPersonId: EXAMPLE_PEOPLE_IDS[1], paidFromAccountId: EXAMPLE_ACCOUNT_IDS[0], baseAmountCents: 11610, frequency: "yearly", anchorDate: EXAMPLE_BILL_ANCHOR, sortOrder: 5 }, // $116.10
];
// No billInstances, billStepChanges or billSeasonalFactors rows: history,
// step changes and seasonal curves are the operator's to enter, same as the
// income schedule above having no seeded entries (phases/06-fixed-costs.md
// "Example data": "Seed no history — history is the operator's to enter.").

// Balances and goals (phases/09-goals-projections.md "Example data").
//
// Snapshots are dated TODAY rather than a fixed date: a balance means nothing
// without one, and an example balance stamped months ago reads as stale the
// moment it loads. Re-running `--example` restamps the same three rows (fixed
// ids) rather than accumulating a new one per day.
const EXAMPLE_BALANCE_AS_AT = new Date().toISOString().slice(0, 10);

const EXAMPLE_BALANCE_IDS = /** @type {const} */ ([
  "00000000-0000-4000-8000-000000001101", // ubank (House)
  "00000000-0000-4000-8000-000000001102", // ubank (Holiday)
  "00000000-0000-4000-8000-000000001103", // Raiz
]);

/** @type {(typeof balanceSnapshots.$inferInsert)[]} */
const exampleBalances = [
  { id: EXAMPLE_BALANCE_IDS[0], accountId: EXAMPLE_ACCOUNT_IDS[2], asAt: EXAMPLE_BALANCE_AS_AT, amountCents: 2540300 }, // $25,403.00
  { id: EXAMPLE_BALANCE_IDS[1], accountId: EXAMPLE_ACCOUNT_IDS[3], asAt: EXAMPLE_BALANCE_AS_AT, amountCents: 111921 }, // $1,119.21
  { id: EXAMPLE_BALANCE_IDS[2], accountId: EXAMPLE_ACCOUNT_IDS[6], asAt: EXAMPLE_BALANCE_AS_AT, amountCents: 3735367 }, // $37,353.67
];

const EXAMPLE_GOAL_IDS = /** @type {const} */ ([
  "00000000-0000-4000-8000-000000001201", // Mojo — 3 months
]);

// Only the emergency fund is seeded. The phase doc also lists a House deposit
// and a Holiday goal, but records both targets as "operator's to set" — and a
// goal whose target is null resolves to zero, which reads as "achieved" the
// moment it loads. Seeding a guessed target would be exactly the invented
// household number this project forbids (phases/README.md "When you are
// blocked"), so those two are the operator's to add, in one form, on /goals.
//
// `months_of_expenses` needs no dollar figure at all: the target resolves at
// read time against stage 1 of the allocation, so it stays correct as costs
// change. At Fixture B's stage-1 subtotal it is ~$15,088.98 for 3 months.
// No target date — a deadline is a household decision, not a default.
/** @type {(typeof goals.$inferInsert)[]} */
const exampleGoals = [
  {
    id: EXAMPLE_GOAL_IDS[0],
    accountId: EXAMPLE_ACCOUNT_IDS[5], // ubank (Mojo)
    name: "Mojo — 3 months",
    targetMode: "months_of_expenses",
    targetMonths: 3,
    note: "Emergency fund: how long the household could last on current essential costs. Funded by the Bill Shock Save allocation line.",
  },
];

/**
 * Takes the URL as a parameter rather than closing over it: the guard above
 * narrows `databaseUrl` to a string at the call site, but that narrowing does
 * not reach inside a function body.
 *
 * @param {string} databaseUrl
 */
async function seed(databaseUrl) {
  const db = createDb(databaseUrl);
  let count = 0;

  for (const row of seedRows) {
    await db
      .insert(settings)
      .values(row)
      .onConflictDoUpdate({ target: settings.key, set: { value: row.value } });
    count++;
  }

  if (includeExample) {
    for (const row of examplePeople) {
      await db.insert(people).values(row).onConflictDoUpdate({ target: people.id, set: row });
      count++;
    }
    for (const row of exampleAccounts) {
      await db.insert(accounts).values(row).onConflictDoUpdate({ target: accounts.id, set: row });
      count++;
    }
    for (const row of exampleIncomeVariants) {
      await db.insert(incomeVariants).values(row).onConflictDoUpdate({ target: incomeVariants.id, set: row });
      count++;
    }
    for (const row of exampleIncomeLines) {
      await db.insert(incomeLines).values(row).onConflictDoUpdate({ target: incomeLines.id, set: row });
      count++;
    }
    // No schedule entries: the spreadsheet's dates were guesses ("~Aug",
    // "?? – ~Feb"), and seeding a guess as fact is exactly the hardcoding
    // this project forbids (phases/05-income.md "Example data"). Dates are
    // the operator's to enter.
    for (const row of exampleCostCategories) {
      await db.insert(costCategories).values(row).onConflictDoUpdate({ target: costCategories.id, set: row });
      count++;
    }
    for (const row of exampleBills) {
      await db.insert(bills).values(row).onConflictDoUpdate({ target: bills.id, set: row });
      count++;
    }
    for (const row of exampleVariableCategories) {
      await db.insert(costCategories).values(row).onConflictDoUpdate({ target: costCategories.id, set: row });
      count++;
    }
    for (const row of exampleVariableBudgets) {
      await db.insert(variableBudgets).values(row).onConflictDoUpdate({ target: variableBudgets.id, set: row });
      count++;
    }
    for (const row of exampleAllocationPlans) {
      await db.insert(allocationPlans).values(row).onConflictDoUpdate({ target: allocationPlans.id, set: row });
      count++;
    }
    for (const row of exampleAllocationVersions) {
      await db.insert(allocationVersions).values(row).onConflictDoUpdate({ target: allocationVersions.id, set: row });
      count++;
    }
    for (const row of exampleAllocationLines) {
      await db.insert(allocationLines).values(row).onConflictDoUpdate({ target: allocationLines.id, set: row });
      count++;
    }
    for (const row of exampleAllocationStageGoals) {
      await db
        .insert(allocationStageGoals)
        .values(row)
        .onConflictDoUpdate({ target: allocationStageGoals.id, set: row });
      count++;
    }
    for (const row of exampleBalances) {
      await db.insert(balanceSnapshots).values(row).onConflictDoUpdate({ target: balanceSnapshots.id, set: row });
      count++;
    }
    for (const row of exampleGoals) {
      await db.insert(goals).values(row).onConflictDoUpdate({ target: goals.id, set: row });
      count++;
    }

    // Clearly identifiable as example data without an `accounts` column
    // (phases/04-accounts-people.md "Example data must be... clearly
    // identifiable"): the fixed ids above plus this bookkeeping row are
    // enough for a future "clear example data" command to find exactly
    // what this script inserted and archive or delete it.
    const exampleSeedIds = {
      people: EXAMPLE_PEOPLE_IDS,
      accounts: EXAMPLE_ACCOUNT_IDS,
      incomeVariants: EXAMPLE_VARIANT_IDS,
      incomeLines: EXAMPLE_INCOME_LINE_IDS,
      costCategories: EXAMPLE_COST_CATEGORY_IDS,
      bills: EXAMPLE_BILL_IDS,
      variableCategories: EXAMPLE_VARIABLE_CATEGORY_IDS,
      variableBudgets: EXAMPLE_VARIABLE_BUDGET_IDS,
      allocationPlans: EXAMPLE_ALLOCATION_PLAN_IDS,
      allocationVersions: EXAMPLE_ALLOCATION_VERSION_IDS,
      allocationLines: exampleAllocationLines.map((l) => l.id),
      allocationStageGoals: exampleAllocationStageGoals.map((g) => g.id),
      balanceSnapshots: EXAMPLE_BALANCE_IDS,
      goals: EXAMPLE_GOAL_IDS,
    };
    await db
      .insert(settings)
      .values({ key: "example_seed_ids", value: exampleSeedIds })
      .onConflictDoUpdate({ target: settings.key, set: { value: exampleSeedIds } });
    count++;
  }

  console.log(`Seed complete: ${count} row(s) upserted${includeExample ? " (including example data)" : ""}.`);
}

seed(databaseUrl)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
