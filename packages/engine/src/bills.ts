import type { Cents } from "./money.js";
import { sumCents } from "./money.js";
import type { Cadence } from "./cadence.js";
import type { DateWindow, IsoDate, PaySchedule } from "./calendar.js";
import { countPaydays, projectPaydays, windowLengthDays } from "./calendar.js";

export type AmountModel = "flat" | "seasonal" | "rolling_average" | "escalating";

export interface Bill {
  id: string;
  baseAmountCents: Cents;
  frequency: Cadence;
  anchorDate: IsoDate;
  amountModel: AmountModel;
  /** % per year, `escalating` only. */
  escalationPct?: number;
  /** N past actuals to average, `rolling_average` only. */
  rollingWindow?: number;
  /** month 1-12 → multiplier, `seasonal` only. */
  seasonalFactors?: Record<number, number>;
  stepChanges?: Array<{ effectiveFrom: IsoDate; newAmountCents: Cents }>;
}

export interface BillInstance {
  billId: string;
  dueDate: IsoDate;
  expectedCents: Cents;
  actualCents: Cents | null;
  isOverride: boolean;
}

/** The step-adjusted base at `dueDate`: the latest step change with
 * `effectiveFrom <= dueDate` replaces the base outright (it is a new base,
 * not a modifier on top of the old one). ISO dates compare correctly as
 * plain strings. */
function stepAdjustedBase(bill: Bill, dueDate: IsoDate): Cents {
  const applicable = (bill.stepChanges ?? []).filter((sc) => sc.effectiveFrom <= dueDate);
  if (applicable.length === 0) return bill.baseAmountCents;
  const latest = applicable.reduce((a, b) => (a.effectiveFrom > b.effectiveFrom ? a : b));
  return latest.newAmountCents;
}

/** Full anniversaries elapsed between `anchor` and `due` (e.g. an anchor of
 * 2020-06-15 has completed 0 years as of 2021-06-14, and 1 year as of
 * 2021-06-15). Never negative. */
function fullYearsElapsed(anchor: IsoDate, due: IsoDate): number {
  const [ay, am, ad] = anchor.split("-").map(Number) as [number, number, number];
  const [dy, dm, dd] = due.split("-").map(Number) as [number, number, number];
  let years = dy - ay;
  if (dm < am || (dm === am && dd < ad)) years--;
  return Math.max(0, years);
}

function computeExpectedCents(bill: Bill, dueDate: IsoDate, history: BillInstance[]): Cents {
  const base = stepAdjustedBase(bill, dueDate);
  switch (bill.amountModel) {
    case "flat":
      return base;
    case "seasonal": {
      const month = Number(dueDate.slice(5, 7));
      const factor = bill.seasonalFactors?.[month] ?? 1;
      return Math.round(base * factor) as Cents;
    }
    case "escalating": {
      const years = fullYearsElapsed(bill.anchorDate, dueDate);
      const factor = Math.pow(1 + (bill.escalationPct ?? 0) / 100, years);
      return Math.round(base * factor) as Cents;
    }
    case "rolling_average": {
      const windowSize = bill.rollingWindow ?? 0;
      const priorActuals = history
        .filter((h) => h.dueDate < dueDate && h.actualCents !== null)
        .sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1))
        .slice(0, windowSize)
        .map((h) => h.actualCents as Cents);
      // Fall back to the step-adjusted base whenever there isn't enough
      // history to fill the window — never throw, never average zero items.
      if (windowSize <= 0 || priorActuals.length < windowSize) return base;
      return Math.round(sumCents(priorActuals) / priorActuals.length) as Cents;
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
 */
export function projectInstances(
  bill: Bill,
  window: DateWindow,
  history: BillInstance[] = [],
): BillInstance[] {
  const dueDates = projectPaydays({ anchorDate: bill.anchorDate, cadence: bill.frequency }, window);
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
 */
export function billsContribution(
  instances: BillInstance[],
  window: DateWindow,
  paySchedule: PaySchedule,
): { perPayCents: Cents; perMonthCents: Cents; perYearCents: Cents } {
  const inWindow = instances.filter((i) => i.dueDate >= window.from && i.dueDate < window.to);
  const total = sumCents(inWindow.map((i) => (i.actualCents ?? i.expectedCents) as Cents));

  const days = windowLengthDays(window);
  const perYearCents = (days > 0 ? Math.round((total * 365.25) / days) : 0) as Cents;

  const paydays = countPaydays(paySchedule, window);
  const perPayCents = (paydays > 0 ? Math.round(total / paydays) : 0) as Cents;

  const perMonthCents = Math.round(perYearCents / 12) as Cents;

  return { perPayCents, perMonthCents, perYearCents };
}

export interface BalancePoint {
  date: IsoDate;
  balanceCents: Cents;
  event: "payday" | "bill";
}

/**
 * Insight view only — powers a balance curve, never feeds back into
 * `billsContribution`. Models the **post-transfer** balance: the household's
 * income and bills share one account, so each cycle starts from the
 * contribution left behind after transfers go out, not the full salary. The
 * payday spike is irrelevant and must not appear in the curve.
 */
export function simulateBalance(
  instances: BillInstance[],
  contributionPerPayCents: Cents,
  paydays: IsoDate[],
  openingBalanceCents: Cents,
): BalancePoint[] {
  interface Event {
    date: IsoDate;
    kind: "payday" | "bill";
    amountCents: Cents;
    order: number;
  }

  const events: Event[] = [
    ...paydays.map((date, order): Event => ({ date, kind: "payday", amountCents: contributionPerPayCents, order })),
    ...instances.map((inst, order): Event => ({
      date: inst.dueDate,
      kind: "bill",
      amountCents: -((inst.actualCents ?? inst.expectedCents) as number) as Cents,
      order,
    })),
  ];

  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    // Same-day tie: a payday's credit lands before a bill's debit, matching
    // how a bank actually processes a day's transactions.
    if (a.kind !== b.kind) return a.kind === "payday" ? -1 : 1;
    return a.order - b.order;
  });

  let balance = openingBalanceCents;
  const points: BalancePoint[] = [];
  for (const e of events) {
    balance = (balance + e.amountCents) as Cents;
    points.push({ date: e.date, balanceCents: balance, event: e.kind });
  }
  return points;
}

/** The opening balance that makes the average contribution hold: enough to
 * cover the lowest point the simulated balance reaches, plus `bufferCents`. */
export function requiredOpeningBalanceCents(
  instances: BillInstance[],
  contributionPerPayCents: Cents,
  paydays: IsoDate[],
  bufferCents: Cents,
): Cents {
  const points = simulateBalance(instances, contributionPerPayCents, paydays, 0 as Cents);
  const minBalance = points.reduce((min, p) => Math.min(min, p.balanceCents), 0);
  const deficit = Math.max(0, -minBalance);
  return (deficit + bufferCents) as Cents;
}
