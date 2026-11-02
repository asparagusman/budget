import { sumCents } from "./money.js";
import { OCCURRENCES_PER_YEAR } from "./cadence.js";
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
 * @typedef {{
 *   id: string,
 *   baseAmountCents: Cents,
 *   frequency: Cadence,
 *   anchorDate: IsoDate,
 *   amountModel: AmountModel,
 *   escalationPct?: number,
 *   rollingWindow?: number,
 *   seasonalFactors?: Record<number, number>,
 *   stepChanges?: Array<{ effectiveFrom: IsoDate, newAmountCents: Cents }>
 * }} Bill
 *
 * - `escalationPct` — % per year, `escalating` only.
 * - `rollingWindow` — N past actuals to average, `rolling_average` only.
 * - `seasonalFactors` — month 1-12 → multiplier, `seasonal` only.
 */

/**
 * @typedef {{
 *   billId: string,
 *   dueDate: IsoDate,
 *   expectedCents: Cents,
 *   actualCents: Cents | null,
 *   isOverride: boolean,
 *   frequency?: Cadence
 * }} BillInstance
 *
 * - `frequency` — the cadence of the series the instance was projected from.
 *   `projectInstances` always sets it; a stored history row has none. It is
 *   what lets `billsContribution` annualise a pooled list of instances one
 *   series at a time without a second lookup by `billId`.
 */

/** The step change in force at `dueDate`: the latest one with
 * `effectiveFrom <= dueDate`, or null before the first. ISO dates compare
 * correctly as plain strings.
 *
 * @param {Bill} bill
 * @param {IsoDate} dueDate
 */
function applicableStep(bill, dueDate) {
  const applicable = (bill.stepChanges ?? []).filter(
    (sc) => sc.effectiveFrom <= dueDate,
  );
  if (applicable.length === 0) return null;
  return applicable.reduce((a, b) =>
    a.effectiveFrom > b.effectiveFrom ? a : b,
  );
}

/** @param {number} year */
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * @param {number} year
 * @param {number} month 1-12
 */
function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Full anniversaries elapsed between `anchor` and `due` (e.g. an anchor of
 * 2020-06-15 has completed 0 years as of 2021-06-14, and 1 year as of
 * 2021-06-15). Never negative.
 *
 * An anniversary on a day its month doesn't have that year lands on the
 * month's last day — the same clamping `projectPaydays` gives the due dates
 * themselves. Compared against the raw day instead, a 29 February anchor
 * never completes a year on the 28 February its yearly bill actually falls
 * due, and the 2028 instance jumped two escalations at once.
 *
 * @param {IsoDate} anchor
 * @param {IsoDate} due
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
  const anniversaryDay = Math.min(ad, daysInMonth(dy, am));
  if (dm < am || (dm === am && dd < anniversaryDay)) years--;
  return Math.max(0, years);
}

/**
 * @param {Bill} bill
 * @param {IsoDate} dueDate
 * @param {BillInstance[]} history
 */
function computeExpectedCents(bill, dueDate, history) {
  // A step change replaces the base outright — it is a new base, not a
  // modifier on top of the old one.
  const step = applicableStep(bill, dueDate);
  const base = step?.newAmountCents ?? bill.baseAmountCents;
  switch (bill.amountModel) {
    case "flat":
      return base;
    case "seasonal": {
      const month = Number(dueDate.slice(5, 7));
      const factor = bill.seasonalFactors?.[month] ?? 1;
      return Math.round(base * factor);
    }
    case "escalating": {
      // ...so escalation restarts from it. Counting years from the anchor
      // instead applied the years before the step to an amount that was only
      // set at the step: rent stepped to $2,000 in 2023 on a 2020 anchor read
      // $2,662 that same day. A step dated before the anchor moves nothing.
      const since =
        step !== null && step.effectiveFrom > bill.anchorDate
          ? step.effectiveFrom
          : bill.anchorDate;
      const years = fullYearsElapsed(since, dueDate);
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
        frequency: bill.frequency,
      };
    }
    return {
      billId: bill.id,
      dueDate,
      expectedCents: computeExpectedCents(bill, dueDate, history),
      actualCents: existing?.actualCents ?? null,
      isOverride: false,
      frequency: bill.frequency,
    };
  });
}

