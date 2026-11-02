import { houseSettingsSchema } from "@budget/schema";
import { loadAllocationContext, resolveActiveAllocation, variantGrossPerMonthCents, linesForVersion } from "./allocation.js";
import { computeContribution, projectActiveBills } from "./bills.js";
import { balanceAsOf } from "./goals.js";

/** @import { IsoDate } from "@budget/engine" */
/** @import { HouseSettings } from "@budget/schema" */

// The house page REPORTS, the same boundary goals live inside: every figure
// below is read from the phases that own it — the variant's own totals, the
// allocation's own fixed-cost method, the variable-cost summary — and nothing
// here writes an allocation, a balance or a budget.

export const HOUSE_SETTINGS_KEY = "house";

/** @type {HouseSettings} */
const HOUSE_SETTINGS_DEFAULTS = houseSettingsSchema.parse({});

/**
 * The stored settings, or the defaults when none have been saved. A stored
 * value that no longer parses (a schema change since it was written) falls
 * back to the defaults with a warning rather than failing the page.
 *
 * @param {import("@budget/schema").Db} db
 */
export async function readHouseSettings(db) {
  const row = await db.query.settings.findFirst({
    where: (s, { eq: eqCol }) => eqCol(s.key, HOUSE_SETTINGS_KEY),
  });
  if (!row) return { settings: HOUSE_SETTINGS_DEFAULTS, invalid: false };
  const parsed = houseSettingsSchema.safeParse(row.value);
  return parsed.success
    ? { settings: parsed.data, invalid: false }
    : { settings: HOUSE_SETTINGS_DEFAULTS, invalid: true };
}

/**
 * Help to Buy sizes the government's share from the lender's borrowing limit,
 * so a Help to Buy scenario without one can't be computed. A semantic rule,
 * checked against the merged row on update — the same split as goals'
 * `targetModeFieldError`.
 *
 * @param {{ scheme: string, lenderLimitCents: number | null | undefined }} data
 */
export function lenderLimitFieldError(data) {
  if (data.scheme === "help_to_buy" && (data.lenderLimitCents == null || data.lenderLimitCents <= 0)) {
    return "Help to Buy needs your lender's borrowing limit — the government's share is sized from it.";
  }
  return null;
}

/**
 * Everything `GET /house` returns: the stored settings, the live budget they
 * select, the choices the settings sheet offers, and every scenario.
 *
 * `live` is the budget after buying. Income is the chosen variant's own
 * after-tax total; bills are the allocation's fixed-cost figure with the
 * stopping categories' bills left out of the same `computeContribution`
 * call; essentials and Good Life are the variable-cost summary's two totals.
 * Lines that carry on are the chosen variant's plan's Save, Invest & Give
 * lines paid into a kept account.
 *
 * @param {import("@budget/schema").Db} db
 * @param {{ on: IsoDate }} options
 */
