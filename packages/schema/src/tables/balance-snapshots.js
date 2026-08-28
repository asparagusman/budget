import { date, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.js";

// Balances are dated snapshots, not a mutable number — same effort to
// enter, but it yields net worth over time, honest goal history, and an
// "as at" date the operator can trust. Never add a `currentBalance` column
// to accounts; the current balance is always the latest snapshot, derived.
export const balanceSnapshots = pgTable(
  "balance_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    asAt: date("as_at").notNull(),
    // May be negative (an offset account, a card) — no non-negative check.
    amountCents: integer("amount_cents").notNull(),
    note: text("note"),
  },
  (table) => [
    // One snapshot per account per day; the API upserts on this rather than
    // erroring (phases/04-accounts-people.md "Acceptance criteria").
    uniqueIndex("balance_snapshots_account_id_as_at_unique").on(table.accountId, table.asAt),
  ],
);
