import { computeAllocation, equivalent, mustAt } from "@budget/engine";
import {
  accounts as accountsTable,
  allocationLines,
  allocationPlans,
  allocationVersions,
  balanceSnapshots,
  bills as billsTable,
  costCategories,
  incomeLines,
  incomeVariants,
  people as peopleTable,
  variableBudgets,
} from "@budget/schema";
import { eq } from "drizzle-orm";
import { normaliseDestination } from "./parse.js";

/** @import { AllocationLine, Cadence, Cents } from "@budget/engine" */
/** @import { ImportPlan } from "./parse.js" */

// Writes a parsed, operator-confirmed import plan to the database.
//
// Three properties this module has to hold, and the reasons they matter:
//
//   ADDITIVE AND IDEMPOTENT. Every entity is matched on a natural key — a
//   person's name, a (category, bill name) pair, a plan's name — so
//   re-importing the same workbook updates rather than duplicating. That is
//   an acceptance criterion, and it is also what makes the import safe to
//   retry after a half-answered mapping step.
//
//   Only LIVE rows are matched. An archived row is hidden from every screen,
//   so a re-import that wrote into one changed something nobody could see;
//   its natural key now creates a fresh row instead, which is visible and
//   honest. And a match updates only the fields the workbook is the source
//   of — everything the operator tuned after the first import is left alone
//   (see REIMPORT_RULES, which is also what the preview tells them).
//
//   NEVER ACTIVATES AN ALLOCATION. Imported plan lines land in a DRAFT
//   version. An active version's lines are immutable (phases/08-allocation.md
//   "Constraints"), and more importantly the app does not get to decide what
//   the household's standing orders are — the operator applies the draft
//   (phases/README.md "The one rule").
//
//   ONE TRANSACTION. An import that half-lands is worse than one that fails:
//   the second run would see partial natural keys and reconcile against a
//   state neither the operator nor the spreadsheet describes.

/**
 * @typedef {{ accountId: string } | { create: { name: string, type: "transaction" | "savings" | "investment" | "external" } }} DestinationChoice
 */

/**
 * @typedef {{
 *   anchorDate: string,
 *   selected: string[],
 *   destinations: Record<string, DestinationChoice>,
 *   planVariants: Record<string, string>,
 * }} ImportSelection
 */

/**
 * A destination the operator did not map, or a plan whose income variant is
 * still ambiguous. Thrown rather than defaulted: guessing which account money
 * goes to is exactly the class of decision this app never makes for itself.
 */
export class ImportSelectionError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ImportSelectionError";
  }
}

/**
 * @param {ImportPlan} plan
 * @param {ImportSelection} selection
 */
function validateSelection(plan, selection) {
  const selected = new Set(selection.selected);

  // Only destinations actually referenced by a selected row need mapping;
  // deselecting a whole plan should not force the operator to map its
  // accounts.
  /** @type {Set<string>} */
  const needed = new Set();
  for (const p of plan.plans) {
    for (const line of p.lines) {
      if (selected.has(line.key) && line.destinationKey) needed.add(line.destinationKey);
    }
  }
  for (const balance of plan.balances) {
    if (selected.has(balance.key)) needed.add(balance.destinationKey);
  }

  const unmapped = [...needed].filter((key) => !selection.destinations[key]);
  if (unmapped.length > 0) {
    const names = unmapped.map((key) => plan.destinations.find((d) => d.key === key)?.raw ?? key);
    throw new ImportSelectionError(
      `Map every destination to an account first. Still unmapped: ${names.join(", ")}.`,
    );
  }

  for (const p of plan.plans) {
    const hasSelectedLine = p.lines.some((line) => selected.has(line.key));
    if (!hasSelectedLine) continue;
    const variantKey = selection.planVariants[p.key] ?? (p.variantAmbiguous ? null : p.variantKey);
    if (!variantKey) {
      throw new ImportSelectionError(`Choose the income variant "${p.name}" divides before importing.`);
    }
    if (!plan.variants.some((v) => v.key === variantKey)) {
      throw new ImportSelectionError(`"${p.name}" points at an income variant that is not in this workbook.`);
    }
  }

  return selected;
}

/**
 * Upsert-by-natural-key over a small list already loaded into memory. Every
 * entity in this module goes through the same shape: find the existing row,
 * update it if anything actually differs, otherwise insert.
 *
 * @template {{ id: string }} T
 * @param {T[]} existing
 * @param {(row: T) => boolean} match
 */
function findExisting(existing, match) {
  return existing.find(match) ?? null;
}

/**
 * Natural keys compare names case-insensitively — "Rent" and "rent" are one
 * bill to a household, and a re-import must not duplicate it over a capital.
 *
 * @param {string} a
 * @param {string} b
 */
