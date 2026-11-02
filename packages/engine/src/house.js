import { futureValueCents, periodRate } from "./projections.js";

/** @import { Cents } from "./money.js" */
/** @import { IsoDate } from "./calendar.js" */

// Buying a house: what a purchase price costs up front and each month, read
// against the household's own budget. Like goals, this REPORTS — nothing here
// is ever written back to an allocation.
//
// The rules below are law and scheme policy, not household data, so they live
// here rather than in a table. They are dated: every one of them changes, and
// a figure computed from a stale cap should say which year's cap it used.

/** @typedef {"first_home_guarantee" | "help_to_buy" | "standard"} HouseScheme */

export const HOUSE_RULES = Object.freeze({
  asAt: "2026-07-01",
  // Victorian land transfer duty, general rates (sro.vic.gov.au), and the
  // first-home-buyer exemption up to $600k tapering to nothing at $750k.
  duty: {
    firstHomeExemptUpToCents: 600_000_00,
    firstHomeConcessionUpToCents: 750_000_00,
  },
  // Land Use Victoria's transfer registration fee, fitted to the broker's
  // funding sheets ($1,519 at $600k, $1,753 at $700k), plus the flat mortgage
  // registration fee.
  transferFee: { baseCents: 115_00, perThousandCents: 2_34 },
  mortgageRegistrationCents: 140_00,
  // The Home Guarantee Scheme's First Home Guarantee: no LMI from a 5%
  // deposit. Above 20% it isn't needed, so the deposit is capped there and the
  // rest stays in the bank.
  firstHomeGuarantee: { minDepositPct: 5, maxDepositPct: 20, priceCapCents: 950_000_00 },
  // Help to Buy (Housing Australia customer guide v260701), existing homes.
  // The government share is the gap left after the buyer's deposit and the
  // lender's full borrowing limit — not a share the buyer chooses.
  helpToBuy: {
    minDepositPct: 2,
    minSharePct: 5,
    maxSharePct: 30,
    priceCapCents: 950_000_00,
    coupleIncomeCapCents: 165_000_00,
  },
  standard: { minDepositPct: 5, lmiFromLvrPct: 80 },
  // 2026-27 resident tax rates (ato.gov.au) and the 2% Medicare levy.
  tax: {
    brackets: /** @type {[Cents, number][]} */ ([
      [18_200_00, 0],
      [45_000_00, 0.15],
      [135_000_00, 0.3],
      [190_000_00, 0.37],
      [Infinity, 0.45],
    ]),
    medicareLevy: 0.02,
  },
  // Child Care Subsidy: 90% up to the lower threshold, then one point less for
  // each $5,000 of family income (Services Australia, 2025-26 thresholds).
  // Applied as a straight line rather than in $5,000 steps.
  ccs: { maxPct: 90, lowerThresholdCents: 85_279_00, centsPerPoint: 5_000_00 },
  loanYears: 30,
});

/**
 * Victorian general land transfer duty on a dutiable value.
 *
 * @param {Cents} priceCents
 */
function generalDutyCents(priceCents) {
  const p = priceCents;
  if (p <= 25_000_00) return p * 0.014;
  if (p <= 130_000_00) return 350_00 + (p - 25_000_00) * 0.024;
  if (p <= 960_000_00) return 2_870_00 + (p - 130_000_00) * 0.06;
  if (p <= 2_000_000_00) return p * 0.055;
  return 110_000_00 + (p - 2_000_000_00) * 0.065;
}

/**
 * Stamp duty for a first home buyer: nil to $600k, then a straight-line
 * concession to full duty at $750k.
 *
 * @param {Cents} priceCents
 */
export function firstHomeDutyCents(priceCents) {
  const { firstHomeExemptUpToCents: exempt, firstHomeConcessionUpToCents: upTo } = HOUSE_RULES.duty;
  if (priceCents <= exempt) return 0;
  const full = generalDutyCents(priceCents);
  if (priceCents >= upTo) return Math.round(full);
  return Math.round((full * (priceCents - exempt)) / (upTo - exempt));
}

/**
 * Everything paid in cash on top of the deposit: duty, the two registration
 * fees and the household's own estimate of everything else.
 *
 * @param {Cents} priceCents
 * @param {Cents} otherCostsCents conveyancing, building and pest, moving
 */
