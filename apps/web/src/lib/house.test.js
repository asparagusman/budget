import { describe, expect, it } from "vitest";
import { evaluateScenario, houseBase, houseSummary, scenarioCash } from "./house.js";

/** @import { HousePayload } from "./house.js" */

// An invented household, in the shape GET /house returns.
/** @type {HousePayload} */
const PAYLOAD = {
  on: "2026-01-15",
  settings: {
    incomeVariantId: "v",
    stopCategoryIds: ["rent"],
    keepAccountIds: ["give"],
    cashAccountIds: ["save"],
    grossByPerson: { a: 80_000_00, b: 70_000_00 },
    ownerCostsPerMonthCents: 600_00,
    otherPurchaseCostsCents: 4_000_00,
  },
  live: {
    variant: { id: "v", name: "Usual", perMonthCents: 10_000_00 },
    plan: { id: "p", name: "Usual" },
    incomePerMonthCents: 10_000_00,
    billsNowPerMonthCents: 2_800_00,
    billsAfterPerMonthCents: 800_00,
    essentialsPerMonthCents: 2_500_00,
    goodLifePerMonthCents: 1_300_00,
    contributionsFrom: { id: "p", name: "Usual" },
  },
  options: {
    variants: [{ id: "v", name: "Usual", perMonthCents: 10_000_00 }],
    fixedCategories: [{ id: "rent", name: "Rent", perMonthCents: 2_000_00, stops: true }],
    lines: [
      { id: "1", label: "Giving", accountId: "give", accountName: "Church", basis: "pct_of_gross", pct: 10, perMonthCents: 1_000_00, kept: true },
      { id: "2", label: "Holiday", accountId: "hol", accountName: "Holiday", basis: "pct_of_gross", pct: 5, perMonthCents: 500_00, kept: false },
    ],
    cashAccounts: [
      { id: "save", name: "House", balanceCents: 80_000_00, asAt: "2026-01-15", contributionPerMonthCents: 1_000_00, annualGrowthRate: 0, counted: true },
      { id: "other", name: "Shares", balanceCents: 5_000_00, asAt: null, contributionPerMonthCents: 0, annualGrowthRate: 0, counted: false },
    ],
    people: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
  },
  scenarios: [],
  warnings: [],
};

const SCENARIO = {
  scheme: /** @type {const} */ ("first_home_guarantee"),
  priceCents: 600_000_00,
  purchaseDate: "2026-07-15",
  ratePct: 6.5,
  childcarePerMonthCents: 500_00,
  payChanges: {},
  cashOverrideCents: null,
  extraCashCents: 0,
  lenderLimitCents: null,
};

describe("houseBase", () => {
  it("reads bills after buying and only the kept lines", () => {
    const base = houseBase(PAYLOAD);
    expect(base.billsPerMonthCents).toBe(800_00);
    expect(base.keptLines).toEqual([{ pct: 10, perMonthCents: 1_000_00 }]);
  });
});

describe("houseSummary", () => {
  it("counts only the chosen cash accounts", () => {
    const summary = houseSummary(PAYLOAD);
    expect(summary.cashTodayCents).toBe(80_000_00);
    expect(summary.cashPerMonthCents).toBe(1_000_00);
    expect(summary.roomPerMonthCents).toBe(10_000_00 - (800_00 + 600_00 + 2_500_00 + 1_000_00) - 1_300_00);
  });
});

describe("scenarioCash", () => {
  it("projects the counted accounts to the purchase date, plus any extra", () => {
    expect(scenarioCash(PAYLOAD, SCENARIO)).toEqual({ projectedCents: 86_000_00, typed: false, cashCents: 86_000_00 });
    expect(scenarioCash(PAYLOAD, { ...SCENARIO, extraCashCents: 5_000_00 }).cashCents).toBe(91_000_00);
  });

  it("uses a typed figure in place of the projection", () => {
    const cash = scenarioCash(PAYLOAD, { ...SCENARIO, cashOverrideCents: 50_000_00, extraCashCents: 1_000_00 });
    expect(cash).toEqual({ projectedCents: 86_000_00, typed: true, cashCents: 51_000_00 });
  });
});

describe("evaluateScenario", () => {
  it("feeds the projected cash into the purchase", () => {
    const { result, cash } = evaluateScenario(PAYLOAD, SCENARIO);
    expect(result.cashCents).toBe(cash.cashCents);
    expect(result.depositCents).toBe(cash.cashCents - result.costs.totalCents);
  });
});