export async function loadHouse(db, { on }) {
  const { settings, invalid } = await readHouseSettings(db);
  /** @type {{ code: string, message: string }[]} */
  const warnings = [];
  if (invalid) {
    warnings.push({
      code: "invalid_house_settings",
      message: "The saved house settings couldn't be read, so defaults are shown. Open the settings and save them again.",
    });
  }

  const context = await loadAllocationContext(db, on);
  const [todayAllocation, projected, variants, categories, people, accounts, plans, scenarios] = await Promise.all([
    resolveActiveAllocation(db, context),
    projectActiveBills(db, context.window),
    db.query.incomeVariants.findMany({
      where: (v, { isNull: isNullCol }) => isNullCol(v.archivedAt),
      orderBy: (v, { asc }) => [asc(v.sortOrder), asc(v.name)],
    }),
    db.query.costCategories.findMany({
      where: (cc, { and: andCol, eq: eqCol, isNull: isNullCol }) =>
        andCol(eqCol(cc.kind, "fixed"), isNullCol(cc.archivedAt)),
      orderBy: (cc, { asc }) => [asc(cc.sortOrder), asc(cc.name)],
    }),
    db.query.people.findMany({
      where: (p, { isNull: isNullCol }) => isNullCol(p.archivedAt),
      orderBy: (p, { asc }) => [asc(p.sortOrder), asc(p.name)],
    }),
    db.query.accounts.findMany({ where: (a, { isNull: isNullCol }) => isNullCol(a.archivedAt) }),
    db.query.allocationPlans.findMany({ where: (p, { isNull: isNullCol }) => isNullCol(p.archivedAt) }),
    db.query.houseScenarios.findMany({
      orderBy: (s, { asc }) => [asc(s.sortOrder), asc(s.createdAt)],
    }),
  ]);
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  // --- Income: the variant the household expects once it has bought.
  const variantTotals = await Promise.all(
    variants.map(async (v) => ({ id: v.id, name: v.name, perMonthCents: await variantGrossPerMonthCents(db, v.id) })),
  );
  const variant = variantTotals.find((v) => v.id === settings.incomeVariantId) ?? null;
  if (!variant) {
    warnings.push({
      code: "no_income_variant",
      message: "Choose the income you expect after buying in the settings — until then income reads as $0.",
    });
  }
  const incomePerMonthCents = variant?.perMonthCents ?? 0;

  // --- Bills: the allocation's own method, minus the categories that stop.
  const stopping = new Set(settings.stopCategoryIds);
  const categoryByBill = new Map(projected.bills.map((b) => [b.id, b.categoryId]));
  const instancesWhere = (/** @type {(categoryId: string) => boolean} */ keep) =>
    [...projected.instancesByBill].flatMap(([billId, instances]) =>
      keep(categoryByBill.get(billId) ?? "") ? instances : [],
    );
  const billsNowPerMonthCents = context.fixedTotalPerMonthCents;
  const billsAfterPerMonthCents = computeContribution(
    instancesWhere((categoryId) => !stopping.has(categoryId)),
    context.window,
    context.paySchedule,
  ).perMonthCents;
  const fixedCategories = categories.map((category) => ({
    id: category.id,
    name: category.name,
    perMonthCents: computeContribution(
      instancesWhere((categoryId) => categoryId === category.id),
      context.window,
      context.paySchedule,
    ).perMonthCents,
    stops: stopping.has(category.id),
  }));

  // --- Lines that carry on: the chosen variant's plan, active version.
  const plan = variant ? plans.find((p) => p.incomeVariantId === variant.id) ?? null : null;
  const activeVersion = plan
    ? await db.query.allocationVersions.findFirst({
        where: (v, { and: andCol, eq: eqCol }) => andCol(eqCol(v.planId, plan.id), eqCol(v.status, "active")),
      })
    : null;
  if (variant && !activeVersion) {
    warnings.push({
      code: "no_plan_for_variant",
      message: `No active allocation plan divides "${variant.name}", so no giving or savings are carried into the budget after buying.`,
    });
  }
  const keep = new Set(settings.keepAccountIds);
  const lineRows = activeVersion ? await linesForVersion(db, activeVersion.id) : [];
  // Save, Invest & Give only: Bills & Essentials are already counted above,
  // and Leftover is what the house budget is working out.
  const lines = lineRows
    .filter((row) => row.stage === 2)
    .map((row) => {
      const pct = row.basis === "pct_of_gross" ? row.value ?? 0 : null;
      return {
        id: row.id,
        label: row.label,
        accountId: row.accountId,
        accountName: accountById.get(row.accountId)?.name ?? "",
        basis: row.basis,
        pct,
        perMonthCents:
          pct !== null
            ? Math.round((incomePerMonthCents * pct) / 100)
            : row.basis === "fixed_amount"
              ? Math.round(row.value ?? 0)
              : 0,
        kept: keep.has(row.accountId),
      };
    });
  if (lines.some((l) => l.kept && l.pct === null && l.basis !== "fixed_amount")) {
    warnings.push({
      code: "unsupported_kept_line",
      message: "A line that carries on is a sweep or share of what's left, which the house budget can't price. It's counted as $0.",
    });
  }

  // --- Cash: balances today, plus what today's allocation sends each month.
  const transferByAccount = new Map((todayAllocation.result?.transfers ?? []).map((t) => [t.accountId, t]));
  const counted = new Set(settings.cashAccountIds);
  const cashAccounts = await Promise.all(
    accounts
      .filter((a) => a.type === "savings" || a.type === "investment")
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map(async (account) => {
        const balance = await balanceAsOf(db, account.id, on);
        return {
          id: account.id,
          name: account.name,
          balanceCents: balance?.amountCents ?? 0,
          asAt: balance?.asAt ?? null,
          contributionPerMonthCents: transferByAccount.get(account.id)?.perMonthCents ?? 0,
          annualGrowthRate: account.annualGrowthRate ?? 0,
          counted: counted.has(account.id),
        };
      }),
  );
  if (todayAllocation.warning && cashAccounts.some((a) => a.counted)) {
    warnings.push({
      code: todayAllocation.warning.code,
      message: `Cash is projected from balances alone: ${todayAllocation.warning.message}`,
    });
  }

  return {
    on,
    settings,
    live: {
      variant,
      plan: plan && activeVersion ? { id: plan.id, name: plan.name } : null,
      incomePerMonthCents,
      billsNowPerMonthCents,
      billsAfterPerMonthCents,
      essentialsPerMonthCents: context.variableEssentialsPerMonthCents,
      goodLifePerMonthCents: context.variableNonEssentialPerMonthCents,
      // Where today's contributions come from — the projection is "at the
      // allocation in force today", and the screen says which one that is.
      contributionsFrom: todayAllocation.plan ? { id: todayAllocation.plan.id, name: todayAllocation.plan.name } : null,
    },
    options: {
      variants: variantTotals,
      fixedCategories,
      lines,
      cashAccounts,
      people: people.map((p) => ({ id: p.id, name: p.name })),
    },
    scenarios,
    warnings,
  };
}

/** @typedef {Awaited<ReturnType<typeof loadHouse>>} HousePayload */

