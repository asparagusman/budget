import { sumCents } from "./money.js";
import {
  countPaydays,
  projectPaydays,
  windowLengthDays,
} from "./calendar.js";

/** @import { Cents } from "./money.js" */
/** @import { Cadence } from "./cadence.js" */
/** @import { DateWindow, IsoDate, PaySchedule } from "./calendar.js" */

/** @typedef {"flat" | "seasonal" | "rolling_average" | "escalating"} AmountModel */

/**
 * @typedef {object} Bill
 * @property {string} id
 * @property {Cents} baseAmountCents
 * @property {Cadence} frequency
 * @property {IsoDate} anchorDate
 * @property {AmountModel} amountModel
 * @property {number} [escalationPct] % per year, `escalating` only.
 * @property {number} [rollingWindow] N past actuals to average, `rolling_average` only.
 * @property {Record<number, number>} [seasonalFactors] month 1-12 → multiplier, `seasonal` only.
 * @property {Array<{ effectiveFrom: IsoDate, newAmountCents: Cents }>} [stepChanges]
 */

/**
 * @typedef {object} BillInstance
 * @property {string} billId
 * @property {IsoDate} dueDate
 * @property {Cents} expectedCents
 * @property {Cents | null} actualCents
 * @property {boolean} isOverride
 */

/** The step-adjusted base at `dueDate`: the latest step change with
 * `effectiveFrom <= dueDate` replaces the base outright (it is a new base,
 * not a modifier on top of the old one). ISO dates compare correctly as
 * plain strings.
 *
 * @param {Bill} bill
 * @param {IsoDate} dueDate
 * @returns {Cents}
 */
function stepAdjustedBase(bill, dueDate) {
  const applicable = (bill.stepChanges ?? []).filter(
    (sc) => sc.effectiveFrom <= dueDate,
  );
  if (applicable.length === 0) return bill.baseAmountCents;
  const latest = applicable.reduce((a, b) =>
    a.effectiveFrom > b.effectiveFrom ? a : b,
  );
  return latest.newAmountCents;
}

/** Full anniversaries elapsed between `anchor` and `due` (e.g. an anchor of
 * 2020-06-15 has completed 0 years as of 2021-06-14, and 1 year as of
 * 2021-06-15). Never negative.
 *
 * @param {IsoDate} anchor
 * @param {IsoDate} due
 * @returns {number}
 */
function fullYearsElapsed(anchor, due) {
  const a = anchor.split("-");
  const d = due.split("-");
  const ay = Number(a[0]);
  const am = Number(a[1]);
  const ad = Number(a[2]);
  const dy = Number(d[0]);
  const dm = Number(d[1]);
  const dd = Number(d[2]);
  let years = dy - ay;
  if (dm < am || (dm === am && dd < ad)) years--;
  return Math.max(0, years);
}

/**
 * @param {Bill} bill
 * @param {IsoDate} dueDate
 * @param {BillInstance[]} history
 * @returns {Cents}
 */
function computeExpectedCents(bill, dueDate, history) {
  const base = stepAdjustedBase(bill, dueDate);
  switch (bill.amountModel) {
    case "flat":
      return base;
    case "seasonal": {
      const month = Number(dueDate.slice(5, 7));
      const factor = bill.seasonalFactors?.[month] ?? 1;
      return Math.round(base * factor);
    }
    case "escalating": {
      const years = fullYearsElapsed(bill.anchorDate, dueDate);
      const factor = Math.pow(1 + (bill.escalationPct ?? 0) / 100, years);
      return Math.round(base * factor);
    }
    case "rolling_average": {
      const windowSize = bill.rollingWindow ?? 0;
      const priorActuals = history
        .filter((h) => h.dueDate < dueDate)
        .sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1))
        .map((h) => h.actualCents)
        .filter((actualCents) => actualCents !== null)
        .slice(0, windowSize);
      // Fall back to the step-adjusted base whenever there isn't enough
      // history to fill the window — never throw, never average zero items.
      if (windowSize <= 0 || priorActuals.length < windowSize) return base;
      return Math.round(sumCents(priorActuals) / priorActuals.length);
    }
  }
}

/**
 * Projects every instance of `bill` due inside `window`. `history` supplies
 * past instances (for `rolling_average`, and for actuals/overrides already
 * recorded against a due date that falls inside `window`).
 *
 * An existing history instance with `isOverride: true` wins over every
 * amount model — operator entry is final.
 *
 * @param {Bill} bill
 * @param {DateWindow} window
 * @param {BillInstance[]} [history]
 * @returns {BillInstance[]}
 */
