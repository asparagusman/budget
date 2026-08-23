import { describe, expect, it } from "vitest";
import {
  billsContribution,
  projectInstances,
  requiredOpeningBalanceCents,
  simulateBalance,
} from "./bills.js";
import { toCents } from "./money.js";
import { mustAt } from "./invariant.js";

/** @import { Bill, BillInstance } from "./bills.js" */
/** @import { PaySchedule } from "./calendar.js" */

/** @type {Bill} */
const baseBill = {
  id: "internet",
  baseAmountCents: toCents(90),
  frequency: "monthly",
  anchorDate: "2026-01-15",
  amountModel: "flat",
};

describe("projectInstances", () => {
  it("projects a flat bill's due dates and amounts", () => {
    const instances = projectInstances(baseBill, { from: "2026-01-01", to: "2026-04-01" });
    expect(instances).toEqual([
      { billId: "internet", dueDate: "2026-01-15", expectedCents: toCents(90), actualCents: null, isOverride: false },
      { billId: "internet", dueDate: "2026-02-15", expectedCents: toCents(90), actualCents: null, isOverride: false },
      { billId: "internet", dueDate: "2026-03-15", expectedCents: toCents(90), actualCents: null, isOverride: false },
    ]);
  });

  it("applies a step change as a new base, not a modifier", () => {
    /** @type {Bill} */
    const bill = {
      ...baseBill,
      stepChanges: [{ effectiveFrom: "2026-02-01", newAmountCents: toCents(100) }],
    };
    const instances = projectInstances(bill, { from: "2026-01-01", to: "2026-04-01" });
    expect(instances.map((i) => i.expectedCents)).toEqual([toCents(90), toCents(100), toCents(100)]);
  });

  it("picks the latest applicable step change", () => {
    /** @type {Bill} */
    const bill = {
      ...baseBill,
      stepChanges: [
        { effectiveFrom: "2026-02-01", newAmountCents: toCents(100) },
        { effectiveFrom: "2026-03-01", newAmountCents: toCents(110) },
      ],
    };
    const instances = projectInstances(bill, { from: "2026-01-01", to: "2026-04-01" });
    expect(instances.map((i) => i.expectedCents)).toEqual([toCents(90), toCents(100), toCents(110)]);
  });

  it("applies seasonal factors by month, defaulting to 1 when absent", () => {
    /** @type {Bill} */
    const bill = {
      ...baseBill,
      amountModel: "seasonal",
      seasonalFactors: { 1: 1.5 }, // only January is seasoned
    };
    const instances = projectInstances(bill, { from: "2026-01-01", to: "2026-04-01" });
    expect(instances.map((i) => i.expectedCents)).toEqual([toCents(135), toCents(90), toCents(90)]);
  });

  it("compounds escalation yearly from the anchor date", () => {
    /** @type {Bill} */
    const bill = {
      id: "rent",
      baseAmountCents: toCents(1000),
      frequency: "yearly",
      anchorDate: "2020-06-01",
      amountModel: "escalating",
      escalationPct: 10,
    };
    const instances = projectInstances(bill, { from: "2020-01-01", to: "2024-01-01" });
    // Anchor 2020-06-01: due dates 2020-06-01 (0 yrs), 2021-06-01 (1 yr),
    // 2022-06-01 (2 yrs), 2023-06-01 (3 yrs).
    expect(instances.map((i) => i.expectedCents)).toEqual([
      toCents(1000),
      toCents(1100),
      toCents(1210),
      toCents(1331),
    ]);
  });

  it("rolling_average falls back to base with insufficient history, and never throws", () => {
    /** @type {Bill} */
    const bill = {
      ...baseBill,
      amountModel: "rolling_average",
      rollingWindow: 3,
    };
    /** @type {BillInstance[]} */
    const history = [
      { billId: "internet", dueDate: "2025-12-15", expectedCents: toCents(90), actualCents: toCents(80), isOverride: false },
    ];
    const instances = projectInstances(bill, { from: "2026-01-01", to: "2026-02-01" }, history);
    expect(mustAt(instances, 0).expectedCents).toBe(toCents(90)); // falls back — only 1 of 3 needed
  });

  it("rolling_average averages the most recent actuals once the window is full", () => {
    /** @type {Bill} */
    const bill = {
      ...baseBill,
      amountModel: "rolling_average",
      rollingWindow: 2,
    };
    /** @type {BillInstance[]} */
    const history = [
      { billId: "internet", dueDate: "2025-11-15", expectedCents: toCents(90), actualCents: toCents(70), isOverride: false },
      { billId: "internet", dueDate: "2025-12-15", expectedCents: toCents(90), actualCents: toCents(90), isOverride: false },
    ];
    const instances = projectInstances(bill, { from: "2026-01-01", to: "2026-02-01" }, history);
    expect(mustAt(instances, 0).expectedCents).toBe(toCents(80)); // mean of 70 and 90
  });

  it("an isOverride instance wins over every amount model", () => {
    /** @type {Bill} */
    const bill = {
      ...baseBill,
      amountModel: "escalating",
      escalationPct: 50, // would otherwise dramatically change the amount
    };
    /** @type {BillInstance[]} */
    const history = [
      { billId: "internet", dueDate: "2026-01-15", expectedCents: toCents(90), actualCents: toCents(12345), isOverride: true },
    ];
    const instances = projectInstances(bill, { from: "2026-01-01", to: "2026-02-01" }, history);
    expect(instances[0]).toEqual({
      billId: "internet",
      dueDate: "2026-01-15",
      expectedCents: toCents(90),
      actualCents: toCents(12345),
      isOverride: true,
    });
  });

  it("carries a non-override actual across from history", () => {
    /** @type {BillInstance[]} */
    const history = [
      { billId: "internet", dueDate: "2026-01-15", expectedCents: toCents(90), actualCents: toCents(95), isOverride: false },
    ];
    const instances = projectInstances(baseBill, { from: "2026-01-01", to: "2026-02-01" }, history);
    expect(mustAt(instances, 0).actualCents).toBe(toCents(95));
  });
});

