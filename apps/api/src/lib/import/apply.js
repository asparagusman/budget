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

/** @import { AllocationLine, Cadence } from "@budget/engine" */
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
    const existingAccounts = await tx.query.accounts.findMany({});
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
      const byName = findExisting(existingAccounts, (a) => a.name.toLowerCase() === choice.create.name.toLowerCase());
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
    const existingPeople = await tx.query.people.findMany({});
    /** @type {Map<string, string>} */
    const personIdByName = new Map();
    for (const [index, name] of neededPeople.entries()) {
      const existing = findExisting(existingPeople, (p) => p.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        personIdByName.set(name, existing.id);
        continue;
      }
      const inserted = await tx.insert(peopleTable).values({ name, sortOrder: index }).returning();
      personIdByName.set(name, mustAt(inserted, 0, "created person").id);
    }

    // ---- income variants and lines ----------------------------------------
    const existingVariants = await tx.query.incomeVariants.findMany({});
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

      const existing = findExisting(existingVariants, (v) => v.name.toLowerCase() === variant.name.toLowerCase());
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
        const values = {
          variantId,
          personId,
          label: line.label,
          amountCents: line.amountCents,
          cadence: line.cadence,
          sortOrder: lineIndex,
        };
        if (match) await tx.update(incomeLines).set(values).where(eq(incomeLines.id, match.id));
        else await tx.insert(incomeLines).values(values);
        incomeLineCount += 1;
      }
    }

    // ---- fixed-cost categories and bills ----------------------------------
    const selectedBills = plan.bills.filter((b) => selected.has(b.key));
    const existingCategories = await tx.query.costCategories.findMany({});
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
      const existing = findExisting(
        existingCategories,
        (c) => c.kind === kind && c.name.toLowerCase() === name.toLowerCase(),
      );
      if (existing) {
        if (existing.isEssential !== isEssential) {
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
    for (const [index, bill] of selectedBills.entries()) {
      const categoryId = await upsertCategory(
        bill.categoryName,
        "fixed",
        true,
        plan.fixedCategories.findIndex((c) => c.name === bill.categoryName),
      );
      const stored = await tx.query.bills.findMany({
        where: (b, { eq: eqCol }) => eqCol(b.categoryId, categoryId),
      });
      const match = stored.find((b) => b.name.toLowerCase() === bill.name.toLowerCase());
      const values = {
        categoryId,
        name: bill.name,
        baseAmountCents: bill.amountCents,
        frequency: bill.frequency,
        amountModel: /** @type {const} */ ("flat"),
        sortOrder: index,
      };
      if (match) {
        // anchorDate is deliberately NOT overwritten on a re-import: the
        // operator may have set a real due date since, and the workbook has
        // no due dates to restore it from.
        await tx.update(billsTable).set(values).where(eq(billsTable.id, match.id));
      } else {
        await tx.insert(billsTable).values({ ...values, anchorDate });
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
    const existingPlans = await tx.query.allocationPlans.findMany({});
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

      const existing = findExisting(existingPlans, (p) => p.name.toLowerCase() === sheetPlan.name.toLowerCase());
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
      importedPlans,
      accountIdByDestination: Object.fromEntries(accountIdByDestination),
      variantIdByKey: Object.fromEntries(variantIdByKey),
    };
  });
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
 * @param {{ plan: ImportPlan, selection: ImportSelection, accountIdByDestination: Record<string, string>, incomeLandingAccountId: string | null, payCadence: Cadence }} args
 */
export function reconcileImport({ plan, selection, accountIdByDestination, incomeLandingAccountId, payCadence }) {
  const selected = new Set(selection.selected);

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

    return [
      {
        name: sheetPlan.name,
        sheet: sheetPlan.sheet,
        variantName: variant?.name ?? null,
        grossPerPayCents,
        spreadsheetGrossPerPayCents: sheetPlan.spreadsheetGrossPerPayCents,
        spreadsheetTransfers: sheetPlan.spreadsheetTransfers,
        spreadsheetTransferTotalCents: sheetPlan.spreadsheetTransferTotalCents,
        importedTransfers: result.transfers.map((t) => ({
          accountId: t.accountId,
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
 * What the operator still has to do by hand. Every one of these is a decision
 * the app refuses to make on its own.
 *
 * @param {{ importedPlans: { versionNumber: number }[], incomeLandingAccountId: string | null, hasPrimaryPaySchedule: boolean, createdAccountNames: string[] }} args
 */
export function importNextSteps({ importedPlans, incomeLandingAccountId, hasPrimaryPaySchedule, createdAccountNames }) {
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
      "No primary pay schedule is set. Add one on Settings → Pay schedules so transfers can be stated per pay " +
        "rather than per month.",
    );
  }
  if (createdAccountNames.length > 0) {
    steps.push(
      `Created ${createdAccountNames.length} account${createdAccountNames.length === 1 ? "" : "s"}: ` +
        `${createdAccountNames.join(", ")}. Set each one's type and growth rate on Accounts.`,
    );
  }
  steps.push(
    "Every imported bill is anchored to the import date. Set real due dates on Fixed Costs so the calendar and the " +
      "bills buffer are right.",
  );
  return steps;
}