export function projectInstances(bill, window, history = []) {
  const dueDates = projectPaydays(
    { anchorDate: bill.anchorDate, cadence: bill.frequency },
    window,
  );
  const historyByDate = new Map(history.map((h) => [h.dueDate, h]));

  return dueDates.map((dueDate) => {
    const existing = historyByDate.get(dueDate);
    if (existing?.isOverride) {
      return {
        billId: bill.id,
        dueDate,
        expectedCents: existing.expectedCents,
        actualCents: existing.actualCents,
        isOverride: true,
      };
    }
    return {
      billId: bill.id,
      dueDate,
      expectedCents: computeExpectedCents(bill, dueDate, history),
      actualCents: existing?.actualCents ?? null,
      isOverride: false,
    };
  });
}

/**
 * The headline number the operator acts on, and it is an average — not the
 * mechanism a spreadsheet uses, but the same idea: each instance carries its
 * own forecast (seasonal, escalating, …), so the averaging already prices
 * those in.
 *
 * @param {BillInstance[]} instances
 * @param {DateWindow} window
 * @param {PaySchedule} paySchedule
 * @returns {{ perPayCents: Cents, perMonthCents: Cents, perYearCents: Cents }}
 */
export function billsContribution(instances, window, paySchedule) {
  const inWindow = instances.filter(
    (i) => i.dueDate >= window.from && i.dueDate < window.to,
  );
  const total = sumCents(
    inWindow.map((i) => i.actualCents ?? i.expectedCents),
  );

  const days = windowLengthDays(window);
  const perYearCents = days > 0 ? Math.round((total * 365.25) / days) : 0;

  const paydays = countPaydays(paySchedule, window);
  const perPayCents = paydays > 0 ? Math.round(total / paydays) : 0;

  const perMonthCents = Math.round(perYearCents / 12);

  return { perPayCents, perMonthCents, perYearCents };
}

/**
 * @typedef {object} BalancePoint
 * @property {IsoDate} date
 * @property {Cents} balanceCents
 * @property {"payday" | "bill"} event
 */

/**
 * One credit or debit in the simulated ledger. Module-level rather than
 * function-local because JSDoc typedefs have no function scope.
 *
 * @typedef {object} BalanceEvent
 * @property {IsoDate} date
 * @property {"payday" | "bill"} kind
 * @property {Cents} amountCents
 * @property {number} order
 */

/**
 * @param {IsoDate} date
 * @param {"payday" | "bill"} kind
 * @param {Cents} amountCents
 * @param {number} order
 * @returns {BalanceEvent}
 */
function balanceEvent(date, kind, amountCents, order) {
  return { date, kind, amountCents, order };
}

/**
 * Insight view only — powers a balance curve, never feeds back into
 * `billsContribution`. Models the **post-transfer** balance: the household's
 * income and bills share one account, so each cycle starts from the
 * contribution left behind after transfers go out, not the full salary. The
 * payday spike is irrelevant and must not appear in the curve.
 *
 * @param {BillInstance[]} instances
 * @param {Cents} contributionPerPayCents
 * @param {IsoDate[]} paydays
 * @param {Cents} openingBalanceCents
 * @returns {BalancePoint[]}
 */
export function simulateBalance(
  instances,
  contributionPerPayCents,
  paydays,
  openingBalanceCents,
) {
  const events = [
    ...paydays.map((date, order) =>
      balanceEvent(date, "payday", contributionPerPayCents, order),
    ),
    ...instances.map((inst, order) =>
      balanceEvent(
        inst.dueDate,
        "bill",
        -(inst.actualCents ?? inst.expectedCents),
        order,
      ),
    ),
  ];

  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    // Same-day tie: a payday's credit lands before a bill's debit, matching
    // how a bank actually processes a day's transactions.
    if (a.kind !== b.kind) return a.kind === "payday" ? -1 : 1;
    return a.order - b.order;
  });

  let balance = openingBalanceCents;
  /** @type {BalancePoint[]} */
  const points = [];
  for (const e of events) {
    balance = balance + e.amountCents;
    points.push({ date: e.date, balanceCents: balance, event: e.kind });
  }
  return points;
}

/** The opening balance that makes the average contribution hold: enough to
 * cover the lowest point the simulated balance reaches, plus `bufferCents`.
 *
 * @param {BillInstance[]} instances
 * @param {Cents} contributionPerPayCents
 * @param {IsoDate[]} paydays
 * @param {Cents} bufferCents
 * @returns {Cents}
 */
export function requiredOpeningBalanceCents(
  instances,
  contributionPerPayCents,
  paydays,
  bufferCents,
) {
  const points = simulateBalance(
    instances,
    contributionPerPayCents,
    paydays,
    0,
  );
  const minBalance = points.reduce(
    (min, p) => Math.min(min, p.balanceCents),
    0,
  );
  const deficit = Math.max(0, -minBalance);
  return deficit + bufferCents;
}
