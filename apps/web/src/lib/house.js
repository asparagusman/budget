import {
  cashNeededCents,
  houseScenario,
  maxPriceCents,
  monthlyRoomCents,
  payRiseNeededCents,
  projectedCashCents,
} from "@budget/engine";

/** @import { Cents, HouseBase, HouseScenarioInput, HouseScheme } from "@budget/engine" */

// The glue between `GET /house` and the engine. Every figure on the house
// page is computed here, in the browser, from the live budget the API
// returns — so the edit sheet's preview and the saved card are the same
// function of the same inputs, and a scenario can be tried before it's saved.

/**
 * @typedef {{
 *   on: string,
 *   settings: {
 *     incomeVariantId: string | null,
 *     stopCategoryIds: string[],
 *     keepAccountIds: string[],
 *     cashAccountIds: string[],
 *     grossByPerson: Record<string, Cents>,
 *     ownerCostsPerMonthCents: Cents,
 *     otherPurchaseCostsCents: Cents,
 *   },
 *   live: {
 *     variant: { id: string, name: string, perMonthCents: Cents } | null,
 *     plan: { id: string, name: string } | null,
 *     incomePerMonthCents: Cents,
 *     billsNowPerMonthCents: Cents,
 *     billsAfterPerMonthCents: Cents,
 *     essentialsPerMonthCents: Cents,
 *     goodLifePerMonthCents: Cents,
 *     contributionsFrom: { id: string, name: string } | null,
 *   },
 *   options: {
 *     variants: { id: string, name: string, perMonthCents: Cents }[],
 *     fixedCategories: { id: string, name: string, perMonthCents: Cents, stops: boolean }[],
 *     lines: { id: string, label: string, accountId: string, accountName: string, basis: string, pct: number | null, perMonthCents: Cents, kept: boolean }[],
 *     cashAccounts: { id: string, name: string, balanceCents: Cents, asAt: string | null, contributionPerMonthCents: Cents, annualGrowthRate: number, counted: boolean }[],
 *     people: { id: string, name: string }[],
 *   },
 *   scenarios: HouseScenario[],
 *   warnings: { code: string, message: string }[],
 * }} HousePayload
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   scheme: HouseScheme,
 *   priceCents: Cents,
 *   purchaseDate: string,
 *   ratePct: number,
 *   childcarePerMonthCents: Cents,
 *   payChanges: Record<string, Cents>,
 *   cashOverrideCents: Cents | null,
 *   extraCashCents: Cents,
 *   lenderLimitCents: Cents | null,
 *   note: string | null,
 * }} HouseScenario
 */

/** What the scheme is called on screen. */
export const SCHEME_LABELS = /** @type {const} */ ({
  first_home_guarantee: "5% deposit scheme",
  help_to_buy: "Help to Buy",
  standard: "Standard loan",
});

/** @type {HouseScheme[]} */
export const SCHEMES = ["first_home_guarantee", "help_to_buy", "standard"];

/**
 * The budget every scenario is read against.
 *
 * @param {HousePayload} payload
 * @returns {HouseBase}
 */
export function houseBase(payload) {
  return {
    incomePerMonthCents: payload.live.incomePerMonthCents,
    billsPerMonthCents: payload.live.billsAfterPerMonthCents,
    ownerCostsPerMonthCents: payload.settings.ownerCostsPerMonthCents,
    essentialsPerMonthCents: payload.live.essentialsPerMonthCents,
    goodLifePerMonthCents: payload.live.goodLifePerMonthCents,
    keptLines: payload.options.lines.filter((l) => l.kept).map((l) => ({ pct: l.pct, perMonthCents: l.perMonthCents })),
    grossByPerson: payload.settings.grossByPerson,
    otherPurchaseCostsCents: payload.settings.otherPurchaseCostsCents,
  };
}

/**
 * The page's summary: income, what's already spoken for, and the room left
 * for a repayment and childcare.
 *
 * @param {HousePayload} payload
 */
export function houseSummary(payload) {
  const base = houseBase(payload);
  const counted = payload.options.cashAccounts.filter((a) => a.counted);
  return {
    ...monthlyRoomCents(base),
    cashTodayCents: counted.reduce((sum, a) => sum + a.balanceCents, 0),
    cashPerMonthCents: counted.reduce((sum, a) => sum + a.contributionPerMonthCents, 0),
  };
}

/**
 * Cash on the day: the counted accounts projected to the purchase date (or a
 * typed figure instead), plus any extra.
 *
 * @param {HousePayload} payload
 * @param {Pick<HouseScenario, "purchaseDate" | "cashOverrideCents" | "extraCashCents">} scenario
 */
export function scenarioCash(payload, scenario) {
  const projectedCents = projectedCashCents(
    payload.options.cashAccounts.filter((a) => a.counted),
    payload.on,
    scenario.purchaseDate,
  );
  const baseCents = scenario.cashOverrideCents ?? projectedCents;
  return { projectedCents, typed: scenario.cashOverrideCents !== null, cashCents: baseCents + scenario.extraCashCents };
}

/**
 * One scenario, fully worked: the purchase, the month after, and the three
 * "what would it take" answers.
 *
 * @param {HousePayload} payload
 * @param {Omit<HouseScenario, "id" | "name" | "note">} scenario
 */
export function evaluateScenario(payload, scenario) {
  const base = houseBase(payload);
  const cash = scenarioCash(payload, scenario);
  /** @type {HouseScenarioInput} */
  const input = {
    scheme: scenario.scheme,
    priceCents: scenario.priceCents,
    ratePct: scenario.ratePct,
    childcarePerMonthCents: scenario.childcarePerMonthCents,
    payChanges: scenario.payChanges,
    cashCents: cash.cashCents,
    lenderLimitCents: scenario.lenderLimitCents,
  };
  return {
    cash,
    result: houseScenario(base, input),
    maxPriceCents: maxPriceCents(base, input),
    cashNeededCents: cashNeededCents(base, input),
    payRiseNeededCents: payRiseNeededCents(base, input),
  };
}

/** @typedef {ReturnType<typeof evaluateScenario>} EvaluatedScenario */
