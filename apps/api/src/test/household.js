import {
  accounts,
  allocationLines,
  allocationPlans,
  allocationStageGoals,
  allocationVersions,
  balanceSnapshots,
  bills,
  costCategories,
  goals,
  incomeLines,
  incomeVariants,
  paySchedules,
  people,
  settings,
  variableActuals,
  variableBudgets,
  variantSchedule,
} from "@budget/schema";

/** @import { Db } from "@budget/schema" */
/** @import { IsoDate } from "@budget/engine" */

// An invented household, not this one. Every figure here is made up and round
// — the repo's own rule is that no real financial data lives in it
// (phases/README.md), and round numbers also make a failing assertion legible
// without a calculator.
//
// It is deliberately small but COMPLETE: two people, a primary pay schedule,
// a landing account, an account with no balance recorded, an external
// account, one bill of each interesting amount model, an essential and a
// non-essential variable category with history, an allocation plan with all
// three sections populated, and both kinds of goal. Every branch the
// dashboard has an `if` for is reachable from it.

/** The date every test reports on — a payday of the schedule below. */
export const ON = /** @type {IsoDate} */ ("2026-03-13");

const ID = {
  ada: "10000000-0000-4000-8000-000000000001",
  ben: "10000000-0000-4000-8000-000000000002",
  paySchedule: "10000000-0000-4000-8000-000000000010",
  everyday: "10000000-0000-4000-8000-000000000101",
  savings: "10000000-0000-4000-8000-000000000102",
  mojo: "10000000-0000-4000-8000-000000000103",
  unrecorded: "10000000-0000-4000-8000-000000000104",
  mortgage: "10000000-0000-4000-8000-000000000105",
  usual: "10000000-0000-4000-8000-000000000201",
  leave: "10000000-0000-4000-8000-000000000202",
  utilities: "10000000-0000-4000-8000-000000000301",
  insurance: "10000000-0000-4000-8000-000000000302",
  groceries: "10000000-0000-4000-8000-000000000303",
  fun: "10000000-0000-4000-8000-000000000304",
  power: "10000000-0000-4000-8000-000000000401",
  water: "10000000-0000-4000-8000-000000000402",
  carInsurance: "10000000-0000-4000-8000-000000000403",
  plan: "10000000-0000-4000-8000-000000000501",
  leavePlan: "10000000-0000-4000-8000-000000000503",
  activeVersion: "10000000-0000-4000-8000-000000000502",
  mojoGoal: "10000000-0000-4000-8000-000000000601",
  holidayGoal: "10000000-0000-4000-8000-000000000602",
};

export { ID as HOUSEHOLD_IDS };

/**
 * The settings rows `pnpm db:seed` writes on any database. Without them
 * `<Money>`-shaped code has no currency and the bills buffer has no zero, so
 * they belong in every fixture rather than only in the ones that read them.
 *
 * @param {Db} db
 */
export async function seedSettings(db) {
  await db.insert(settings).values([
    { key: "schema_seed_version", value: 1 },
    { key: "currency", value: "AUD" },
    { key: "locale", value: "en-AU" },
    { key: "billsBufferCents", value: 0 },
    { key: "historyLookbackDefault", value: 6 },
  ]);
}

/**
 * Inserts the whole household. Returns the ids so a test can reach back in
 * and change one thing — archive a variant, delete a balance — rather than
 * building a second near-identical fixture for each variation.
 *
 * @param {Db} db
 */
