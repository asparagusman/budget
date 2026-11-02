import { date, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Values match packages/engine's `HouseScheme` union verbatim (see
// packages/engine/src/house.js).
export const houseScheme = pgEnum("house_scheme", ["first_home_guarantee", "help_to_buy", "standard"]);

// One purchase the household wants to test against its budget: a price, a
// scheme, a date. Like a goal, a scenario REPORTS — nothing here ever writes
// an allocation line. Every result (duty, deposit, repayment, what's spare) is
// computed on read from the live budget, so none of it is stored.
//
// The budget a scenario is read against — which income, which bills stop, the
// salaries — is household-wide and lives in the settings table under `house`
// (see packages/schema/src/zod/house.js), not on each row.
export const houseScenarios = pgTable("house_scenarios", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  scheme: houseScheme("scheme").notNull().default("first_home_guarantee"),
  priceCents: integer("price_cents").notNull(),
  // The day the deposit is counted on: cash is projected forward to here.
  purchaseDate: date("purchase_date").notNull(),
  ratePct: numeric("rate_pct", { precision: 6, scale: 3, mode: "number" }).notNull(),
  childcarePerMonthCents: integer("childcare_per_month_cents").notNull().default(0),
  // Annual gross change per person id, signed: { [personId]: cents }. A move
  // to part-time is a negative change. People are referenced by id inside the
  // JSON rather than through a join table; an id that no longer matches a
  // salary is reported by the engine, not silently dropped.
  payChanges: jsonb("pay_changes").notNull().default({}),
  // Null means "project it": the chosen accounts' balances plus what the
  // allocation sends them until `purchaseDate`. A number replaces that.
  cashOverrideCents: integer("cash_override_cents"),
  // Added on top either way — a gift, a fund that will be redirected.
  extraCashCents: integer("extra_cash_cents").notNull().default(0),
  // Help to Buy only: the lender's borrowing limit the government's share is
  // sized from. Required for that scheme — a semantic rule enforced in the
  // API (apps/api/src/lib/house.js), not a check constraint.
  lenderLimitCents: integer("lender_limit_cents"),
  note: text("note"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
