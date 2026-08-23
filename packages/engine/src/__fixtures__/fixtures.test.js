// Golden-fixture reproduction. See `01-engine.md` for the source tables.
//
// A note on precision: the phase doc's dollar figures are computed with
// infinite-precision fractions (e.g. a fortnightly income annualised then
// divided by 12 lands on 10490.155 dollars — half a cent). This engine is
// integer-cents-everywhere by design (see the hard conventions doc), so any
// quantity derived from such a figure necessarily rounds once more than the
// spreadsheet's floats did. The two genuinely load-bearing invariants —
// transfers reconciling exactly to gross, and unallocated hitting exactly
// zero — are asserted with exact equality. Everything else is asserted to
// the nearest cent or two, which is what "integer cents" actually buys you.
import { describe, expect, it } from "vitest";
import { computeAllocation } from "../allocation.js";
import { equivalent } from "../cadence.js";
import { toCents } from "../money.js";
import { mustAt, mustFind, mustGet } from "../invariant.js";
import { futureValueCents } from "../projections.js";
import {
  ALLOCATION_LINES,
  FIXED_COST_BILLS,
  FIXED_COST_BILLS_AS_SPREADSHEET_TOTAL,
  GROSS_USUAL_FORTNIGHTLY_CENTS,
  INCOME_LANDING_ACCOUNT_ID,
  VARIABLE_ESSENTIALS_MONTHLY_CENTS,
  VARIABLE_NON_ESSENTIAL_MONTHLY_CENTS,
} from "./as-spreadsheet.js";
import { FIXED_COST_BILLS_CORRECTED } from "./corrected.js";

/** @import { Cents } from "../money.js" */

/**
 * @param {Cents} c
 * @returns {number}
 */
function centsToDollars(c) {
  return c / 100;
}

/**
 * @param {Cents} actual
 * @param {number} expectedDollars
 * @param {number} [toleranceCents]
 */
function expectDollarsNear(actual, expectedDollars, toleranceCents = 2) {
  expect(
    Math.abs(actual - Math.round(expectedDollars * 100)),
  ).toBeLessThanOrEqual(toleranceCents);
}

/** Sum of `equivalent(bill, 'monthly')` over a set of bills — the
 * conventional-equivalence fixed-cost total that feeds `AllocationInput`. */
/**
 * @param {typeof FIXED_COST_BILLS} bills
 * @returns {Cents}
 */
function fixedTotalMonthlyCents(bills) {
  return bills
    .map((b) => equivalent(b.baseAmountCents, b.frequency, "monthly"))
    .reduce((a, b) => a + b, 0);
}

const GROSS_MONTHLY_CENTS = equivalent(GROSS_USUAL_FORTNIGHTLY_CENTS, "fortnightly", "monthly");

