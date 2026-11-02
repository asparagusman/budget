import { describe, expect, it } from "vitest";
import {
  cashNeededCents,
  ccsPct,
  firstHomeDutyCents,
  houseScenario,
  maxPriceCents,
  monthlyRoomCents,
  monthlyRepaymentCents,
  netAnnualFromGrossCents,
  payRiseNeededCents,
  projectedCashCents,
  purchaseCostsCents,
  wholeMonthsBetween,
} from "./house.js";

/** @import { HouseBase, HouseScenarioInput } from "./house.js" */

// An invented household: $10,000 a month after tax, two earners.
/** @type {HouseBase} */
const BASE = {
  incomePerMonthCents: 10_000_00,
  billsPerMonthCents: 800_00,
  ownerCostsPerMonthCents: 600_00,
  essentialsPerMonthCents: 2_500_00,
  goodLifePerMonthCents: 1_300_00,
  keptLines: [
    { pct: 10, perMonthCents: 1_000_00 },
    { pct: null, perMonthCents: 50_00 },
  ],
  grossByPerson: { a: 80_000_00, b: 70_000_00 },
  otherPurchaseCostsCents: 4_000_00,
};

/** @type {HouseScenarioInput} */
const FHG_600 = {
  scheme: "first_home_guarantee",
  priceCents: 600_000_00,
  ratePct: 6.5,
  childcarePerMonthCents: 500_00,
  payChanges: {},
  cashCents: 100_000_00,
  lenderLimitCents: null,
};

describe("firstHomeDutyCents", () => {
  it("is nil to $600k, tapers to full duty at $750k, and is full above", () => {
    expect(firstHomeDutyCents(500_000_00)).toBe(0);
    expect(firstHomeDutyCents(600_000_00)).toBe(0);
    // A third of the way along the taper: a third of $34,070.
    expect(firstHomeDutyCents(650_000_00)).toBe(11_356_67);
    expect(firstHomeDutyCents(750_000_00)).toBe(40_070_00);
    expect(firstHomeDutyCents(850_000_00)).toBe(46_070_00);
  });
});

describe("purchaseCostsCents", () => {
  it("adds duty, the two registration fees and the household's other costs", () => {
    const costs = purchaseCostsCents(600_000_00, 4_000_00);
    expect(costs.dutyCents).toBe(0);
    expect(costs.feesCents).toBe(1_519_00 + 140_00);
    expect(costs.totalCents).toBe(costs.dutyCents + costs.feesCents + costs.otherCents);
  });
});

describe("monthlyRepaymentCents", () => {
  it("is the standard principal-and-interest repayment", () => {
    expect(monthlyRepaymentCents(500_000_00, 6)).toBe(2_997_75);
  });
  it("divides evenly at a zero rate and is nothing on no loan", () => {
    expect(monthlyRepaymentCents(360_000_00, 0)).toBe(1_000_00);
    expect(monthlyRepaymentCents(0, 6)).toBe(0);
  });
});

describe("netAnnualFromGrossCents", () => {
  it("takes 2026-27 resident tax and the Medicare levy", () => {
    expect(netAnnualFromGrossCents(18_000_00)).toBe(17_640_00);
    // $4,020 + 30% of $55,000, then 2% Medicare.
    expect(netAnnualFromGrossCents(100_000_00)).toBe(77_480_00);
  });
});

describe("ccsPct", () => {
  it("is 90% to the threshold, one point less per $5,000, never below zero", () => {
    expect(ccsPct(80_000_00)).toBe(90);
    expect(ccsPct(135_279_00)).toBeCloseTo(80, 6);
    expect(ccsPct(600_000_00)).toBe(0);
  });
});

describe("wholeMonthsBetween", () => {
  it("counts whole calendar months and never goes negative", () => {
    expect(wholeMonthsBetween("2026-11-02", "2027-06-30")).toBe(7);
    expect(wholeMonthsBetween("2026-11-30", "2027-06-02")).toBe(6);
    expect(wholeMonthsBetween("2027-06-30", "2026-11-02")).toBe(0);
  });
});

describe("projectedCashCents", () => {
  it("adds each account's balance and contributions, compounding where it grows", () => {
    const flat = projectedCashCents(
      [{ balanceCents: 10_000_00, contributionPerMonthCents: 500_00, annualGrowthRate: 0 }],
      "2026-01-15",
      "2026-08-15",
    );
    expect(flat).toBe(13_500_00);
    const growing = projectedCashCents(
      [{ balanceCents: 10_000_00, contributionPerMonthCents: 0, annualGrowthRate: 0.1 }],
      "2026-01-01",
      "2027-01-01",
    );
    expect(growing).toBe(11_000_00);
  });
});