// The cadences `projectPaydays` steps in days rather than months
// (calendar.js `DAYS_PER_OCCURRENCE`). No window of whole years holds a whole
// number of them.
/** @type {ReadonlySet<Cadence>} */
const DAY_BASED_CADENCES = new Set(["weekly", "fortnightly"]);

/**
 * The window total `billsContribution` annualises, with every weekly or
 * fortnightly series restated at its nominal rate. Fractional cents are
 * deliberate: the callers round once, at the figure they report.
 *
 * A month-based series lands a whole number of times in a window of whole
 * years — 48 monthly, 16 quarterly, 4 yearly in 1461 days — so its real total
 * scales to a year exactly. A day-based one never does: 1461 days holds 104
 * or 105 fortnights (208 or 209 weeks) depending on the day the window
 * starts, so counting them made a $500 fortnightly loan read $1,093.75 a
 * month on some days and $1,083.33 on others, and the standing transfer
 * moved with nothing changed but the date. Its instances are averaged
 * instead — which still prices in an escalation or an entered actual — and
 * charged `OCCURRENCES_PER_YEAR` times a year, the same convention
 * `equivalent()` uses, for however long the window is.
 *
 * An instance with no `frequency` was not built by `projectInstances`, and
 * counts as it falls.
 *
 * @param {BillInstance[]} inWindow
 * @param {number} days
 */
function nominalWindowTotal(inWindow, days) {
  /** @type {Map<string, { cadence: Cadence, amounts: Cents[] }>} */
  const daySeries = new Map();
  let total = 0;
  for (const instance of inWindow) {
    const amount = instance.actualCents ?? instance.expectedCents;
    const cadence = instance.frequency;
    if (cadence === undefined || !DAY_BASED_CADENCES.has(cadence)) {
      total += amount;
      continue;
    }
    const series = daySeries.get(instance.billId);
    if (series) series.amounts.push(amount);
    else daySeries.set(instance.billId, { cadence, amounts: [amount] });
  }
  for (const { cadence, amounts } of daySeries.values()) {
    const average = sumCents(amounts) / amounts.length;
    total += (average * OCCURRENCES_PER_YEAR[cadence] * days) / 365.25;
  }
  return total;
}

/**
 * The headline number the operator acts on, and it is an average — not the
 * mechanism a spreadsheet uses, but the same idea: each instance carries its
 * own forecast (seasonal, escalating, …), so the averaging already prices
 * those in.
 *
 * A weekly or fortnightly series is annualised by its occurrences per year
 * rather than by how many of it the window happens to hold — see
 * `nominalWindowTotal`. `perPayCents` still divides by the paydays actually
 * in the window, deliberately (todo.md `[P10-12]`).
 *
 * @param {BillInstance[]} instances
 * @param {DateWindow} window
 * @param {PaySchedule} paySchedule
 */
export function billsContribution(instances, window, paySchedule) {
  const inWindow = instances.filter(
    (i) => i.dueDate >= window.from && i.dueDate < window.to,
  );
  const days = windowLengthDays(window);
  const total = nominalWindowTotal(inWindow, days);

  const perYearCents = days > 0 ? Math.round((total * 365.25) / days) : 0;

  const paydays = countPaydays(paySchedule, window);
  const perPayCents = paydays > 0 ? Math.round(total / paydays) : 0;

  const perMonthCents = Math.round(perYearCents / 12);

  return { perPayCents, perMonthCents, perYearCents };
}

/**
 * @typedef {{
 *   perPayCents: Cents,
 *   perMonthCents: Cents,
 *   perYearCents: Cents,
 *   windowTotalCents: Cents,
 *   instanceCount: number,
 *   nextDueDate: IsoDate | null,
 *   nextAmountCents: Cents | null,
 *   averageAmountCents: Cents | null,
 *   minAmountCents: Cents | null,
 *   maxAmountCents: Cents | null,
 *   variesInWindow: boolean
 * }} WindowFigures
 */

