import { sql } from "drizzle-orm";
import { integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.js";
import { incomeVariants } from "./income-variants.js";
import { users } from "./users.js";

export const allocationStatus = pgEnum("allocation_status", ["draft", "active", "archived"]);

// Values match packages/engine's `Basis` union verbatim (see
// packages/engine/src/allocation.js). The spreadsheet encoded this
// positionally — rows 11-16 were implicitly "% of gross", rows 19-20
// implicitly "% of remaining", and nothing said so; it lived in the
// formulas. That implicitness is exactly why changing one number "threw out
// all the transfers": the operator could not see what each row was a
// percentage *of* (phases/08-allocation.md "Why explicit basis").
export const allocationBasis = pgEnum("allocation_basis", [
  "from_fixed_costs",
  "from_variable_essentials",
  "pct_of_gross",
  "pct_of_remaining",
  "fixed_amount",
  "sweep",
]);

// The lineage, not a version: a plan is "the Usual allocation", and its
// versions are its history. One plan per income variant is the expected
// shape (the spreadsheet had four sheets for four variants) but uniqueness
// is deliberately NOT enforced — the operator may want two alternatives for
// one variant to compare (phases/08-allocation.md "Constraints").
export const allocationPlans = pgTable("allocation_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  incomeVariantId: uuid("income_variant_id")
    .notNull()
    .references(() => incomeVariants.id),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const allocationVersions = pgTable(
  "allocation_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => allocationPlans.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: allocationStatus("status").notNull().default("draft"),
    // Which version this one was copied from — the draft's provenance, kept
    // so "reverted from v3" is legible in the history timeline. Drizzle needs
    // an explicit column type on a self-reference; JSDoc supplies it on the
    // callback's return rather than casting the table.
    basedOnVersionId: uuid("based_on_version_id").references(
      /** @returns {import("drizzle-orm/pg-core").AnyPgColumn} */ () => allocationVersions.id,
    ),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("allocation_versions_plan_id_version_unique").on(table.planId, table.version),
    // At most one active version per plan, and at most one draft — both in
    // the database, not just the API (phases/README.md "Database"). Two
    // people editing the same plan share one draft rather than forking it;
    // this household has two users on one dataset
    // (phases/08-allocation.md "Constraints").
    uniqueIndex("allocation_versions_active_unique")
      .on(table.planId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("allocation_versions_draft_unique")
      .on(table.planId)
      .where(sql`${table.status} = 'draft'`),
  ],
);

// An active or archived version's lines are immutable — enforced in the API
// (routes/allocation-versions.js rejects writes to a non-draft version).
// Immutability is what makes the history trustworthy: "this is what the
// transfers were in March" has to still be true in June.
export const allocationLines = pgTable("allocation_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  versionId: uuid("version_id")
    .notNull()
    .references(() => allocationVersions.id, { onDelete: "cascade" }),
  // 1..N, evaluated in ascending order by the engine. Every line in a stage
  // resolves against the same snapshot of remaining taken at stage entry.
  stage: integer("stage").notNull(),
  label: text("label").notNull(),
  basis: allocationBasis("basis").notNull(),
  // What `value` means depends on `basis` — a percentage for the two `pct_*`
  // bases, integer CENTS PER MONTH for `fixed_amount`, a relative weight for
  // `sweep`, and ignored entirely for the two `from_*` bases (the amount is
  // injected from the fixed-cost and variable-essentials totals instead).
  // `mode: "number"` for the same reason as accounts.annualGrowthRate: 12
  // significant digits at scale 4 never approaches JS's safe-integer range.
  value: numeric("value", { precision: 12, scale: 4, mode: "number" }),
  // The operator's target for this line as a percentage of gross — what the
  // spreadsheet's "Goal %" column held. Advisory only: nothing in the engine
  // or the API ever writes an allocation to meet a goal.
  goalPct: numeric("goal_pct", { precision: 6, scale: 2, mode: "number" }),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  sortOrder: integer("sort_order").notNull().default(0),
});