describe("houseScenario", () => {
  it("reconciles: income less everything committed is what's left for Good Life", () => {
    const r = houseScenario(BASE, FHG_600);
    const b = r.budget;
    expect(b.incomePerMonthCents - b.billsPerMonthCents - b.ownerCostsPerMonthCents - b.essentialsPerMonthCents - b.keptPerMonthCents - b.childcarePerMonthCents - b.repaymentPerMonthCents).toBe(
      b.leftForGoodLifePerMonthCents,
    );
    expect(r.sparePerMonthCents).toBe(b.leftForGoodLifePerMonthCents - b.goodLifePerMonthCents);
    // 10% of income plus the fixed $50 line.
    expect(b.keptPerMonthCents).toBe(1_050_00);
    expect(r.loanCents).toBe(600_000_00 - r.depositCents);
    expect(r.warnings).toEqual([]);
  });

  it("caps the guarantee's deposit at 20% and leaves the rest as a buffer", () => {
    const r = houseScenario(BASE, { ...FHG_600, cashCents: 200_000_00 });
    expect(r.depositCents).toBe(120_000_00);
    expect(r.bufferCents).toBe(200_000_00 - r.costs.totalCents - 120_000_00);
  });

  it("flags a deposit under the scheme's minimum once costs are paid", () => {
    const r = houseScenario(BASE, { ...FHG_600, cashCents: 30_000_00 });
    expect(r.depositOk).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain("deposit_short");
  });

  it("taxes a pay change and lifts childcare as the subsidy falls", () => {
    const r = houseScenario(BASE, { ...FHG_600, payChanges: { a: 10_000_00 } });
    // $10,000 more at a 30% marginal rate and 2% Medicare: $6,800 a year.
    expect(r.netChangePerMonthCents).toBe(Math.round(6_800_00 / 12));
    expect(r.budget.childcarePerMonthCents).toBeGreaterThan(500_00);
    expect(r.familyGrossCents).toBe(160_000_00);
  });

  it("warns about a pay change for someone without a salary", () => {
    const r = houseScenario(BASE, { ...FHG_600, payChanges: { stranger: 5_000_00 } });
    expect(r.warnings.map((w) => w.code)).toContain("missing_gross");
    expect(r.netChangePerMonthCents).toBe(0);
  });

  it("pins a Help to Buy loan at the lender's limit and sizes the share from the gap", () => {
    const s = { ...FHG_600, scheme: /** @type {const} */ ("help_to_buy"), priceCents: 800_000_00, lenderLimitCents: 550_000_00 };
    const r = houseScenario(BASE, s);
    expect(r.loanCents).toBe(550_000_00);
    expect(r.governmentShareCents).toBe(800_000_00 - r.depositCents - 550_000_00);
    expect(r.governmentSharePct).toBeGreaterThanOrEqual(5);
    expect(r.governmentSharePct).toBeLessThanOrEqual(30);
    // A cheaper home under the same limit costs the same each month.
    const cheaper = houseScenario(BASE, { ...s, priceCents: 760_000_00 });
    expect(cheaper.repaymentPerMonthCents).toBe(r.repaymentPerMonthCents);
  });

  it("takes at least 5% under Help to Buy even when the lender would lend it all", () => {
    const r = houseScenario(BASE, { ...FHG_600, scheme: "help_to_buy", lenderLimitCents: 900_000_00 });
    expect(r.governmentShareCents).toBe(30_000_00);
    expect(r.loanCents).toBe(600_000_00 - 30_000_00 - r.depositCents);
  });

  it("takes enough under Help to Buy to reach a 20% deposit, so there's no LMI", () => {
    const r = houseScenario(BASE, { ...FHG_600, scheme: "help_to_buy", cashCents: 50_000_00, lenderLimitCents: 900_000_00 });
    expect(r.governmentShareCents).toBe(120_000_00 - r.depositCents);
    expect(r.loanCents).toBe(480_000_00);
  });

  it("flags Help to Buy's caps and a missing lender limit", () => {
    const over = houseScenario(BASE, {
      ...FHG_600,
      scheme: "help_to_buy",
      priceCents: 1_000_000_00,
      lenderLimitCents: 500_000_00,
      payChanges: { a: 20_000_00 },
    });
    expect(over.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["over_price_cap", "over_income_cap", "share_capped"]),
    );
    const missing = houseScenario(BASE, { ...FHG_600, scheme: "help_to_buy" });
    expect(missing.warnings.map((w) => w.code)).toContain("missing_lender_limit");
  });

  it("says mortgage insurance isn't modelled on a standard loan above 80%", () => {
    const r = houseScenario(BASE, { ...FHG_600, scheme: "standard" });
    expect(r.warnings.map((w) => w.code)).toContain("lmi_not_modelled");
  });
});