function sameName(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * What a re-import changes on a row it MATCHES, entity by entity — the one
 * statement of it. `applyImport` writes exactly these fields and no others,
 * and the preview hands this list to the operator before anything is written,
 * so the two cannot say different things.
 */
export const REIMPORT_RULES = [
  "Rows are matched by name, ignoring case. Archived rows are never matched or written to — a name that only an archived row has imports as a new row.",
  "Bills: only the amount and the frequency are updated. The due date, amount model, escalation, rolling window, seasonal factors, step changes, owner, paid-from account, notes and order are left as you set them.",
  "Income lines: the amount and the cadence are updated.",
  "Variable-cost categories: whether the category is essential is updated, and a monthly budget effective from the import date is added (or replaces one already on that date).",
  "Allocation plans: the income variant the plan divides is updated, and its open draft is replaced by the workbook's lines. The active version — your standing orders — is never touched.",
  "Balances: a balance on the import date is added (or replaces one already on that date), and the account's growth rate is updated.",
  "People, income variants, accounts and fixed-cost categories are only ever reused or created, never changed.",
];

/**
 * Applies the plan. Returns a reconciliation: what the spreadsheet said,
 * beside what the app now holds, for every figure the operator would check.
 *
 * @param {import("@budget/schema").Db} db
 * @param {{ plan: ImportPlan, selection: ImportSelection, actorId: string | null }} args
 */
export async function applyImport(db, { plan, selection, actorId }) {
  const selected = validateSelection(plan, selection);
  const anchorDate = selection.anchorDate;

  return db.transaction(async (tx) => {
    /** @type {string[]} */
    const createdAccountNames = [];

    // ---- accounts (mapped, or explicitly created by name) -----------------
    // Live accounts only: the preview only ever offered live ones, so an
    // `accountId` that is no longer among them was archived in between, and
    // money must not be routed to an account nobody can see.
    const existingAccounts = await tx.query.accounts.findMany({ where: (a, { isNull }) => isNull(a.archivedAt) });
    /** @type {Map<string, string>} */
    const accountIdByDestination = new Map();

    for (const [destinationKey, choice] of Object.entries(selection.destinations)) {
      if ("accountId" in choice) {
        const account = findExisting(existingAccounts, (a) => a.id === choice.accountId);
        if (!account) throw new ImportSelectionError("A destination account no longer exists.");
        accountIdByDestination.set(destinationKey, account.id);
        continue;
      }
      // Explicitly requested by the operator in the mapping step — the only
      // path that creates an account, and it still reuses one of the same
      // name rather than making a second (phases/11-polish-mobile-import.md,
      // workstream C, item 4: "Do not create accounts silently").
      const byName = findExisting(existingAccounts, (a) => sameName(a.name, choice.create.name));
      if (byName) {
        accountIdByDestination.set(destinationKey, byName.id);
        continue;
      }
      const inserted = await tx
        .insert(accountsTable)
        .values({ name: choice.create.name, type: choice.create.type })
        .returning();
      const account = mustAt(inserted, 0, "created account");
      existingAccounts.push(account);
      createdAccountNames.push(account.name);
      accountIdByDestination.set(destinationKey, account.id);
    }

    // ---- people -----------------------------------------------------------
    const selectedIncomeLines = plan.variants.flatMap((v) => v.lines).filter((l) => selected.has(l.key));
    const neededPeople = [...new Set(selectedIncomeLines.map((l) => l.personName))];
    const existingPeople = await tx.query.people.findMany({ where: (p, { isNull }) => isNull(p.archivedAt) });
    /** @type {Map<string, string>} */
    const personIdByName = new Map();
    for (const [index, name] of neededPeople.entries()) {
      const existing = findExisting(existingPeople, (p) => sameName(p.name, name));
      if (existing) {
        personIdByName.set(name, existing.id);
        continue;
      }
      const inserted = await tx.insert(peopleTable).values({ name, sortOrder: index }).returning();
      personIdByName.set(name, mustAt(inserted, 0, "created person").id);
    }

    // ---- income variants and lines ----------------------------------------
    const existingVariants = await tx.query.incomeVariants.findMany({ where: (v, { isNull }) => isNull(v.archivedAt) });
    /** @type {Map<string, string>} */
    const variantIdByKey = new Map();
    let incomeLineCount = 0;

    for (const [index, variant] of plan.variants.entries()) {
      const variantLines = variant.lines.filter((l) => selected.has(l.key));
      // A variant a plan points at still has to exist even if all its income
      // rows were deselected — otherwise the plan has nothing to divide.
      const neededByPlan = plan.plans.some(
        (p) =>
          p.lines.some((line) => selected.has(line.key)) &&
          (selection.planVariants[p.key] ?? p.variantKey) === variant.key,
      );
      if (variantLines.length === 0 && !neededByPlan) continue;

      const existing = findExisting(existingVariants, (v) => sameName(v.name, variant.name));
      let variantId;
      if (existing) {
        variantId = existing.id;
      } else {
        const inserted = await tx
          .insert(incomeVariants)
          .values({ name: variant.name, sortOrder: index })
          .returning();
        variantId = mustAt(inserted, 0, "created income variant").id;
      }
      variantIdByKey.set(variant.key, variantId);

      const storedLines = await tx.query.incomeLines.findMany({
        where: (l, { eq: eqCol }) => eqCol(l.variantId, variantId),
      });
      for (const [lineIndex, line] of variantLines.entries()) {
        const personId = personIdByName.get(line.personName);
        if (!personId) continue;
        // (variant, person, label) is the natural key. Label is nullable, so
        // it is compared through `?? ""` — SQL's null-is-not-null would make
        // an unlabelled line match nothing and duplicate on every re-import.
        const match = storedLines.find(
          (l) => l.personId === personId && (l.label ?? "") === (line.label ?? ""),
        );
        // A matched line takes the workbook's amount and cadence and nothing
        // else (REIMPORT_RULES) — its order and notes are the operator's.
        if (match) {
          await tx
            .update(incomeLines)
            .set({ amountCents: line.amountCents, cadence: line.cadence })
            .where(eq(incomeLines.id, match.id));
        } else {
          await tx.insert(incomeLines).values({
            variantId,
            personId,
            label: line.label,
            amountCents: line.amountCents,
            cadence: line.cadence,
            sortOrder: lineIndex,
          });
        }
        incomeLineCount += 1;
      }
    }

    // ---- fixed-cost categories and bills ----------------------------------
    const selectedBills = plan.bills.filter((b) => selected.has(b.key));
    const existingCategories = await tx.query.costCategories.findMany({ where: (c, { isNull }) => isNull(c.archivedAt) });
    /** @type {Map<string, string>} */
    const categoryIdByName = new Map();

    /**
     * @param {string} name
     * @param {"fixed" | "variable"} kind
     * @param {boolean} isEssential
     * @param {number} sortOrder
     */
    async function upsertCategory(name, kind, isEssential, sortOrder) {
      const cacheKey = `${kind}:${name.toLowerCase()}`;
      const cached = categoryIdByName.get(cacheKey);
      if (cached) return cached;
      const existing = findExisting(existingCategories, (c) => c.kind === kind && sameName(c.name, name));
      if (existing) {
        // Only a variable category's flag is the workbook's to say — its
        // Essentials/Non-Essentials grouping. A fixed-cost category's `true`
        // here is a default, not something the sheet states (REIMPORT_RULES).
        if (kind === "variable" && existing.isEssential !== isEssential) {
          await tx.update(costCategories).set({ isEssential }).where(eq(costCategories.id, existing.id));
        }
        categoryIdByName.set(cacheKey, existing.id);
        return existing.id;
      }
      const inserted = await tx
        .insert(costCategories)
        .values({ name, kind, isEssential, sortOrder })
        .returning();
      const created = mustAt(inserted, 0, "created cost category");
      existingCategories.push(created);
      categoryIdByName.set(cacheKey, created.id);
      return created.id;
    }

    let billCount = 0;
    let createdBillCount = 0;
    for (const [index, bill] of selectedBills.entries()) {
      const categoryId = await upsertCategory(
        bill.categoryName,
        "fixed",
        true,
        plan.fixedCategories.findIndex((c) => c.name === bill.categoryName),
      );
      const stored = await tx.query.bills.findMany({
        where: (b, { and, eq: eqCol, isNull }) => and(eqCol(b.categoryId, categoryId), isNull(b.archivedAt)),
      });
      const match = stored.find((b) => sameName(b.name, bill.name));
      if (match) {
        // A re-import updates a matched bill's AMOUNT AND FREQUENCY, and
        // nothing else (REIMPORT_RULES). Those two are what the workbook
        // actually says about a bill. Everything else on the row is the
        // operator's own work since the first import, and the workbook has no
        // column to restore any of it from: the due date (it holds none at
        // all), the amount model with its escalation, rolling window and
        // seasonal factors (resetting `amountModel` to "flat" here used to
        // wipe a seasonal or escalating setup without a word), step changes,
        // owner, paid-from account, notes, the order on the table, and
        // whether the due date has been confirmed.
        await tx
          .update(billsTable)
          .set({ baseAmountCents: bill.amountCents, frequency: bill.frequency })
          .where(eq(billsTable.id, match.id));
      } else {
        await tx.insert(billsTable).values({
          categoryId,
          name: bill.name,
          baseAmountCents: bill.amountCents,
          frequency: bill.frequency,
          amountModel: "flat",
          sortOrder: index,
          // The workbook has no due dates, so every bill it creates is dated
          // to the one day the operator picked — a placeholder, flagged as
          // one until it is set (tables/bills.js).
          anchorDate,
          dueDateConfirmed: false,
        });
        createdBillCount += 1;
      }
      billCount += 1;
    }

    // ---- variable categories and budgets ----------------------------------
    const selectedVariable = plan.variableCategories.filter((c) => selected.has(c.key));
    let budgetCount = 0;
    for (const [index, category] of selectedVariable.entries()) {
      const categoryId = await upsertCategory(category.name, "variable", category.isEssential, index);
      await tx
        .insert(variableBudgets)
        .values({
          categoryId,
          amountCents: category.monthlyCents,
          cadence: "monthly",
          effectiveFrom: anchorDate,
          note: "Imported from spreadsheet",
        })
        .onConflictDoUpdate({
          target: [variableBudgets.categoryId, variableBudgets.effectiveFrom],
          set: { amountCents: category.monthlyCents, cadence: "monthly" },
        });
      budgetCount += 1;
    }

    // ---- allocation plans, as drafts --------------------------------------
    const existingPlans = await tx.query.allocationPlans.findMany({ where: (p, { isNull }) => isNull(p.archivedAt) });
    /** @type {{ planKey: string, planId: string, versionId: string, versionNumber: number }[]} */
    const importedPlans = [];

    for (const sheetPlan of plan.plans) {
      const planLines = sheetPlan.lines.filter((line) => selected.has(line.key));
      if (planLines.length === 0) continue;

      const variantKey = selection.planVariants[sheetPlan.key] ?? sheetPlan.variantKey;
      const incomeVariantId = variantKey ? variantIdByKey.get(variantKey) : undefined;
      if (!incomeVariantId) {
        throw new ImportSelectionError(`"${sheetPlan.name}" has no income variant to divide.`);
      }

      const existing = findExisting(existingPlans, (p) => sameName(p.name, sheetPlan.name));
      let planId;
      if (existing) {
        planId = existing.id;
        if (existing.incomeVariantId !== incomeVariantId) {
          await tx.update(allocationPlans).set({ incomeVariantId }).where(eq(allocationPlans.id, planId));
        }
      } else {
        const inserted = await tx
          .insert(allocationPlans)
          .values({ name: sheetPlan.name, incomeVariantId })
          .returning();
        planId = mustAt(inserted, 0, "created allocation plan").id;
      }

      // Reuse the plan's open draft if it has one — the unique index allows
      // exactly one, and two people share a draft rather than forking it.
      const draft = await tx.query.allocationVersions.findFirst({
        where: (v, { and: andCol, eq: eqCol }) => andCol(eqCol(v.planId, planId), eqCol(v.status, "draft")),
      });
      const newest = await tx.query.allocationVersions.findFirst({
        where: (v, { eq: eqCol }) => eqCol(v.planId, planId),
        orderBy: (v, { desc }) => [desc(v.version)],
      });

      let versionId;
      let versionNumber;
      if (draft) {
        versionId = draft.id;
        versionNumber = draft.version;
        await tx.delete(allocationLines).where(eq(allocationLines.versionId, versionId));
        await tx
          .update(allocationVersions)
          .set({ note: `Imported from ${plan.fileName}` })
          .where(eq(allocationVersions.id, versionId));
      } else {
        const inserted = await tx
          .insert(allocationVersions)
          .values({
            planId,
            version: (newest?.version ?? 0) + 1,
            status: "draft",
            note: `Imported from ${plan.fileName}`,
            createdBy: actorId,
          })
          .returning();
        const created = mustAt(inserted, 0, "created draft version");
        versionId = created.id;
        versionNumber = created.version;
      }

      await tx.insert(allocationLines).values(
        planLines.map((line, index) => ({
          versionId,
          stage: line.stage,
          label: line.label,
          basis: /** @type {AllocationLine["basis"]} */ (line.basis),
          // The two injected bases take their amount from the fixed-cost and
          // variable-essentials totals; storing a value would be storing a
          // number that does nothing.
          value: line.basis === "from_fixed_costs" || line.basis === "from_variable_essentials" ? null : line.value,
          goalPct: line.goalPct,
          accountId: mustGetDestination(accountIdByDestination, line.destinationKey),
          sortOrder: index,
        })),
      );

      importedPlans.push({ planKey: sheetPlan.key, planId, versionId, versionNumber });
    }

    // ---- balances and growth rates ----------------------------------------
    const selectedBalances = plan.balances.filter((b) => selected.has(b.key));
    let balanceCount = 0;
    for (const balance of selectedBalances) {
      const accountId = accountIdByDestination.get(balance.destinationKey);
      if (!accountId) continue;
      await tx
        .insert(balanceSnapshots)
        .values({
          accountId,
          asAt: anchorDate,
          amountCents: balance.amountCents,
          note: "Imported from spreadsheet",
        })
        .onConflictDoUpdate({
          target: [balanceSnapshots.accountId, balanceSnapshots.asAt],
          set: { amountCents: balance.amountCents, note: "Imported from spreadsheet" },
        });
      if (balance.annualGrowthRate !== null) {
        const account = findExisting(existingAccounts, (a) => a.id === accountId);
        // An external account holds no balance and no growth assumption
        // (phases/04-accounts-people.md) — skip the rate rather than write a
        // row the accounts API would reject.
        if (account && account.type !== "external") {
          await tx
            .update(accountsTable)
            .set({ annualGrowthRate: balance.annualGrowthRate })
            .where(eq(accountsTable.id, accountId));
        }
      }
      balanceCount += 1;
    }

    return {
      counts: {
        people: personIdByName.size,
        variants: variantIdByKey.size,
        incomeLines: incomeLineCount,
        bills: billCount,
        variableBudgets: budgetCount,
        plans: importedPlans.length,
        balances: balanceCount,
        accountsCreated: createdAccountNames.length,
      },
      createdAccountNames,
      // Kept out of `counts`, which the summary screen renders entry by entry:
      // this one is for the next-steps text, not a figure of its own.
      createdBillCount,
      importedPlans,
      accountIdByDestination: Object.fromEntries(accountIdByDestination),
      variantIdByKey: Object.fromEntries(variantIdByKey),
    };
  });
}

/**
 * @typedef {{
 *   field: "amount" | "frequency" | "cadence" | "isEssential" | "budget" | "budgetCadence" | "incomeVariant" | "draft",
 *   from: string | number | boolean | null,
 *   to: string | number | boolean | null,
 * }} ReimportChange
 *
 * `amount` and `budget` are cents; `frequency`, `cadence` and `budgetCadence`
 * are cadence values; `incomeVariant` is a variant name; `draft` is the
 * replaced draft's version number (`to` is null).
 */

/**
 * @typedef {{
 *   rowKeys: string[],
 *   kind: "bill" | "income_line" | "variable_category" | "plan",
 *   name: string,
 *   changes: ReimportChange[],
 *   message: string,
 * }} ReimportOverwrite
 *
 * `rowKeys` — the preview rows whose selection causes this overwrite (a
 * plan's are its lines), so the screen can drop it when they are deselected.
 */

/** @param {Cents} cents */
const plainMoney = (cents) => (cents / 100).toFixed(2);

/** @param {string} cadence */
const cadenceWords = (cadence) => cadence.replace(/_/g, " ");

/**
 * What importing this workbook would OVERWRITE, row by row, measured against
 * the live database before anything is written — so the preview can say
 * plainly what a re-import changes rather than leaving the operator to find
 * out afterwards.
 *
 * It matches exactly as `applyImport` does (live rows, `sameName`) and
 * compares exactly the fields `applyImport` writes on a match
 * (REIMPORT_RULES), listing each matched row whose stored value would change.
 * A row that would be created is not an overwrite and is not listed. Balances
 * are not listed either: which account a Projections row lands on is not
 * known until its destination is mapped, so the rules say what happens to
 * them instead.
 *
 * @param {import("@budget/schema").Db} db
 * @param {ImportPlan} plan
 */
export async function describeReimport(db, plan) {
  const [people, variants, lines, categories, budgets, bills, plans, drafts] = await Promise.all([
    db.query.people.findMany({ where: (p, { isNull }) => isNull(p.archivedAt) }),
    // Every variant, for naming the one a plan divides today even if it has
    // since been archived; matching below still only considers live ones.
    db.query.incomeVariants.findMany({}),
    db.query.incomeLines.findMany({}),
    db.query.costCategories.findMany({ where: (c, { isNull }) => isNull(c.archivedAt) }),
    db.query.variableBudgets.findMany({ orderBy: (b, { desc }) => [desc(b.effectiveFrom)] }),
    db.query.bills.findMany({ where: (b, { isNull }) => isNull(b.archivedAt) }),
    db.query.allocationPlans.findMany({ where: (p, { isNull }) => isNull(p.archivedAt) }),
    db.query.allocationVersions.findMany({ where: (v, { eq: eqCol }) => eqCol(v.status, "draft") }),
  ]);
  const liveVariants = variants.filter((v) => v.archivedAt === null);

  /** @type {ReimportOverwrite[]} */
  const overwrites = [];
  let matchedCount = 0;

  /**
   * @param {Omit<ReimportOverwrite, "message">} entry
   * @param {string[]} parts
   */
  function record(entry, parts) {
    matchedCount += 1;
    if (entry.changes.length > 0) overwrites.push({ ...entry, message: `${entry.name}: ${parts.join("; ")}.` });
  }

  for (const bill of plan.bills) {
    const category = categories.find((c) => c.kind === "fixed" && sameName(c.name, bill.categoryName));
    const match = category ? bills.find((b) => b.categoryId === category.id && sameName(b.name, bill.name)) : undefined;
    if (!match) continue;
    /** @type {ReimportChange[]} */
    const changes = [];
    /** @type {string[]} */
    const parts = [];
    if (match.baseAmountCents !== bill.amountCents) {
      changes.push({ field: "amount", from: match.baseAmountCents, to: bill.amountCents });
      parts.push(`amount ${plainMoney(match.baseAmountCents)} → ${plainMoney(bill.amountCents)}`);
    }
    if (match.frequency !== bill.frequency) {
      changes.push({ field: "frequency", from: match.frequency, to: bill.frequency });
      parts.push(`${cadenceWords(match.frequency)} → ${cadenceWords(bill.frequency)}`);
    }
    record({ rowKeys: [bill.key], kind: "bill", name: `${bill.name} (${bill.categoryName})`, changes }, parts);
  }

  for (const variant of plan.variants) {
    const liveVariant = liveVariants.find((v) => sameName(v.name, variant.name));
    if (!liveVariant) continue;
    for (const line of variant.lines) {
      const person = people.find((p) => sameName(p.name, line.personName));
      const match = person
        ? lines.find(
            (l) => l.variantId === liveVariant.id && l.personId === person.id && (l.label ?? "") === (line.label ?? ""),
          )
        : undefined;
      if (!match) continue;
      /** @type {ReimportChange[]} */
      const changes = [];
      /** @type {string[]} */
      const parts = [];
      if (match.amountCents !== line.amountCents) {
        changes.push({ field: "amount", from: match.amountCents, to: line.amountCents });
        parts.push(`amount ${plainMoney(match.amountCents)} → ${plainMoney(line.amountCents)}`);
      }
      if (match.cadence !== line.cadence) {
        changes.push({ field: "cadence", from: match.cadence, to: line.cadence });
        parts.push(`${cadenceWords(match.cadence)} → ${cadenceWords(line.cadence)}`);
      }
      const who = line.label ? `${line.personName} (${line.label})` : line.personName;
      record({ rowKeys: [line.key], kind: "income_line", name: `${who} in ${variant.name}`, changes }, parts);
    }
  }

  for (const category of plan.variableCategories) {
    const match = categories.find((c) => c.kind === "variable" && sameName(c.name, category.name));
    if (!match) continue;
    /** @type {ReimportChange[]} */
    const changes = [];
    /** @type {string[]} */
    const parts = [];
    if (match.isEssential !== category.isEssential) {
      changes.push({ field: "isEssential", from: match.isEssential, to: category.isEssential });
      parts.push(category.isEssential ? "becomes essential" : "stops being essential");
    }
    // Newest first, so this is the budget the operator most recently set.
    const latest = budgets.find((b) => b.categoryId === match.id) ?? null;
    if (latest && (latest.amountCents !== category.monthlyCents || latest.cadence !== "monthly")) {
      changes.push({ field: "budget", from: latest.amountCents, to: category.monthlyCents });
      if (latest.cadence !== "monthly") changes.push({ field: "budgetCadence", from: latest.cadence, to: "monthly" });
      parts.push(
        `budget ${plainMoney(latest.amountCents)} ${cadenceWords(latest.cadence)} → ${plainMoney(category.monthlyCents)} monthly from the import date`,
      );
    }
    record({ rowKeys: [category.key], kind: "variable_category", name: category.name, changes }, parts);
  }

  for (const sheetPlan of plan.plans) {
    const match = plans.find((p) => sameName(p.name, sheetPlan.name));
    if (!match) continue;
    /** @type {ReimportChange[]} */
    const changes = [];
    /** @type {string[]} */
    const parts = [];
    // Only when the workbook says unambiguously which variant the sheet
    // divides; an ambiguous one is the operator's pick on the next screen.
    const sheetVariant = sheetPlan.variantAmbiguous
      ? null
      : (plan.variants.find((v) => v.key === sheetPlan.variantKey) ?? null);
    const currentVariantName = variants.find((v) => v.id === match.incomeVariantId)?.name ?? null;
    if (sheetVariant && (currentVariantName === null || !sameName(currentVariantName, sheetVariant.name))) {
      changes.push({ field: "incomeVariant", from: currentVariantName, to: sheetVariant.name });
      parts.push(`divides ${sheetVariant.name} instead of ${currentVariantName ?? "an unknown variant"}`);
    }
    const draft = drafts.find((d) => d.planId === match.id);
    if (draft) {
      changes.push({ field: "draft", from: draft.version, to: null });
      parts.push(`its open draft (v${draft.version}) is replaced by the workbook's lines, losing any unapplied edits in it`);
    }
    record(
      { rowKeys: sheetPlan.lines.map((line) => line.key), kind: "plan", name: `${sheetPlan.name} plan`, changes },
      parts,
    );
  }

  return {
    // Nothing matched means this is a first import, and the screen can leave
    // the whole section out.
    matchedCount,
    overwrites,
    rules: REIMPORT_RULES,
  };
}

/**
 * @param {Map<string, string>} map
 * @param {string | null} key
 */
function mustGetDestination(map, key) {
  const id = key === null ? undefined : map.get(key);
  if (!id) throw new ImportSelectionError("A transfer destination has no account mapped.");
  return id;
}

/**
 * The reconciliation the operator reads immediately after an import: the
 * spreadsheet's own figure beside what the app now computes, for every total
 * worth checking. Mismatches are DISPLAYED, not hidden — several of them are
 * expected (the workbook's own subtotal bug), and the ones that are not are
 * the whole reason this exists (phases/11-polish-mobile-import.md, workstream
 * C "Post-import verification").
 *
 * Computed from the parsed plan and the selection rather than re-read from
 * the database, so it says what THIS import did rather than what the database
 * happens to contain.
 *
 * Every per-pay figure is stated in the WORKBOOK's own cadence when it says
 * what that is ("Total (Fortnightly)"): its per-pay totals are in that
 * cadence, and converting the app's side to anything else made every variant
 * read "differs" — always, before a pay schedule existed, when the fallback
 * was monthly. The household's primary schedule is the next choice and
 * monthly the last; `cadence.source` says which was used.
 *
 * @param {{
 *   plan: ImportPlan,
 *   selection: ImportSelection,
 *   accountIdByDestination: Record<string, string>,
 *   accountNameById: Record<string, string>,
 *   incomeLandingAccountId: string | null,
 *   householdPayCadence: Cadence | null,
 * }} args
 */
export function reconcileImport({
  plan,
  selection,
  accountIdByDestination,
  accountNameById,
  incomeLandingAccountId,
  householdPayCadence,
}) {
  const selected = new Set(selection.selected);

  /** @type {{ payCadence: Cadence, source: "workbook" | "pay_schedule" | "fallback" }} */
  const cadence = plan.payCadence
    ? { payCadence: plan.payCadence, source: "workbook" }
    : householdPayCadence
      ? { payCadence: householdPayCadence, source: "pay_schedule" }
      : { payCadence: "monthly", source: "fallback" };
  const payCadence = cadence.payCadence;

  /** @param {string} accountId */
  const nameOf = (accountId) => accountNameById[accountId] ?? null;

  const selectedBills = plan.bills.filter((b) => selected.has(b.key));
  const fixedPerYearCents = selectedBills.reduce((sum, b) => sum + b.perYearCents, 0);
  const fixedPerMonthCents = selectedBills.reduce(
    (sum, b) => sum + equivalent(b.amountCents, b.frequency, "monthly"),
    0,
  );

  const selectedVariable = plan.variableCategories.filter((c) => selected.has(c.key));
  const essentialsPerMonthCents = selectedVariable
    .filter((c) => c.isEssential)
    .reduce((sum, c) => sum + c.monthlyCents, 0);
  const nonEssentialPerMonthCents = selectedVariable
    .filter((c) => !c.isEssential)
    .reduce((sum, c) => sum + c.monthlyCents, 0);

  // Why the app's fixed total legitimately differs from the workbook's.
  /** @type {string[]} */
  const fixedNotes = [];
  const excluded = plan.bills.filter((b) => !selected.has(b.key));
  for (const bill of excluded) {
    fixedNotes.push(
      `"${bill.name}" (${bill.categoryName}, row ${bill.sourceRow}) was not imported: −${(bill.perYearCents / 100).toFixed(2)} a year.`,
    );
  }
  for (const flag of plan.flags) {
    if (flag.id.startsWith("subtotal-mismatch:")) fixedNotes.push(flag.detail);
  }

  const variants = plan.variants.map((variant) => {
    const lines = variant.lines.filter((l) => selected.has(l.key));
    const importedPerPayCents = lines.reduce(
      (sum, l) => sum + equivalent(l.amountCents, l.cadence, payCadence),
      0,
    );
    return {
      name: variant.name,
      spreadsheetPerPayCents: variant.spreadsheetTotalPerPayCents,
      importedPerPayCents,
      lineCount: lines.length,
    };
  });

  const plans = plan.plans.flatMap((sheetPlan) => {
    const lines = sheetPlan.lines.filter((l) => selected.has(l.key));
    if (lines.length === 0) return [];

    const variantKey = selection.planVariants[sheetPlan.key] ?? sheetPlan.variantKey;
    const variant = plan.variants.find((v) => v.key === variantKey) ?? null;
    const variantLines = variant?.lines.filter((l) => selected.has(l.key)) ?? [];
    const grossPerPayCents = variantLines.reduce(
      (sum, l) => sum + equivalent(l.amountCents, l.cadence, payCadence),
      0,
    );
    const grossPerMonthCents = equivalent(grossPerPayCents, payCadence, "monthly");

    /** @type {AllocationLine[]} */
    const engineLines = lines.map((line) => ({
      id: line.key,
      stage: line.stage,
      // The workbook's own Subtotal/Remaining rows are what the stages come
      // from, and stages 1/2/3 are the three named sections — so an import
      // lands in Bills & Essentials, Save Invest & Give and Leftover with no
      // heading to invent (`ALLOCATION_SECTIONS` in packages/engine).
      label: line.label,
      basis: /** @type {AllocationLine["basis"]} */ (line.basis),
      value: line.basis === "from_fixed_costs" || line.basis === "from_variable_essentials" ? null : line.value,
      goalPct: line.goalPct,
      accountId: (line.destinationKey && accountIdByDestination[line.destinationKey]) || line.destination,
    }));

    const result = computeAllocation({
      grossPerMonthCents,
      payCadence,
      fixedTotalPerMonthCents: fixedPerMonthCents,
      variableEssentialsPerMonthCents: essentialsPerMonthCents,
      variableNonEssentialPerMonthCents: nonEssentialPerMonthCents,
      // The engine marks a transfer as a no-op by matching its destination
      // against this id. An empty string matches no account — which is the
      // honest answer when nothing is flagged as income landing yet: every
      // transfer really is a move until the operator says which one is not.
      // Not a cast, because a cast here would let a genuinely wrong id
      // through silently.
      incomeLandingAccountId: incomeLandingAccountId ?? "",
      lines: engineLines,
    });

    const importedTotalPerPayCents = result.transfers.reduce((sum, t) => sum + t.perPayCents, 0);
    const destinationByLineKey = new Map(lines.map((line) => [line.key, line.destination]));

    return [
      {
        name: sheetPlan.name,
        sheet: sheetPlan.sheet,
        variantName: variant?.name ?? null,
        grossPerPayCents,
        spreadsheetGrossPerPayCents: sheetPlan.spreadsheetGrossPerPayCents,
        // The workbook's own transfer list, each label resolved to the account
        // its destination was mapped to where one was — so the two columns
        // can be read across, account by account.
        spreadsheetTransfers: sheetPlan.spreadsheetTransfers.map((t) => {
          const accountId = accountIdByDestination[`dest:${normaliseDestination(t.label)}`] ?? null;
          return { ...t, accountId, accountName: accountId === null ? null : nameOf(accountId) };
        }),
        spreadsheetTransferTotalCents: sheetPlan.spreadsheetTransferTotalCents,
        importedTransfers: result.transfers.map((t) => ({
          accountId: t.accountId,
          // The mapped account's real name, so no row ever has to be labelled
          // "New account" for want of one.
          accountName: nameOf(t.accountId),
          // Every destination the workbook wrote for the lines that land here,
          // in its own words ("to ubank (House)").
          destinations: [
            ...new Set(
              t.lineIds.flatMap((id) => {
                const raw = destinationByLineKey.get(id);
                return raw ? [raw] : [];
              }),
            ),
          ],
          perPayCents: t.perPayCents,
          isNoOp: t.isNoOp,
        })),
        importedTotalPerPayCents,
        // The engine guarantees this; asserting it here is how a mapping
        // mistake that silently dropped a line would show up.
        reconciles: importedTotalPerPayCents === grossPerPayCents,
        unallocatedPerMonthCents: result.unallocatedPerMonthCents,
      },
    ];
  });

  return {
    cadence,
    fixedCosts: {
      spreadsheetPerYearCents: plan.spreadsheet.fixedTotalPerYearCents,
      importedPerYearCents: fixedPerYearCents,
      importedPerMonthCents: fixedPerMonthCents,
      billCount: selectedBills.length,
      notes: fixedNotes,
    },
    variableEssentials: {
      spreadsheetPerMonthCents: plan.spreadsheet.variableEssentialsPerMonthCents,
      importedPerMonthCents: essentialsPerMonthCents,
    },
    variableNonEssential: {
      spreadsheetPerMonthCents:
        plan.spreadsheet.variableTotalPerMonthCents !== null && plan.spreadsheet.variableEssentialsPerMonthCents !== null
          ? plan.spreadsheet.variableTotalPerMonthCents - plan.spreadsheet.variableEssentialsPerMonthCents
          : null,
      importedPerMonthCents: nonEssentialPerMonthCents,
    },
    variants,
    plans,
  };
}

/**
 * What the operator still has to do by hand, worded for the moment straight
 * after an import. Every one of these is a decision the app refuses to make
 * on its own.
 *
 * This is the import's own account of itself, not the to-do list: that is
 * the dashboard's setup checklist (`loadSetup`), derived from the database so
 * it survives the operator leaving this page. The commit response carries it
 * too, and the last line here says where it lives.
 *
 * @param {{ importedPlans: { versionNumber: number }[], incomeLandingAccountId: string | null, hasPrimaryPaySchedule: boolean, createdAccountNames: string[], createdBillCount: number, anchorDate: string }} args
 */
export function importNextSteps({
  importedPlans,
  incomeLandingAccountId,
  hasPrimaryPaySchedule,
  createdAccountNames,
  createdBillCount,
  anchorDate,
}) {
  /** @type {string[]} */
  const steps = [];
  if (importedPlans.length > 0) {
    steps.push(
      `${importedPlans.length} allocation plan${importedPlans.length === 1 ? "" : "s"} imported as a DRAFT. ` +
        "Nothing is active until you apply it on Allocation — the app never sets your standing orders for you.",
    );
  }
  if (!incomeLandingAccountId) {
    steps.push(
      "No account is flagged as income landing. Mark the one your salary lands in on Accounts, or the allocation " +
        "cannot tell a real transfer from money that stays put.",
    );
  }
  if (!hasPrimaryPaySchedule) {
    steps.push(
      "No primary pay schedule is set. Add one under Pay schedules on Income so transfers can be stated per pay " +
        "rather than per month.",
    );
  }
  if (createdAccountNames.length > 0) {
    steps.push(
      `Created ${createdAccountNames.length} account${createdAccountNames.length === 1 ? "" : "s"}: ` +
        `${createdAccountNames.join(", ")}. Set each one's type and growth rate on Accounts.`,
    );
  }
  if (createdBillCount > 0) {
    steps.push(
      `${createdBillCount} new bill${createdBillCount === 1 ? " is" : "s are"} dated ${anchorDate} — a placeholder, ` +
        "because the workbook has no due dates. Set each real due date on Fixed Costs; until then the calendar and " +
        "the bills buffer are working from the placeholder. Bills that already existed kept their dates.",
    );
  }
  steps.push(
    "You don't need to remember any of this: the dashboard's setup checklist keeps the list, and each item ticks " +
      "itself off once it's done.",
  );
  return steps;
}
