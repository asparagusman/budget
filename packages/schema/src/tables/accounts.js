import { sql } from "drizzle-orm";
import { boolean, integer, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// A single account plays four roles at once — transfer destination, asset
// with a balance, goal container (phase 09), projection subject — which is
// not a shortcut, it reflects how the household actually uses these places
// money is sent. See phases/04-accounts-people.md.
export const accountType = pgEnum("account_type", ["transaction", "savings", "investment", "external"]);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // e.g. "ubank (House)", "2UP", "NewHope".
    name: text("name").notNull(),
    type: accountType("type").notNull(),
    // e.g. "ubank", "Up", "Raiz" — free text, not another enum.
    institution: text("institution"),
    // Marks the single account salary lands in AND fixed bills are debited
    // from — one account, both jobs. Phase 08 treats a transfer into this
    // account as a no-op (money that stays where it landed) rather than a
    // real movement, which is why the transfer list reconciles against
    // gross income rather than money actually moved. Get this flag wrong
    // and the whole allocation looks wrong.
    isIncomeLanding: boolean("is_income_landing").notNull().default(false),
    // 0.050000 = 5% p.a.; null for accounts with no compounding assumption
    // (transaction, external). Only stored here — phase 09's projections and
    // goal ETAs are the only consumers. `mode: "number"` — 9 significant
    // digits at scale 6 never approaches JS's safe-integer range, so there's
    // no precision reason to carry this as a string the way money is.
    //
    // Six decimal places, widened from four in phase 09: the rate is stored
    // ANNUALLY and the engine compounds it down to a month or a pay period,
    // so four places of a fraction is only two places of a percentage — too
    // coarse to hold a rate that came from a monthly figure (the household's
    // 0.0041/month is 5.032476% p.a., which at 5.03% drifts 34c over six
    // months on a $25k balance, and further every year after that).
    annualGrowthRate: numeric("annual_growth_rate", { precision: 9, scale: 6, mode: "number" }),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    // At most one income-landing account, enforced here rather than only in
    // the API — a partial unique index on the true value (phases/README.md
    // "Database", phases/04-accounts-people.md "Constraints to enforce in
    // the database, not just the API").
    //
    // Live accounts only. Every computation already ignores an archived
    // account, so an index that still counted one let archiving the landing
    // account leave a flag nothing could see blocking every other account
    // from taking it — with no way out in the UI. Archiving now clears the
    // flag as well (routes/accounts.js); this is the guarantee under it.
    uniqueIndex("accounts_income_landing_unique")
      .on(table.isIncomeLanding)
      .where(sql`${table.isIncomeLanding} AND ${table.archivedAt} IS NULL`),
  ],
);
