import { mustAt } from "@budget/engine";
import {
  accounts,
  balanceSnapshots,
  createAccountSchema,
  createBalanceSnapshotSchema,
  reorderSchema,
  updateAccountSchema,
} from "@budget/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, ne } from "drizzle-orm";
import { Hono } from "hono";
import { getUserId } from "../lib/app-env.js";
import { writeAuditLog } from "../lib/audit.js";
import { isUniqueViolation } from "../lib/db-errors.js";
import { reorderError } from "../lib/reorder.js";
import { handleValidation } from "../lib/validation.js";

const INCOME_LANDING_CONFLICT = {
  error: {
    code: "income_landing_conflict",
    message: "Another account is already the income-landing account.",
  },
};

/**
 * `external` accounts receive transfers and never hold a balance or a
 * growth assumption — a semantic rule, not a shape rule, so it's checked
 * here rather than in Zod (phases/04-accounts-people.md "Constraints to
 * enforce in the database, not just the API").
 *
 * @param {{ type: string, annualGrowthRate?: number | null }} data
 */
function externalAccountError(data) {
  if (data.type === "external" && data.annualGrowthRate != null) {
    return "External accounts can't have a growth rate.";
  }
  return null;
}

/**
 * @param {import("@budget/schema").Db["query"]["balanceSnapshots"]} query
 * @param {string} accountId
 */
async function latestBalanceFor(query, accountId) {
  const latest = await query.findFirst({
    where: (b, { eq: eqCol }) => eqCol(b.accountId, accountId),
    orderBy: (b, { desc: descCol }) => descCol(b.asAt),
  });
  return latest ? { amountCents: latest.amountCents, asAt: latest.asAt } : null;
}

/**
 * @param {{ db: import("@budget/schema").Db }} deps
 */