describe("billsContribution", () => {
  /** @type {PaySchedule} */
  const paySchedule = { anchorDate: "2024-01-01", cadence: "fortnightly" };
  // Exactly 4 years = 1461 days = 365.25 * 4, so scaling to a 365.25-day
  // year exactly reproduces the true annual average with no window-edge
  // truncation, and a bill anchored at `window.from` lands its instances on
  // whole-year boundaries.
  const window = { from: "2024-01-01", to: "2028-01-01" };

  it("uses actualCents when present, expectedCents otherwise", () => {
    /** @type {Bill} */
    const bill = { id: "b", baseAmountCents: toCents(100), frequency: "monthly", anchorDate: "2024-01-01", amountModel: "flat" };
    const instances = projectInstances(bill, { from: "2024-01-01", to: "2024-03-01" });
    mustAt(instances, 0).actualCents = toCents(120);
    const result = billsContribution(instances, { from: "2024-01-01", to: "2024-03-01" }, paySchedule);
    // Jan actual 120, Feb expected 100 -> total 220 over a 60-day window.
    expect(result.perYearCents).toBe(Math.round((22000 * 365.25) / 60));
  });

  it("scales a monthly bill's total to a 365.25-day year", () => {
    /** @type {Bill} */
    const bill = { id: "b", baseAmountCents: toCents(100), frequency: "monthly", anchorDate: "2024-01-01", amountModel: "flat" };
    const instances = projectInstances(bill, window);
    expect(instances).toHaveLength(48); // 12/yr * 4 years, no truncation
    const result = billsContribution(instances, window, paySchedule);
    expect(result.perYearCents).toBe(toCents(1200)); // 48 * $100 / 4 years
    expect(result.perMonthCents).toBe(Math.round(result.perYearCents / 12));
  });

  it("divides the window total by the real payday count, not a nominal one", () => {
    /** @type {Bill} */
    const bill = { id: "b", baseAmountCents: toCents(100), frequency: "monthly", anchorDate: "2024-01-01", amountModel: "flat" };
    const instances = projectInstances(bill, window);
    const total = 48 * toCents(100);
    const paydayCount = 105; // real fortnightly count over this exact 1461-day window
    const result = billsContribution(instances, window, paySchedule);
    expect(result.perPayCents).toBe(Math.round(total / paydayCount));
  });

  it("returns zero rather than dividing by zero when there are no paydays", () => {
    /** @type {Bill} */
    const bill = { id: "b", baseAmountCents: toCents(100), frequency: "yearly", anchorDate: "2024-06-01", amountModel: "flat" };
    const instances = projectInstances(bill, window);
    // A yearly schedule anchored 2026-06-15 has no occurrence at all inside
    // this narrow window — the surrounding occurrences (2025-06-15,
    // 2026-06-15) both fall outside it.
    /** @type {PaySchedule} */
    const noPaySchedule = { anchorDate: "2026-06-15", cadence: "yearly" };
    const narrowWindow = { from: "2026-01-01", to: "2026-06-01" };
    const result = billsContribution(instances, narrowWindow, noPaySchedule);
    expect(result.perPayCents).toBe(0);
  });
});

describe("simulateBalance", () => {
  it("models the post-transfer balance without a payday spike", () => {
    /** @type {BillInstance[]} */
    const instances = [
      { billId: "b", dueDate: "2026-01-10", expectedCents: toCents(50), actualCents: null, isOverride: false },
    ];
    const points = simulateBalance(instances, toCents(100), ["2026-01-01", "2026-01-15"], toCents(0));
    expect(points).toEqual([
      { date: "2026-01-01", balanceCents: toCents(100), event: "payday" },
      { date: "2026-01-10", balanceCents: toCents(50), event: "bill" },
      { date: "2026-01-15", balanceCents: toCents(150), event: "payday" },
    ]);
  });

  it("credits a same-day payday before debiting a same-day bill", () => {
    /** @type {BillInstance[]} */
    const instances = [
      { billId: "b", dueDate: "2026-01-01", expectedCents: toCents(30), actualCents: null, isOverride: false },
    ];
    const points = simulateBalance(instances, toCents(100), ["2026-01-01"], toCents(0));
    expect(points).toEqual([
      { date: "2026-01-01", balanceCents: toCents(100), event: "payday" },
      { date: "2026-01-01", balanceCents: toCents(70), event: "bill" },
    ]);
  });
});

describe("requiredOpeningBalanceCents", () => {
  it("covers the lowest point of the cycle plus the buffer", () => {
    /** @type {BillInstance[]} */
    const instances = [
      { billId: "b", dueDate: "2026-01-05", expectedCents: toCents(200), actualCents: null, isOverride: false },
    ];
    // Starting from 0: payday +100 never happens before the bill, so the
    // simulated low point (before any payday) is -200.
    const required = requiredOpeningBalanceCents(instances, toCents(100), ["2026-01-20"], toCents(50));
    expect(required).toBe(toCents(250)); // 200 deficit + 50 buffer
  });

  it("needs only the buffer when the balance never dips negative", () => {
    /** @type {BillInstance[]} */
    const instances = [
      { billId: "b", dueDate: "2026-01-20", expectedCents: toCents(50), actualCents: null, isOverride: false },
    ];
    const required = requiredOpeningBalanceCents(instances, toCents(100), ["2026-01-01"], toCents(50));
    expect(required).toBe(toCents(50));
  });
});