export function purchaseCostsCents(priceCents, otherCostsCents) {
  const dutyCents = firstHomeDutyCents(priceCents);
  const { baseCents, perThousandCents } = HOUSE_RULES.transferFee;
  const transferFeeCents = Math.round(baseCents + (perThousandCents * priceCents) / 1_000_00);
  const feesCents = transferFeeCents + HOUSE_RULES.mortgageRegistrationCents;
  return { dutyCents, feesCents, otherCents: otherCostsCents, totalCents: dutyCents + feesCents + otherCostsCents };
}

/**
 * Principal-and-interest repayment a month.
 *
 * @param {Cents} loanCents
 * @param {number} ratePct 6.69 == 6.69% p.a.
 * @param {number} [years]
 */
export function monthlyRepaymentCents(loanCents, ratePct, years = HOUSE_RULES.loanYears) {
  if (loanCents <= 0) return 0;
  const n = years * 12;
  const r = ratePct / 100 / 12;
  if (r === 0) return Math.round(loanCents / n);
  return Math.round((loanCents * r) / (1 - Math.pow(1 + r, -n)));
}

/**
 * Take-home pay a year from a gross salary: resident income tax and the
 * Medicare levy, nothing else (no offsets, no HELP repayments).
 *
 * @param {Cents} grossCents
 */
export function netAnnualFromGrossCents(grossCents) {
  let tax = 0;
  let floor = 0;
  for (const [ceiling, rate] of HOUSE_RULES.tax.brackets) {
    if (grossCents > floor) tax += (Math.min(grossCents, ceiling) - floor) * rate;
    floor = ceiling;
  }
  return Math.round(grossCents - tax - grossCents * HOUSE_RULES.tax.medicareLevy);
}

/**
 * Child Care Subsidy percentage for a family income.
 *
 * @param {Cents} familyGrossCents
 */
export function ccsPct(familyGrossCents) {
  const { maxPct, lowerThresholdCents, centsPerPoint } = HOUSE_RULES.ccs;
  const pct = maxPct - Math.max(0, familyGrossCents - lowerThresholdCents) / centsPerPoint;
  return Math.min(maxPct, Math.max(0, pct));
}

/**
 * Whole calendar months from `from` to `to`, never negative. 2026-11-02 to
 * 2027-06-30 is 7: the 2nd of each month from December to June.
 *
 * @param {IsoDate} from
 * @param {IsoDate} to
 */
export function wholeMonthsBetween(from, to) {
  const [fy = 0, fm = 0, fd = 0] = from.split("-").map(Number);
  const [ty = 0, tm = 0, td = 0] = to.split("-").map(Number);
  const months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  return Math.max(0, months);
}

/**
 * Cash the chosen accounts should hold on `to`, at today's contributions and
 * each account's own growth rate — the same compounding /projections uses.
 *
 * @param {{ balanceCents: Cents, contributionPerMonthCents: Cents, annualGrowthRate: number }[]} accounts
 * @param {IsoDate} from
 * @param {IsoDate} to
 */
export function projectedCashCents(accounts, from, to) {
  const months = wholeMonthsBetween(from, to);
  let total = 0;
  for (const account of accounts) {
    total += futureValueCents(
      account.balanceCents,
      account.contributionPerMonthCents,
      periodRate(account.annualGrowthRate, "monthly"),
      months,
    );
  }
  return total;
}

/**
 * What the household's budget looks like after buying, before any scenario:
 * the live figures from the app plus the household's own settings.
 *
 * `keptLines` are the allocation lines that carry on after buying (giving, an
 * emergency fund). A line with a `pct` is a percentage of income and moves
 * with a pay change; one without is a fixed amount.
 *
 * @typedef {{
 *   incomePerMonthCents: Cents,
 *   billsPerMonthCents: Cents,
 *   ownerCostsPerMonthCents: Cents,
 *   essentialsPerMonthCents: Cents,
 *   goodLifePerMonthCents: Cents,
 *   keptLines: { pct: number | null, perMonthCents: Cents }[],
 *   grossByPerson: Record<string, Cents>,
 *   otherPurchaseCostsCents: Cents,
 * }} HouseBase
 */

