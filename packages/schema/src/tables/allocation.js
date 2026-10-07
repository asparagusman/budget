import { sql } from "drizzle-orm";
import { integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    // The standing-transfer amounts as they were resolved at the moment this
    // version was applied: per destination, per pay, with the pay cadence,
    // the date they were computed for and the account names of the day. A
    // version stores rules (basis + value), so without this every later
    // change to a bill, a budget or an income line silently moved the figure
    // the operator had typed into the bank, and nothing could say the bank
    // orders were now stale. Shape: `appliedSnapshotSchema` in
    // zod/allocation.js, which every read goes through.
    //
    // jsonb on the version rather than a child table, deliberately. It is
    // written exactly once, in the same statement that flips the version to
    // active, and is only ever read whole — never filtered or joined by
    // destination, never edited. It is a record of what was true at apply,
    // the same kind of thing as audit_log.metadata, which is why the account
    // NAMES are copied in rather than joined: a renamed or archived account
    // must not rewrite what the record says the bank was told. A child table
    // would buy per-row types for data no query ever looks inside, at the
    // cost of a second write that could land without the first.
    //
    // Null for a draft, and for a version applied before this column existed.
    // Those read as "not recorded" and show no drift: computing today's
    // figures for them and calling those "applied" would be a fabrication.
    // The next apply records it.
    appliedSnapshot: jsonb("applied_snapshot"),
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
  // SUPERSEDED by the three fixed sections (`ALLOCATION_SECTIONS` in
  // apps/web/src/lib/constants.js), which name stages 1/2/3 as Bills &
  // Essentials / Save, Invest & Give / Leftover. A per-line heading turned out
  // to be the wrong altitude: the spreadsheet's "Category" column IS the
  // section, and repeating it on every row put the sheet's own structure into
  // a side panel while the rows themselves read as an unlabelled list
  // (.claude/plans/allocation-fix.md).
  //
  // Kept, not dropped: the imported plans in the dev database hold real
  // category names here, and dropping the column to save nothing is a one-way
  // door. Nothing reads or writes it — the API no longer accepts it and the
  // engine no longer groups by it.
  category: text("category"),
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

// A goal on a whole SECTION, which the per-line `goalPct` cannot express.
// The spreadsheet carries Goal % in two places the app previously had no room
// for: on section A's Subtotal row (50% — "bills and essentials should be half
// our income") and on section B's Remaining row (10% — "a tenth should still
// be left afterwards"). Neither is the sum of any line's goal; A's lines are
// injected totals with no goal at all, and B's lines sum to 40% against a
// section actual of 31%.
//
// Keyed on `stage`, exactly like `allocation_lines`, because stage is what the
// engine evaluates and the section names are a 1:1 label on stages 1/2/3. And
// section B's "remaining" goal needs no separate concept: section C's lines
// sweep everything B leaves, so C's own subtotal IS that remaining, and a
// section goal on C is the sheet's 10%.
//
// Versioned alongside the lines and copied into a new draft with them — a
// draft that silently lost its section goals would be the same class of bug as
// one that lost its lines. Immutable on a non-draft version for the same
// reason `allocation_lines` is.
export const allocationStageGoals = pgTable(
  "allocation_stage_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => allocationVersions.id, { onDelete: "cascade" }),
    stage: integer("stage").notNull(),
    // `notNull` where the line's own `goalPct` is nullable: a line exists
    // whether or not it carries a goal, but a row here IS the goal — "no goal
    // on this section" is the absence of the row, not a row holding null.
    goalPct: numeric("goal_pct", { precision: 6, scale: 2, mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("allocation_stage_goals_version_stage_unique").on(table.versionId, table.stage)],
);