export async function seedHousehold(db) {
  await seedSettings(db);

  await db.insert(people).values([
    { id: ID.ada, name: "Ada", sortOrder: 0 },
    { id: ID.ben, name: "Ben", sortOrder: 1 },
  ]);

  // Fortnightly from 2026-01-02, so 2026-03-13 (ON) is itself a payday and
  // the cycle it opens runs to 2026-03-27.
  await db.insert(paySchedules).values({
    id: ID.paySchedule,
    personId: ID.ada,
    anchorDate: "2026-01-02",
    cadence: "fortnightly",
    isPrimary: true,
  });

  await db.insert(accounts).values([
    { id: ID.everyday, name: "Everyday", type: "transaction", isIncomeLanding: true, sortOrder: 0 },
    { id: ID.savings, name: "Savings", type: "savings", sortOrder: 1 },
    { id: ID.mojo, name: "Mojo", type: "savings", sortOrder: 2 },
    // No balance snapshot is written for this one, on purpose: it is what
    // raises `no_balance_recorded` and what `accountsWithoutBalance` counts.
    { id: ID.unrecorded, name: "Shares", type: "investment", sortOrder: 3 },
    // External accounts are excluded from net worth, so an external account
    // WITHOUT a balance must not be counted as an unrecorded one either.
    { id: ID.mortgage, name: "Mortgage", type: "external", sortOrder: 4 },
  ]);

  await db.insert(incomeVariants).values([
    { id: ID.usual, name: "Usual", sortOrder: 0 },
    { id: ID.leave, name: "Parental leave", sortOrder: 1 },
  ]);

  await db.insert(incomeLines).values([
    { variantId: ID.usual, personId: ID.ada, amountCents: 300_000, cadence: "fortnightly", sortOrder: 0 },
    { variantId: ID.usual, personId: ID.ben, amountCents: 220_000, cadence: "fortnightly", sortOrder: 1 },
    // A different cadence on purpose: the gross the allocation divides has to
    // survive a cadence conversion, and a fixture where every line is already
    // fortnightly would never exercise it.
    { variantId: ID.usual, personId: ID.ben, label: "Dividends", amountCents: 60_000, cadence: "quarterly", sortOrder: 2 },
    { variantId: ID.leave, personId: ID.ada, amountCents: 90_000, cadence: "fortnightly", sortOrder: 0 },
    { variantId: ID.leave, personId: ID.ben, amountCents: 220_000, cadence: "fortnightly", sortOrder: 1 },
  ]);

  // Open-ended, so ON resolves to exactly one variant. Tests that want an
  // overlap or a gap add or remove an entry themselves.
  await db.insert(variantSchedule).values({ variantId: ID.usual, startsOn: "2025-07-01", endsOn: null });

  await db.insert(costCategories).values([
    { id: ID.utilities, name: "Utilities", kind: "fixed", isEssential: true, sortOrder: 0 },
    { id: ID.insurance, name: "Insurance", kind: "fixed", isEssential: true, sortOrder: 1 },
    { id: ID.groceries, name: "Groceries", kind: "variable", isEssential: true, sortOrder: 2 },
    { id: ID.fun, name: "Fun", kind: "variable", isEssential: false, sortOrder: 3 },
  ]);

  await db.insert(bills).values([
    {
      id: ID.power,
      categoryId: ID.utilities,
      name: "Power",
      paidFromAccountId: ID.everyday,
      baseAmountCents: 42_000,
      frequency: "quarterly",
      anchorDate: "2026-01-15",
      amountModel: "flat",
      sortOrder: 0,
    },
    {
      id: ID.water,
      categoryId: ID.utilities,
      name: "Water",
      paidFromAccountId: ID.everyday,
      baseAmountCents: 18_000,
      frequency: "quarterly",
      anchorDate: "2026-02-20",
      amountModel: "flat",
      sortOrder: 1,
    },
    {
      id: ID.carInsurance,
      categoryId: ID.insurance,
      name: "Car insurance",
      ownerPersonId: ID.ada,
      paidFromAccountId: ID.everyday,
      baseAmountCents: 120_000,
      frequency: "yearly",
      anchorDate: "2026-03-20",
      // An escalating bill is the one whose four-year average differs from
      // its face value, which is exactly what makes the dashboard's bills
      // contribution worth cross-checking against /fixed-costs.
      amountModel: "escalating",
      escalationPct: 5,
      sortOrder: 2,
    },
  ]);

  await db.insert(variableBudgets).values([
    { categoryId: ID.groceries, amountCents: 120_000, cadence: "monthly", effectiveFrom: "2025-07-01" },
    { categoryId: ID.fun, amountCents: 40_000, cadence: "monthly", effectiveFrom: "2025-07-01" },
  ]);

  // Three closed cycles of history for groceries, none for Fun — so the
  // trailing average covers one category of two, which is the case
  // `categoriesWithHistory` exists to report.
  await db.insert(variableActuals).values([
    { categoryId: ID.groceries, cycleStart: "2026-01-16", amountCents: 61_000 },
    { categoryId: ID.groceries, cycleStart: "2026-01-30", amountCents: 58_000 },
    { categoryId: ID.groceries, cycleStart: "2026-02-13", amountCents: 66_000 },
  ]);

  await db.insert(allocationPlans).values({ id: ID.plan, name: "Usual plan", incomeVariantId: ID.usual });
  await db.insert(allocationVersions).values({
    id: ID.activeVersion,
    planId: ID.plan,
    version: 1,
    status: "active",
    activatedAt: new Date("2026-01-02T00:00:00Z"),
  });

  // One line per interesting basis, spread across all three sections, and a
  // sweep last so nothing is left unallocated by construction.
  await db.insert(allocationLines).values([
    { versionId: ID.activeVersion, stage: 1, label: "Bills", basis: "from_fixed_costs", accountId: ID.everyday, sortOrder: 0 },
    { versionId: ID.activeVersion, stage: 1, label: "Essentials", basis: "from_variable_essentials", accountId: ID.everyday, sortOrder: 1 },
    { versionId: ID.activeVersion, stage: 2, label: "Mojo", basis: "pct_of_gross", value: 10, accountId: ID.mojo, sortOrder: 2 },
    { versionId: ID.activeVersion, stage: 2, label: "House deposit", basis: "fixed_amount", value: 80_000, accountId: ID.savings, sortOrder: 3 },
    { versionId: ID.activeVersion, stage: 3, label: "Spending", basis: "sweep", accountId: ID.everyday, sortOrder: 4 },
  ]);

  await db.insert(allocationStageGoals).values([
    { versionId: ID.activeVersion, stage: 1, goalPct: 55 },
    { versionId: ID.activeVersion, stage: 2, goalPct: 20 },
    { versionId: ID.activeVersion, stage: 3, goalPct: 25 },
  ]);

  // Two snapshots per account, a month apart, so the net-worth series has a
  // slope rather than a single point. The newest is ON itself, which keeps
  // the fixture out of the stale-balance branch until a test asks for it.
  await db.insert(balanceSnapshots).values([
    { accountId: ID.everyday, asAt: "2026-02-13", amountCents: 410_000 },
    { accountId: ID.everyday, asAt: ON, amountCents: 455_000 },
    { accountId: ID.savings, asAt: "2026-02-13", amountCents: 1_200_000 },
    { accountId: ID.savings, asAt: ON, amountCents: 1_280_000 },
    { accountId: ID.mojo, asAt: "2026-02-13", amountCents: 900_000 },
    { accountId: ID.mojo, asAt: ON, amountCents: 950_000 },
    // An external account's balance is recorded but must not reach net worth.
    { accountId: ID.mortgage, asAt: ON, amountCents: -48_000_000 },
  ]);

  await db.insert(goals).values([
    {
      id: ID.mojoGoal,
      accountId: ID.mojo,
      name: "Emergency fund",
      targetMode: "months_of_expenses",
      targetMonths: 6,
      status: "active",
    },
    {
      id: ID.holidayGoal,
      accountId: ID.savings,
      name: "House deposit",
      targetMode: "amount",
      targetAmountCents: 4_000_000,
      targetDate: "2027-06-30",
      status: "active",
    },
  ]);

  return ID;
}