describe("maxPriceCents", () => {
  it("is the last $1,000 step that still works", () => {
    const max = maxPriceCents(BASE, FHG_600);
    expect(max).not.toBeNull();
    const at = houseScenario(BASE, { ...FHG_600, priceCents: /** @type {number} */ (max) });
    const past = houseScenario(BASE, { ...FHG_600, priceCents: /** @type {number} */ (max) + 1_000_00 });
    expect(at.sparePerMonthCents).toBeGreaterThanOrEqual(0);
    expect(past.sparePerMonthCents < 0 || !past.depositOk).toBe(true);
  });

  it("is null when the budget is short before any loan", () => {
    expect(maxPriceCents({ ...BASE, goodLifePerMonthCents: 9_000_00 }, FHG_600)).toBeNull();
  });
});

describe("cashNeededCents", () => {
  it("is the least cash, to $100, that leaves the budget whole", () => {
    const s = { ...FHG_600, priceCents: 700_000_00 };
    const cash = /** @type {number} */ (cashNeededCents(BASE, s));
    expect(cash).toBeGreaterThan(s.cashCents);
    const standard = { ...s, scheme: /** @type {const} */ ("standard") };
    expect(houseScenario(BASE, { ...standard, cashCents: cash }).sparePerMonthCents).toBeGreaterThanOrEqual(0);
    expect(houseScenario(BASE, { ...standard, cashCents: cash - 100_00 }).sparePerMonthCents).toBeLessThan(0);
  });

  it("is null for Help to Buy, where cash shrinks the share rather than the loan", () => {
    expect(cashNeededCents(BASE, { ...FHG_600, scheme: "help_to_buy", lenderLimitCents: 500_000_00 })).toBeNull();
  });
});

describe("payRiseNeededCents", () => {
  it("is zero when the scenario already works", () => {
    expect(houseScenario(BASE, FHG_600).sparePerMonthCents).toBeGreaterThanOrEqual(0);
    expect(payRiseNeededCents(BASE, FHG_600)).toBe(0);
  });

  it("is the least combined rise, split evenly, that makes a dearer price work", () => {
    const s = { ...FHG_600, priceCents: 700_000_00 };
    const rise = /** @type {number} */ (payRiseNeededCents(BASE, s));
    expect(rise).toBeGreaterThan(0);
    const split = (/** @type {number} */ r) => ({ a: r / 2, b: r / 2 });
    expect(houseScenario(BASE, { ...s, payChanges: split(rise) }).sparePerMonthCents).toBeGreaterThanOrEqual(0);
    expect(houseScenario(BASE, { ...s, payChanges: split(rise - 100_00) }).sparePerMonthCents).toBeLessThan(0);
  });

  it("is null when nobody's salary is entered or the deposit is the problem", () => {
    expect(payRiseNeededCents({ ...BASE, grossByPerson: {} }, FHG_600)).toBeNull();
    expect(payRiseNeededCents(BASE, { ...FHG_600, cashCents: 20_000_00 })).toBeNull();
  });
});

describe("monthlyRoomCents", () => {
  it("is what a repayment and childcare can take before the budget is short", () => {
    const { roomPerMonthCents, spokenForPerMonthCents } = monthlyRoomCents(BASE);
    expect(spokenForPerMonthCents).toBe(800_00 + 600_00 + 2_500_00 + 1_050_00);
    expect(roomPerMonthCents).toBe(10_000_00 - spokenForPerMonthCents - 1_300_00);
    // A scenario's spare is exactly the room less its repayment and childcare.
    const r = houseScenario(BASE, FHG_600);
    expect(r.sparePerMonthCents).toBe(roomPerMonthCents - r.repaymentPerMonthCents - r.budget.childcarePerMonthCents);
  });
});