describe("Fixture A — as-spreadsheet", () => {
  it("reproduces income totals", () => {
    expect(GROSS_USUAL_FORTNIGHTLY_CENTS).toBe(toCents(4841.61));
  });

  it("reproduces category subtotals via conventional equivalence", () => {
    const byId = new Map(FIXED_COST_BILLS.map((b) => [b.id, b]));
    const entertainment = fixedTotalMonthlyCents([mustGet(byId, "stan"), mustGet(byId, "spotify"), mustGet(byId, "disney_plus")]);
    expectDollarsNear(equivalent(entertainment, "monthly", "yearly"), 635.76);

    const utilities = fixedTotalMonthlyCents([
      mustGet(byId, "internet"),
      mustGet(byId, "gas"),
      mustGet(byId, "electricity"),
      mustGet(byId, "water"),
      mustGet(byId, "ambulance_cover"),
      mustGet(byId, "ambulance_cover_lp"),
      mustGet(byId, "phone"),
      mustGet(byId, "phone_lp"),
    ]);
    // A category with 8 bills accumulates up to ~8 independent half-cent
    // roundings before the annual conversion — a wider tolerance here is
    // the expected cost of integer-cents-everywhere, not a bug.
    expectDollarsNear(equivalent(utilities, "monthly", "yearly"), 4609.88, 6);

    // Spreadsheet Car subtotal deliberately EXCLUDES both Roadside Assist
    // rows — reproducing that omission is the point of Fixture A.
    const carSpreadsheetSubtotal = fixedTotalMonthlyCents([
      mustGet(byId, "car_rego"),
      mustGet(byId, "car_rego_lp"),
      mustGet(byId, "car_insurance"),
      mustGet(byId, "car_insurance_lp"),
    ]);
    expectDollarsNear(equivalent(carSpreadsheetSubtotal, "monthly", "yearly"), 3998.04);
  });

  it("reproduces the fixed-cost total, including the unlabelled duplicate Rent bill but excluding both Roadside Assist rows (the spreadsheet's own bug)", () => {
    const total = fixedTotalMonthlyCents(FIXED_COST_BILLS_AS_SPREADSHEET_TOTAL);
    // 18 bills, each independently rounded to the cent before summing — a
    // few cents of cumulative drift against the spreadsheet's float-exact
    // figure is the expected cost of integer-cents-everywhere, not a bug.
    expectDollarsNear(total, 3541.516667, 5);
    expectDollarsNear(equivalent(total, "monthly", "yearly"), 42498.2, 5);
    expectDollarsNear(equivalent(total, "monthly", "fortnightly"), 1634.546154, 5);
    expectDollarsNear(equivalent(total, "monthly", "weekly"), 817.2730769, 5);
  });

  it("reproduces variable-cost totals", () => {
    expect(VARIABLE_ESSENTIALS_MONTHLY_CENTS).toBe(toCents(2111));
    expectDollarsNear(equivalent(VARIABLE_ESSENTIALS_MONTHLY_CENTS, "monthly", "fortnightly"), 974.3076923);
    expectDollarsNear(equivalent(VARIABLE_ESSENTIALS_MONTHLY_CENTS, "monthly", "weekly"), 487.1538462);
  });

  describe("allocation", () => {
    const fixedTotal = fixedTotalMonthlyCents(FIXED_COST_BILLS_AS_SPREADSHEET_TOTAL);
    const result = computeAllocation({
      grossPerMonthCents: GROSS_MONTHLY_CENTS,
      payCadence: "fortnightly",
      fixedTotalPerMonthCents: fixedTotal,
      variableEssentialsPerMonthCents: VARIABLE_ESSENTIALS_MONTHLY_CENTS,
      variableNonEssentialPerMonthCents: VARIABLE_NON_ESSENTIAL_MONTHLY_CENTS,
      incomeLandingAccountId: INCOME_LANDING_ACCOUNT_ID,
      lines: ALLOCATION_LINES,
    });

    it("reproduces stage 1 (Fixed + Variable)", () => {
      expectDollarsNear(mustAt(result.stages, 0).subtotalPerMonthCents, 5652.516667);
      expectDollarsNear(mustAt(result.stages, 0).remainingPerMonthCents, 4837.638333);
      expect(mustAt(result.stages, 0).actualPct).toBeCloseTo(53.88401474, 1);
    });

    it("reproduces stage 2 (Invest/Save/Tithe/Bill Shock)", () => {
      expectDollarsNear(mustAt(result.stages, 1).subtotalPerMonthCents, 3776.4558);
      expectDollarsNear(mustAt(result.stages, 1).remainingPerMonthCents, 1061.182533);
    });

    it("fully consumes remaining in stage 3 (Eating Out / Personal Prize 50/50)", () => {
      expect(result.unallocatedPerMonthCents).toBe(0);
    });

    it("reproduces goodLifeFidelityCents as positive (short of the $1143 aspiration)", () => {
      expectDollarsNear(result.goodLifeFidelityCents, 81.817467, 5);
      expect(result.goodLifeFidelityCents).toBeGreaterThan(0);
    });

    it("reproduces every fortnightly transfer, and the total reconciles to fortnightly gross EXACTLY", () => {
      const byAccount = new Map(result.transfers.map((t) => [t.accountId, t]));
      expectDollarsNear(mustGet(byAccount, "2up").perPayCents, 1464.084246, 5);
      expectDollarsNear(mustGet(byAccount, "ubank_house").perPayCents, 387.3288, 3);
      expectDollarsNear(mustGet(byAccount, "ubank_holiday").perPayCents, 387.3288, 3);
      expectDollarsNear(mustGet(byAccount, "raiz").perPayCents, 387.3288, 3);
      expectDollarsNear(mustGet(byAccount, "newhope").perPayCents, 338.9127, 3);
      expectDollarsNear(mustGet(byAccount, "ubank_generosity").perPayCents, 96.8322, 3);
      expectDollarsNear(mustGet(byAccount, INCOME_LANDING_ACCOUNT_ID).perPayCents, 1634.546154, 3);
      expectDollarsNear(mustGet(byAccount, "ubank_mojo").perPayCents, 145.2483, 3);
      expect(mustGet(byAccount, INCOME_LANDING_ACCOUNT_ID).isNoOp).toBe(true);

      const total = result.transfers.reduce((sum, t) => sum + t.perPayCents, 0);
      expect(total).toBe(equivalent(GROSS_MONTHLY_CENTS, "monthly", "fortnightly"));
      expect(total).toBe(GROSS_USUAL_FORTNIGHTLY_CENTS);
    });

    it("reproduces Mojo's months-of-stage-1 targets and periods to save", () => {
      const mojoPerPay = mustFind(result.transfers, (t) => t.accountId === "ubank_mojo").perPayCents;
      const stage1Subtotal = mustAt(result.stages, 0).subtotalPerMonthCents;
      const targets = [1, 3, 6, 12].map((months) => months * stage1Subtotal);
      const periods = targets.map((target) => Math.ceil(target / mojoPerPay));
      // Labelled `fortnights` here, deliberately — the spreadsheet mislabels
      // this "Weeks to save" but it is fortnights (39 fortnights ~= 18
      // months, not 39 weeks). Never reproduce the wrong label.
      expect(periods).toEqual([39, 117, 234, 467]);
    });
  });
});