/**
 * One purchase to test. `cashCents` is already resolved (projected, or typed)
 * and `payChanges` are annual gross changes per person, signed — a move to
 * part-time is a negative change.
 *
 * @typedef {{
 *   scheme: HouseScheme,
 *   priceCents: Cents,
 *   ratePct: number,
 *   childcarePerMonthCents: Cents,
 *   payChanges: Record<string, Cents>,
 *   cashCents: Cents,
 *   lenderLimitCents: Cents | null,
 * }} HouseScenarioInput
 */

/**
 * The lines that carry on, at a given income: a percentage line moves with
 * it, a fixed one doesn't.
 *
 * @param {HouseBase["keptLines"]} lines
 * @param {Cents} incomePerMonthCents
 */
export function keptLinesPerMonthCents(lines, incomePerMonthCents) {
  let total = 0;
  for (const line of lines) {
    total += line.pct === null ? line.perMonthCents : Math.round((incomePerMonthCents * line.pct) / 100);
  }
  return total;
}

/**
 * What the budget after buying has room for each month once everything else
 * is paid and Good Life is kept whole — the most a repayment and childcare
 * can take between them before the budget is short. The same arithmetic as
 * `houseScenario`'s, without a purchase.
 *
 * @param {HouseBase} base
 */
export function monthlyRoomCents(base) {
  const spokenForPerMonthCents =
    base.billsPerMonthCents +
    base.ownerCostsPerMonthCents +
    base.essentialsPerMonthCents +
    keptLinesPerMonthCents(base.keptLines, base.incomePerMonthCents);
  return {
    spokenForPerMonthCents,
    roomPerMonthCents: base.incomePerMonthCents - spokenForPerMonthCents - base.goodLifePerMonthCents,
  };
}

/** @typedef {{ code: string, message: string }} HouseWarning */

/**
 * The whole purchase and the month after it.
 *
 * @param {HouseBase} base
 * @param {HouseScenarioInput} s
 */