/**
 * `billsContribution` plus everything a single bill's row needs to state what
 * it actually costs: the next occurrence, the average occurrence, the spread,
 * and the window total the three cadence figures are derived from. (For a
 * weekly or fortnightly bill they are derived from the average occurrence
 * instead, and `windowTotalCents` stays what really falls due in the window.)
 *
 * Its reason for existing is that a row cannot be restated from
 * `baseAmountCents * occurrences-per-year` without contradicting the
 * contribution it feeds. That shortcut is only correct for a `flat` bill: a
 * `rolling_average` bill prints the base the operator typed rather than the
 * average of the actuals they entered, and a `seasonal` or `escalating` bill
 * multiplies one occurrence by a whole year as though the model did nothing.
 * Both the API's `/fixed-costs/summary` and the fixed-costs screen's own live
 * preview call this, so a figure on screen and a figure in the budget cannot
 * be computed two different ways.
 *
 * `variesInWindow` describes the forecast, not the history: a
 * `rolling_average` bill collapses a spread of past actuals into one steady
 * figure and so does *not* vary, while a `flat` bill with a step change
 * inside the window does.
 *
 * @param {BillInstance[]} instances
 * @param {DateWindow} window
 * @param {PaySchedule} paySchedule
 * @returns {WindowFigures}
 */
export function billWindowFigures(instances, window, paySchedule) {
  const inWindow = instances
    .filter((i) => i.dueDate >= window.from && i.dueDate < window.to)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  // An entered actual beats the projection, the same precedence
  // `billsContribution` uses — so a row reads as the contribution it feeds.
  const amounts = inWindow.map((i) => i.actualCents ?? i.expectedCents);
  const first = inWindow[0];
  const windowTotalCents = sumCents(amounts);

  return {
    ...billsContribution(instances, window, paySchedule),
    windowTotalCents,
    instanceCount: amounts.length,
    nextDueDate: first?.dueDate ?? null,
    nextAmountCents: first ? (first.actualCents ?? first.expectedCents) : null,
    averageAmountCents: amounts.length > 0 ? Math.round(windowTotalCents / amounts.length) : null,
    minAmountCents: amounts.length > 0 ? Math.min(...amounts) : null,
    maxAmountCents: amounts.length > 0 ? Math.max(...amounts) : null,
    variesInWindow: amounts.length > 1 && Math.min(...amounts) !== Math.max(...amounts),
  };
}

/**
 * Adds a set of `billWindowFigures` into the subtotal printed above them.
 *
 * Deliberately a sum of the rows rather than a second `billsContribution`
 * over the same instances pooled together. Those two differ by a cent or
 * two, because `perYearCents` scales a window total by `365.25 / days` and
 * rounds, and rounding-then-summing is not summing-then-rounding. A subtotal
 * that does not equal the column above it is the exact class of bug phase 06
 * exists to make impossible, and "which of these two is the truer
 * annualisation" is a question worth less than the rows adding up.
 *
 * @param {WindowFigures[]} rows
 */
export function sumWindowFigures(rows) {
  return {
    perPayCents: sumCents(rows.map((r) => r.perPayCents)),
    perMonthCents: sumCents(rows.map((r) => r.perMonthCents)),
    perYearCents: sumCents(rows.map((r) => r.perYearCents)),
    windowTotalCents: sumCents(rows.map((r) => r.windowTotalCents)),
  };
}

/**
 * @typedef {{
 *   date: IsoDate,
 *   balanceCents: Cents,
 *   event: "payday" | "bill"
 * }} BalancePoint
 */

/**
 * One credit or debit in the simulated ledger. Module-level rather than
 * function-local because JSDoc typedefs have no function scope.
 *
 * @typedef {{
 *   date: IsoDate,
 *   kind: "payday" | "bill",
 *   amountCents: Cents,
 *   order: number
 * }} BalanceEvent
 */

/**
 * @param {IsoDate} date
 * @param {"payday" | "bill"} kind
 * @param {Cents} amountCents
 * @param {number} order
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

/**
 * How much could be taken out of the account today without it ever dropping
 * below `bufferCents` on the simulated path. A withdrawal now lowers every
 * later balance by the same amount, so the room is the gap between the
 * lowest balance the curve reaches (the opening balance counts — it is the
 * balance until the first event) and the buffer. Never negative: when the
 * account already dips under its buffer there is nothing to take, and
 * `requiredOpeningBalanceCents` says how much is missing instead.
 *
 * @param {BalancePoint[]} points
 * @param {Cents} openingBalanceCents
 * @param {Cents} bufferCents
 */
export function withdrawableCents(points, openingBalanceCents, bufferCents) {
  const lowest = points.reduce(
    (min, p) => Math.min(min, p.balanceCents),
    openingBalanceCents,
  );
  return Math.max(0, lowest - bufferCents);
}