describe("Fixture B — corrected (unlabelled duplicate Rent bill removed)", () => {
  const fixedTotal = fixedTotalMonthlyCents(FIXED_COST_BILLS_CORRECTED);
  const result = computeAllocation({
    grossPerMonthCents: GROSS_MONTHLY_CENTS,
    payCadence: "fortnightly",
    fixedTotalPerMonthCents: fixedTotal,
    variableEssentialsPerMonthCents: VARIABLE_ESSENTIALS_MONTHLY_CENTS,
    variableNonEssentialPerMonthCents: VARIABLE_NON_ESSENTIAL_MONTHLY_CENTS,
    incomeLandingAccountId: INCOME_LANDING_ACCOUNT_ID,
    lines: ALLOCATION_LINES,
  });

  it("reproduces the corrected fixed total", () => {
    expectDollarsNear(fixedTotal, 2918.656667);
    expectDollarsNear(equivalent(fixedTotal, "monthly", "fortnightly"), 1347.072308);
  });

  it("reproduces stage 1 now under the 50% goal", () => {
    expectDollarsNear(mustAt(result.stages, 0).subtotalPerMonthCents, 5029.656667);
    expect(mustAt(result.stages, 0).actualPct).toBeCloseTo(47.9465, 1);
    expectDollarsNear(mustAt(result.stages, 0).remainingPerMonthCents, 5460.498333);
  });

  it("leaves stage 2 unchanged — it's a pure percentage of gross", () => {
    expectDollarsNear(mustAt(result.stages, 1).subtotalPerMonthCents, 3776.4558);
    expectDollarsNear(mustAt(result.stages, 1).remainingPerMonthCents, 1684.042533);
  });

  it("flips goodLifeFidelityCents to headroom (negative)", () => {
    expectDollarsNear(result.goodLifeFidelityCents, -541.042533, 5);
    expect(result.goodLifeFidelityCents).toBeLessThan(0);
  });

  it("still reconciles the transfer total to fortnightly gross exactly", () => {
    const byAccount = new Map(result.transfers.map((t) => [t.accountId, t]));
    expectDollarsNear(mustGet(byAccount, INCOME_LANDING_ACCOUNT_ID).perPayCents, 1347.072308, 3);
    expectDollarsNear(mustGet(byAccount, "2up").perPayCents, 1751.558092, 5);

    const total = result.transfers.reduce((sum, t) => sum + t.perPayCents, 0);
    expect(total).toBe(GROSS_USUAL_FORTNIGHTLY_CENTS);
  });
});

describe("Projections fixture", () => {
  it("reproduces the House and Raiz 6-month projections", () => {
    const house = futureValueCents(toCents(25403), toCents(839.2124), 0.0041, 6);
    expectDollarsNear(house, 31121.52, 20);

    const raiz = futureValueCents(toCents(37353.67), toCents(839.2124), 0.012, 6);
    expectDollarsNear(raiz, 45313.89, 20);
  });
});