export function houseScenario(base, s) {
  /** @type {HouseWarning[]} */
  const warnings = [];
  const price = s.priceCents;

  // Pay changes: taxed at each person's own marginal rate.
  let grossBefore = 0;
  let grossAfter = 0;
  let netChangeAnnual = 0;
  for (const [personId, gross] of Object.entries(base.grossByPerson)) {
    const change = s.payChanges[personId] ?? 0;
    grossBefore += gross;
    grossAfter += Math.max(0, gross + change);
    netChangeAnnual += netAnnualFromGrossCents(Math.max(0, gross + change)) - netAnnualFromGrossCents(gross);
  }
  const unknownEarners = Object.entries(s.payChanges).filter(
    ([personId, change]) => change !== 0 && !(personId in base.grossByPerson),
  );
  if (unknownEarners.length > 0) {
    warnings.push({
      code: "missing_gross",
      message: "A pay change is set for someone with no salary entered, so it isn't counted. Add their salary in the settings.",
    });
  }
  const netChangePerMonthCents = Math.round(netChangeAnnual / 12);
  const incomePerMonthCents = base.incomePerMonthCents + netChangePerMonthCents;

  // Childcare is entered at today's income; the subsidy falls as income rises.
  const childcarePerMonthCents =
    grossAfter === grossBefore
      ? s.childcarePerMonthCents
      : Math.round((s.childcarePerMonthCents * (100 - ccsPct(grossAfter))) / (100 - ccsPct(grossBefore)));

  const costs = purchaseCostsCents(price, base.otherPurchaseCostsCents);
  const available = s.cashCents - costs.totalCents;

  let depositCents = available;
  let minDepositPct = HOUSE_RULES.standard.minDepositPct;
  let governmentShareCents = 0;
  if (s.scheme === "first_home_guarantee") {
    const rules = HOUSE_RULES.firstHomeGuarantee;
    minDepositPct = rules.minDepositPct;
    depositCents = Math.min(available, Math.round((price * rules.maxDepositPct) / 100));
    if (price > rules.priceCapCents) {
      warnings.push({ code: "over_price_cap", message: "Over the $950k price cap for the 5% deposit scheme in Melbourne." });
    }
  } else if (s.scheme === "help_to_buy") {
    const rules = HOUSE_RULES.helpToBuy;
    minDepositPct = rules.minDepositPct;
    const limit = s.lenderLimitCents ?? Infinity;
    if (s.lenderLimitCents === null) {
      warnings.push({
        code: "missing_lender_limit",
        message: "Help to Buy sizes the government's share from your lender's borrowing limit. Add it from your broker.",
      });
    }
    // The share fills the gap after you borrow your maximum: at least 5%, at
    // least enough to reach a 20% deposit (no LMI), at most 30%.
    const gap = price - depositCents - limit;
    const floor = Math.max(
      Math.round((price * rules.minSharePct) / 100),
      Math.round((price * 20) / 100) - depositCents,
    );
    governmentShareCents = Math.min(Math.round((price * rules.maxSharePct) / 100), Math.max(gap, floor));
    if (price > rules.priceCapCents) {
      warnings.push({ code: "over_price_cap", message: "Over the $950k Help to Buy price cap in Melbourne." });
    }
    if (grossAfter > rules.coupleIncomeCapCents) {
      warnings.push({
        code: "over_income_cap",
        message: "Over the $165k couple income cap. It's tested on your last tax return, not today's pay.",
      });
    }
  }

  const loanCents = Math.max(0, price - governmentShareCents - depositCents);
  const bufferCents = available - depositCents;
  const minDepositCents = Math.round((price * minDepositPct) / 100);
  const depositOk = depositCents >= minDepositCents;
  if (!depositOk) {
    warnings.push({
      code: "deposit_short",
      message: `The deposit is under the ${minDepositPct}% minimum once stamp duty and costs are paid.`,
    });
  }
  if (s.scheme === "help_to_buy" && s.lenderLimitCents !== null && loanCents > s.lenderLimitCents) {
    warnings.push({
      code: "share_capped",
      message: "Even a 30% government share leaves a loan above your lender's limit.",
    });
  }
  const lvrPct = price > 0 ? (loanCents / price) * 100 : 0;
  if (s.scheme === "standard" && lvrPct > HOUSE_RULES.standard.lmiFromLvrPct) {
    warnings.push({
      code: "lmi_not_modelled",
      message: "Above 80% of the price, lenders add mortgage insurance. It isn't included here.",
    });
  }

  const repaymentPerMonthCents = monthlyRepaymentCents(loanCents, s.ratePct);
  const repaymentIfRatesRisePerMonthCents = monthlyRepaymentCents(loanCents, s.ratePct + 1);

  const keptPerMonthCents = keptLinesPerMonthCents(base.keptLines, incomePerMonthCents);

  const committedPerMonthCents =
    base.billsPerMonthCents +
    base.ownerCostsPerMonthCents +
    base.essentialsPerMonthCents +
    keptPerMonthCents +
    childcarePerMonthCents +
    repaymentPerMonthCents;
  const leftForGoodLifePerMonthCents = incomePerMonthCents - committedPerMonthCents;
  const sparePerMonthCents = leftForGoodLifePerMonthCents - base.goodLifePerMonthCents;

  return {
    costs,
    cashCents: s.cashCents,
    depositCents,
    depositPct: price > 0 ? (depositCents / price) * 100 : 0,
    minDepositCents,
    depositOk,
    bufferCents,
    governmentShareCents,
    governmentSharePct: price > 0 ? (governmentShareCents / price) * 100 : 0,
    loanCents,
    lvrPct,
    repaymentPerMonthCents,
    repaymentIfRatesRisePerMonthCents,
    familyGrossCents: grossAfter,
    netChangePerMonthCents,
    budget: {
      incomePerMonthCents,
      billsPerMonthCents: base.billsPerMonthCents,
      ownerCostsPerMonthCents: base.ownerCostsPerMonthCents,
      essentialsPerMonthCents: base.essentialsPerMonthCents,
      keptPerMonthCents,
      childcarePerMonthCents,
      repaymentPerMonthCents,
      leftForGoodLifePerMonthCents,
      goodLifePerMonthCents: base.goodLifePerMonthCents,
    },
    sparePerMonthCents,
    warnings,
  };
}

/** @typedef {ReturnType<typeof houseScenario>} HouseScenarioResult */

/**
 * Whether a scenario works: the budget isn't short, the deposit meets the
 * scheme's minimum, the price is inside its cap, and (Help to Buy) the loan
 * fits under the lender's limit.
 *
 * @param {HouseScenarioInput} s
 * @param {HouseScenarioResult} r
 */
function works(s, r) {
  if (r.sparePerMonthCents < 0 || !r.depositOk) return false;
  if (s.scheme === "first_home_guarantee" && s.priceCents > HOUSE_RULES.firstHomeGuarantee.priceCapCents) return false;
  if (s.scheme === "help_to_buy") {
    if (s.priceCents > HOUSE_RULES.helpToBuy.priceCapCents) return false;
    if (s.lenderLimitCents !== null && r.loanCents > s.lenderLimitCents) return false;
  }
  return true;
}