export function createAccountsRoutes({ db }) {
  const app = new Hono();

  return app
    // One request for list screens: each account comes with its latest
    // snapshot joined on (phases/04-accounts-people.md "API"). Archived
    // accounts are hidden here — pickers and this list share this endpoint.
    .get("/", async (c) => {
      const rows = await db.query.accounts.findMany({
        where: (a, { isNull: isNullCol }) => isNullCol(a.archivedAt),
        orderBy: (a, { asc }) => [asc(a.sortOrder), asc(a.name)],
      });
      const result = [];
      for (const account of rows) {
        result.push({
          id: account.id,
          name: account.name,
          type: account.type,
          institution: account.institution,
          isIncomeLanding: account.isIncomeLanding,
          annualGrowthRate: account.annualGrowthRate,
          sortOrder: account.sortOrder,
          latestBalance: await latestBalanceFor(db.query.balanceSnapshots, account.id),
        });
      }
      return c.json({ accounts: result });
    })

    // Not in the phase doc's route table, but needed by the per-account
    // detail screen and by historic records that must still render a name
    // for an archived account — so, unlike the list above, this doesn't
    // filter on archivedAt.
    .get("/:id", async (c) => {
      const id = c.req.param("id");
      const account = await db.query.accounts.findFirst({
        where: (a, { eq: eqCol }) => eqCol(a.id, id),
      });
      if (!account) {
        return c.json({ error: { code: "not_found", message: "Account not found." } }, 404);
      }
      return c.json({
        account: {
          ...account,
          latestBalance: await latestBalanceFor(db.query.balanceSnapshots, id),
        },
      });
    })

    .post("/", zValidator("json", createAccountSchema, handleValidation), async (c) => {
      const data = c.req.valid("json");

      const externalError = externalAccountError(data);
      if (externalError) {
        return c.json({ error: { code: "invalid_account", message: externalError } }, 400);
      }

      // Pre-check for a friendly message; the partial unique index on
      // accounts.is_income_landing is the actual guarantee under a race. Live
      // rows only, matching that index.
      if (data.isIncomeLanding) {
        const existing = await db.$count(
          accounts,
          and(eq(accounts.isIncomeLanding, true), isNull(accounts.archivedAt)),
        );
        if (existing > 0) return c.json(INCOME_LANDING_CONFLICT, 400);
      }

      try {
        const created = await db.insert(accounts).values(data).returning();
        const account = mustAt(created, 0, "created account");

        await writeAuditLog(db, {
          actorId: getUserId(c),
          action: "account.create",
          entityType: "account",
          entityId: account.id,
          metadata: data,
        });

        return c.json({ account }, 201);
      } catch (err) {
        if (isUniqueViolation(err)) return c.json(INCOME_LANDING_CONFLICT, 400);
        throw err;
      }
    })

    // The whole list in its new order, renumbered 0..n-1 in one transaction.
    // See the schema's own comment for why this is not a `sortOrder` field on
    // the edit form: every row starts at the column default of 0, so there is
    // no per-row number to nudge until something has written a real one.
    .post("/reorder", zValidator("json", reorderSchema, handleValidation), async (c) => {
      const { ids } = c.req.valid("json");

      const rows = await db.query.accounts.findMany({
        where: (a, { isNull: isNullCol }) => isNullCol(a.archivedAt),
        columns: { id: true },
      });
      const problem = reorderError(ids, rows.map((row) => row.id), "accounts");
      if (problem) {
        return c.json({ error: { code: "incomplete_order", message: problem } }, 400);
      }

      await db.transaction(async (tx) => {
        for (const [index, id] of ids.entries()) {
          await tx.update(accounts).set({ sortOrder: index }).where(eq(accounts.id, id));
        }
      });

      // No audit entry, unlike every other write on this router. The log is
      // keyed to one entity by a NOT NULL `entity_id`, and a reorder is a
      // statement about the list rather than about any row in it — it would
      // have to be either a fabricated id or one line per account. It also
      // changes no financial value: `sortOrder` decides what order the
      // screen lists accounts in and nothing else reads it.
      return c.json({ ok: true });
    })

    .patch("/:id", zValidator("json", updateAccountSchema, handleValidation), async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");

      const current = await db.query.accounts.findFirst({ where: (a, { eq: eqCol }) => eqCol(a.id, id) });
      if (!current) {
        return c.json({ error: { code: "not_found", message: "Account not found." } }, 404);
      }

      const nextType = data.type ?? current.type;
      const nextGrowthRate = "annualGrowthRate" in data ? data.annualGrowthRate : current.annualGrowthRate;
      const externalError = externalAccountError({ type: nextType, annualGrowthRate: nextGrowthRate });
      if (externalError) {
        return c.json({ error: { code: "invalid_account", message: externalError } }, 400);
      }

      if (data.isIncomeLanding) {
        // The index no longer covers archived rows, so it would let an archived
        // account hold the flag beside a live one.
        if (current.archivedAt) {
          return c.json(
            { error: { code: "archived", message: "An archived account can't be the income-landing account." } },
            400,
          );
        }
        const existing = await db.$count(
          accounts,
          and(eq(accounts.isIncomeLanding, true), isNull(accounts.archivedAt), ne(accounts.id, id)),
        );
        if (existing > 0) return c.json(INCOME_LANDING_CONFLICT, 400);
      }

      try {
        const [updated] = await db.update(accounts).set(data).where(eq(accounts.id, id)).returning();
        if (!updated) {
          return c.json({ error: { code: "not_found", message: "Account not found." } }, 404);
        }

        await writeAuditLog(db, {
          actorId: getUserId(c),
          action: "account.update",
          entityType: "account",
          entityId: id,
          metadata: data,
        });

        return c.json({ account: updated });
      } catch (err) {
        if (isUniqueViolation(err)) return c.json(INCOME_LANDING_CONFLICT, 400);
        throw err;
      }
    })

    // Archive — never a hard delete. An account referenced by an
    // allocation line, goal or snapshot must stay resolvable so historic
    // records keep rendering a name (phases/04-accounts-people.md).
    //
    // Archiving the income-landing account also gives up the flag, for the
    // reason pay-schedules.js gives for the primary flag: left set, it blocked
    // every other account from taking it from a row nobody could see.
    .delete("/:id", async (c) => {
      const id = c.req.param("id");
      const current = await db.query.accounts.findFirst({
        where: (a, { and: andCol, eq: eqCol, isNull: isNullCol }) => andCol(eqCol(a.id, id), isNullCol(a.archivedAt)),
      });
      const [archived] = await db
        .update(accounts)
        .set({ archivedAt: new Date(), isIncomeLanding: false })
        .where(and(eq(accounts.id, id), isNull(accounts.archivedAt)))
        .returning();
      if (!archived) {
        return c.json({ error: { code: "not_found", message: "Account not found." } }, 404);
      }
      await writeAuditLog(db, {
        actorId: getUserId(c),
        action: "account.archive",
        entityType: "account",
        entityId: id,
        metadata: { wasIncomeLanding: current?.isIncomeLanding ?? false },
      });
      return c.json({ ok: true });
    })

    .get("/:id/balances", async (c) => {
      const accountId = c.req.param("id");
      const rows = await db.query.balanceSnapshots.findMany({
        where: (b, { eq: eqCol }) => eqCol(b.accountId, accountId),
        orderBy: (b, { desc: descCol }) => descCol(b.asAt),
      });
      return c.json({ balances: rows });
    })

    .post(
      "/:id/balances",
      zValidator("json", createBalanceSnapshotSchema, handleValidation),
      async (c) => {
        const accountId = c.req.param("id");
        const data = c.req.valid("json");

        const account = await db.query.accounts.findFirst({
          where: (a, { eq: eqCol }) => eqCol(a.id, accountId),
        });
        if (!account) {
          return c.json({ error: { code: "not_found", message: "Account not found." } }, 404);
        }
        if (account.type === "external") {
          return c.json(
            { error: { code: "invalid_account", message: "External accounts don't hold a balance." } },
            400,
          );
        }

        // Two snapshots for the same account and date conflict; upsert
        // rather than error (phases/04-accounts-people.md "Acceptance
        // criteria").
        const [snapshot] = await db
          .insert(balanceSnapshots)
          .values({ accountId, ...data })
          .onConflictDoUpdate({
            target: [balanceSnapshots.accountId, balanceSnapshots.asAt],
            set: { amountCents: data.amountCents, note: data.note ?? null },
          })
          .returning();
        const created = mustAt(snapshot ? [snapshot] : [], 0, "balance snapshot");

        await writeAuditLog(db, {
          actorId: getUserId(c),
          action: "balance_snapshot.upsert",
          entityType: "balance_snapshot",
          entityId: created.id,
          metadata: { accountId, asAt: data.asAt, amountCents: data.amountCents },
        });

        return c.json({ balance: created }, 201);
      },
    );
}
