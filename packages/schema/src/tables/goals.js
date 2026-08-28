import { date, integer, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.js";

// Values match packages/engine's `TargetMode` union verbatim (see
// packages/engine/src/goals.js).
export const targetMode = pgEnum("target_mode", ["amount", "months_of_expenses"]);

export const goalStatus = pgEnum("goal_status", ["active", "achieved", "abandoned"]);

// A goal REPORTS. It never writes: no allocation line is created, adjusted or
// suggested from anything here, under any setting (phases/09-goals-projections.md
// "Advisory only — the hard boundary of this phase").
//
// Everything a goal reports is computed on read — the ETA, the progress
// percentage, the required contribution, and (in `months_of_expenses` mode) the
// target itself. Nothing derived is stored, deliberately: a cached ETA on a
// financial screen is worse than no ETA, because it looks current.
export const goals = pgTable("goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Cascade, unlike most references here: a goal is a statement about one
  // account and means nothing without it. Accounts are archived rather than
  // deleted in normal use, so this fires only on a genuine hard delete.
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  targetMode: targetMode("target_mode").notNull().default("amount"),
  // Required when targetMode is 'amount' — a semantic rule, enforced in the
  // API (see apps/api/src/lib/goals.js's `targetModeFieldError`) rather than
  // by a check constraint, matching how bills' amountModel fields work.
  targetAmountCents: integer("target_amount_cents"),
  // Required when targetMode is 'months_of_expenses'. Fractional months are
  // legitimate ("2.5 months"), hence numeric rather than integer.
  targetMonths: numeric("target_months", { precision: 5, scale: 2, mode: "number" }),
  // Null means no deadline — the ETA is still computed, only the required
  // contribution needs a date to aim at.
  targetDate: date("target_date"),
  note: text("note"),
  status: goalStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