/**
 * The smallest `x` in [lo, hi] (in `step`s) for which `ok(x)` holds, given
 * that `ok` only ever flips from false to true as `x` rises. Null if it never
 * holds.
 *
 * @param {number} lo
 * @param {number} hi
 * @param {number} step
 * @param {(x: number) => boolean} ok
 */
function lowestPassing(lo, hi, step, ok) {
  let a = Math.floor(lo / step);
  let b = Math.ceil(hi / step);
  if (!ok(b * step)) return null;
  if (ok(a * step)) return a * step;
  while (b - a > 1) {
    const mid = Math.floor((a + b) / 2);
    if (ok(mid * step)) b = mid;
    else a = mid;
  }
  return b * step;
}

const PRICE_STEP_CENTS = 1_000_00;
const MAX_PRICE_CENTS = 5_000_000_00;

/**
 * The most this budget carries under the scenario's scheme, to the nearest
 * $1,000 below. Null when even the smallest price doesn't work.
 *
 * @param {HouseBase} base
 * @param {HouseScenarioInput} s
 */
export function maxPriceCents(base, s) {
  /** @param {number} price */
  const fails = (price) => {
    const at = { ...s, priceCents: price };
    return !works(at, houseScenario(base, at));
  };
  const firstFailing = lowestPassing(PRICE_STEP_CENTS, MAX_PRICE_CENTS, PRICE_STEP_CENTS, fails);
  if (firstFailing === null) return MAX_PRICE_CENTS;
  const best = firstFailing - PRICE_STEP_CENTS;
  return best >= PRICE_STEP_CENTS ? best : null;
}

/**
 * Cash needed on the day to make this price work, to the nearest $100 above.
 * Past a 20% deposit the guarantee isn't needed, so the guarantee is solved
 * as a standard loan. Null for Help to Buy — the loan is pinned to the
 * lender's limit, so more cash shrinks the government's share, not the
 * repayment — and when no amount of cash would do it.
 *
 * @param {HouseBase} base
 * @param {HouseScenarioInput} s
 */
export function cashNeededCents(base, s) {
  if (s.scheme === "help_to_buy") return null;
  const scheme = /** @type {HouseScheme} */ ("standard");
  /** @param {number} cash */
  const ok = (cash) => {
    const at = { ...s, scheme, cashCents: cash };
    const r = houseScenario(base, at);
    return r.sparePerMonthCents >= 0 && r.depositCents >= Math.round((s.priceCents * minDepositPctFor(s.scheme)) / 100);
  };
  const ceiling = s.priceCents + purchaseCostsCents(s.priceCents, base.otherPurchaseCostsCents).totalCents;
  return lowestPassing(0, ceiling, 100_00, ok);
}

/** @param {HouseScheme} scheme */
function minDepositPctFor(scheme) {
  if (scheme === "first_home_guarantee") return HOUSE_RULES.firstHomeGuarantee.minDepositPct;
  if (scheme === "help_to_buy") return HOUSE_RULES.helpToBuy.minDepositPct;
  return HOUSE_RULES.standard.minDepositPct;
}

const MAX_PAY_RISE_CENTS = 500_000_00;

/**
 * The combined gross pay rise a year, on top of the scenario's own pay
 * changes and split evenly between everyone with a salary, that makes this
 * price work. To the nearest $100 above. Zero when it already works; null
 * when no rise would (the deposit or a cap is the problem, not income), or
 * when no salaries are entered.
 *
 * @param {HouseBase} base
 * @param {HouseScenarioInput} s
 */
export function payRiseNeededCents(base, s) {
  const earners = Object.keys(base.grossByPerson);
  if (earners.length === 0) return null;
  /** @param {number} rise */
  const ok = (rise) => {
    /** @type {Record<string, Cents>} */
    const payChanges = { ...s.payChanges };
    for (const id of earners) payChanges[id] = (payChanges[id] ?? 0) + rise / earners.length;
    const at = { ...s, payChanges };
    return works(at, houseScenario(base, at));
  };
  return lowestPassing(0, MAX_PAY_RISE_CENTS, 100_00, ok);
}
