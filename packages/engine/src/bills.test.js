import { describe, expect, it } from "vitest";
import {
  billWindowFigures,
  billsContribution,
  projectInstances,
  requiredOpeningBalanceCents,
  simulateBalance,
  sumWindowFigures,
} from "./bills.js";
import { addDaysIso, countPaydays } from "./calendar.js";
import { equivalent } from "./cadence.js";
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
    // `frequency` rides along on every instance so a pooled list can still be
    // annualised one series at a time (see billsContribution).
    expect(instances).toEqual([
      { billId: "internet", dueDate: "2026-01-15", expectedCents: toCents(90), actualCents: null, isOverride: false, frequency: "monthly" },
      { billId: "internet", dueDate: "2026-02-15", expectedCents: toCents(90), actualCents: null, isOverride: false, frequency: "monthly" },
      { billId: "internet", dueDate: "2026-03-15", expectedCents: toCents(90), actualCents: null, isOverride: false, frequency: "monthly" },
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

  it("restarts escalation from a step change, since a step is a new base", () => {
    /** @type {Bill} */
    const bill = {
      id: "rent",
      baseAmountCents: toCents(1000),
      frequency: "yearly",
      anchorDate: "2020-06-01",
      amountModel: "escalating",
      escalationPct: 10,
      stepChanges: [{ effectiveFrom: "2023-06-01", newAmountCents: toCents(2000) }],
    };
    const instances = projectInstances(bill, { from: "2020-01-01", to: "2025-01-01" });
    // Compounding the $2,000 from the 2020 anchor read $2,662.00 on the day
    // it took effect and $2,928.20 a year later.
    expect(instances.map((i) => [i.dueDate, i.expectedCents])).toEqual([
      ["2020-06-01", toCents(1000)],
      ["2021-06-01", toCents(1100)],
      ["2022-06-01", toCents(1210)],
      ["2023-06-01", toCents(2000)],
      ["2024-06-01", toCents(2200)],
    ]);
  });

  it("counts escalation years from the anchor when a step predates it", () => {
    /** @type {Bill} */
    const bill = {
      id: "rent",
      baseAmountCents: toCents(1000),
      frequency: "yearly",
      anchorDate: "2020-06-01",
      amountModel: "escalating",
      escalationPct: 10,
      stepChanges: [{ effectiveFrom: "2019-01-01", newAmountCents: toCents(2000) }],
    };
    const instances = projectInstances(bill, { from: "2020-01-01", to: "2022-01-01" });
    expect(instances.map((i) => i.expectedCents)).toEqual([toCents(2000), toCents(2200)]);
  });

  it("completes a 29 February anchor's year on the 28th it actually falls due", () => {
    /** @type {Bill} */
    const bill = {
      id: "rego",
      baseAmountCents: toCents(100),
      frequency: "yearly",
      anchorDate: "2024-02-29",
      amountModel: "escalating",
      escalationPct: 10,
    };
    const instances = projectInstances(bill, { from: "2024-01-01", to: "2029-01-01" });
    // Compared against the unclamped 29th, 2025-02-28 had completed no year
    // at all, and 2028 then jumped from $121.00 to $146.41 past $133.10.
    expect(instances.map((i) => [i.dueDate, i.expectedCents])).toEqual([
      ["2024-02-29", toCents(100)],
      ["2025-02-28", toCents(110)],
      ["2026-02-28", toCents(121)],
      ["2027-02-28", toCents(133.1)],
      ["2028-02-29", toCents(146.41)],
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
      frequency: "monthly",
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

  it("annualises weekly and fortnightly bills by occurrences per year, whatever day the window starts", () => {
    // 1461 days holds 104 or 105 fortnights (208 or 209 weeks) depending on
    // the start. Counting them made this loan $1,093.75/month on 1-2 October
    // and $1,083.33 on 5-10 October, and the standing transfer with it.
    /** @type {Bill} */
    const loan = { id: "loan", baseAmountCents: toCents(500), frequency: "fortnightly", anchorDate: "2026-10-02", amountModel: "flat" };
    /** @type {Bill} */
    const childcare = { id: "cc", baseAmountCents: toCents(300), frequency: "weekly", anchorDate: "2026-10-05", amountModel: "flat" };
    /** @type {PaySchedule} */
    const pay = { anchorDate: "2026-10-01", cadence: "fortnightly" };

    for (let day = 1; day <= 14; day++) {
      const from = `2026-10-${String(day).padStart(2, "0")}`;
      const to = addDaysIso(from, 1461);
      const w = { from, to };
      const loanFigures = billsContribution(projectInstances(loan, w), w, pay);
      const childcareFigures = billsContribution(projectInstances(childcare, w), w, pay);
      const pooled = billsContribution([...projectInstances(loan, w), ...projectInstances(childcare, w)], w, pay);

      expect(loanFigures.perYearCents, from).toBe(toCents(500) * 26);
      expect(loanFigures.perMonthCents, from).toBe(equivalent(toCents(500), "fortnightly", "monthly"));
      expect(childcareFigures.perYearCents, from).toBe(toCents(300) * 52);
      expect(childcareFigures.perMonthCents, from).toBe(equivalent(toCents(300), "weekly", "monthly"));
      // Pooled, each series still annualises on its own cadence.
      expect(pooled.perYearCents, from).toBe(toCents(500) * 26 + toCents(300) * 52);
      // Per pay still divides by the paydays really in the window — the
      // deliberate todo.md [P10-12] behaviour — just from the nominal total.
      expect(loanFigures.perPayCents, from).toBe(
        Math.round((toCents(500) * 26 * 4) / countPaydays(pay, w)),
      );
    }
  });

  it("prices a day-based series at its average occurrence, so an escalation still counts", () => {
    /** @type {Bill} */
    const bill = {
      id: "b",
      baseAmountCents: toCents(100),
      frequency: "weekly",
      anchorDate: "2024-01-01",
      amountModel: "escalating",
      escalationPct: 10,
    };
    const instances = projectInstances(bill, window);
    const average = instances.reduce((sum, i) => sum + i.expectedCents, 0) / instances.length;
    expect(billsContribution(instances, window, paySchedule).perYearCents).toBe(Math.round(average * 52));
  });

  it("counts instances with no frequency as they fall, as it always has", () => {
    // Hand-built instances (no `projectInstances`, so no cadence to go on):
    // 105 fortnightly $500 dues over the 1461-day window, scaled by the window.
    /** @type {BillInstance[]} */
    const instances = Array.from({ length: 105 }, (_, k) => ({
      billId: "loan",
      dueDate: addDaysIso(window.from, k * 14),
      expectedCents: toCents(500),
      actualCents: null,
      isOverride: false,
    }));
    expect(billsContribution(instances, window, paySchedule).perYearCents).toBe(
      Math.round((105 * toCents(500) * 365.25) / 1461),
    );
  });
});

describe("billWindowFigures", () => {
  /** @type {PaySchedule} */
  const paySchedule = { anchorDate: "2026-01-01", cadence: "fortnightly" };
  const window = { from: "2026-09-01", to: "2027-09-01" };

  it("restates a rolling-average bill at the average of its actuals, not its base", () => {
    // The defect this function exists to make impossible: the screen used to
    // print `baseAmountCents` for this bill and annualise it to $1050.00,
    // while the contribution it feeds was built from $176.97 an instance.
    /** @type {Bill} */
    const gas = {
      id: "gas",
      baseAmountCents: toCents(175),
      frequency: "every_2_months",
      anchorDate: "2026-01-15",
      amountModel: "rolling_average",
      rollingWindow: 6,
    };
    /** @type {BillInstance[]} */
    const history = [
      ["2025-09-10", 17925],
      ["2025-11-10", 15842],
      ["2026-01-10", 16803],
      ["2026-03-10", 16853],
      ["2026-05-10", 18928],
      ["2026-07-10", 19832],
    ].map(([dueDate, actualCents]) => ({
      billId: "gas",
      dueDate: /** @type {string} */ (dueDate),
      expectedCents: 0,
      actualCents: /** @type {number} */ (actualCents),
      isOverride: false,
    }));

    const figures = billWindowFigures(projectInstances(gas, window, history), window, paySchedule);

    expect(figures.instanceCount).toBe(6);
    expect(figures.nextAmountCents).toBe(17697); // mean of the six actuals
    expect(figures.averageAmountCents).toBe(17697);
    expect(figures.nextDueDate).toBe("2026-09-15");
    expect(figures.windowTotalCents).toBe(17697 * 6);
    // The rolling average is one steady forecast figure, so the *forecast*
    // does not vary even though the history it came from does.
    expect(figures.variesInWindow).toBe(false);
  });

  it("reports the spread of a seasonal bill rather than one instance times a year", () => {
    /** @type {Bill} */
    const electricity = {
      id: "electricity",
      baseAmountCents: toCents(320),
      frequency: "quarterly",
      anchorDate: "2026-10-15",
      amountModel: "seasonal",
      seasonalFactors: { 1: 1.4, 4: 0.9, 7: 0.7, 10: 1.0 },
    };
    const figures = billWindowFigures(projectInstances(electricity, window), window, paySchedule);

    expect(figures.instanceCount).toBe(4);
    expect(figures.minAmountCents).toBe(toCents(224)); // July, factor 0.7
    expect(figures.maxAmountCents).toBe(toCents(448)); // January, factor 1.4
    expect(figures.variesInWindow).toBe(true);
    // 320 * (1.0 + 1.4 + 0.9 + 0.7) — annualising the next instance alone
    // would have claimed 4 * $320 = $1280.
    expect(figures.windowTotalCents).toBe(toCents(1280));
    expect(figures.averageAmountCents).toBe(toCents(320));
  });

  it("prefers an entered actual over the projection, as billsContribution does", () => {
    /** @type {Bill} */
    const bill = {
      id: "b",
      baseAmountCents: toCents(100),
      frequency: "monthly",
      anchorDate: "2026-09-15",
      amountModel: "flat",
    };
    const instances = projectInstances(bill, window);
    mustAt(instances, 0).actualCents = toCents(130);
    const figures = billWindowFigures(instances, window, paySchedule);

    expect(figures.nextAmountCents).toBe(toCents(130));
    expect(figures.windowTotalCents).toBe(toCents(100) * 11 + toCents(130));
    expect(figures.variesInWindow).toBe(true);
  });

  it("reports an empty window without dividing by zero", () => {
    // A yearly bill and a window shorter than its cadence: no occurrence
    // lands inside, so every per-instance figure has nothing to average.
    /** @type {Bill} */
    const bill = {
      id: "b",
      baseAmountCents: toCents(100),
      frequency: "yearly",
      anchorDate: "2026-02-01",
      amountModel: "flat",
    };
    const narrowWindow = { from: "2026-09-01", to: "2026-12-01" };
    const figures = billWindowFigures(projectInstances(bill, narrowWindow), narrowWindow, paySchedule);

    expect(figures.instanceCount).toBe(0);
    expect(figures.nextDueDate).toBe(null);
    expect(figures.nextAmountCents).toBe(null);
    expect(figures.averageAmountCents).toBe(null);
    expect(figures.minAmountCents).toBe(null);
    expect(figures.maxAmountCents).toBe(null);
    expect(figures.variesInWindow).toBe(false);
    expect(figures.windowTotalCents).toBe(0);
  });
});

describe("sumWindowFigures", () => {
  /** @type {PaySchedule} */
  const paySchedule = { anchorDate: "2026-01-01", cadence: "fortnightly" };
  const window = { from: "2026-09-01", to: "2027-09-01" };

  /** @param {string} id @param {number} dollars @param {import("./cadence.js").Cadence} frequency */
  function figuresFor(id, dollars, frequency) {
    /** @type {Bill} */
    const bill = {
      id,
      baseAmountCents: toCents(dollars),
      frequency,
      anchorDate: "2026-09-15",
      amountModel: "flat",
    };
    return billWindowFigures(projectInstances(bill, window), window, paySchedule);
  }

  it("adds to exactly what the rows print, so a subtotal can never disagree with its column", () => {
    const rows = [
      figuresFor("internet", 90, "monthly"),
      figuresFor("electricity", 320, "quarterly"),
      figuresFor("ambulance", 51.94, "yearly"),
    ];
    const total = sumWindowFigures(rows);
    /** @param {keyof typeof total} field */
    const addedUp = (field) => rows.reduce((sum, row) => sum + row[field], 0);

    expect(total.perYearCents).toBe(addedUp("perYearCents"));
    expect(total.perMonthCents).toBe(addedUp("perMonthCents"));
    expect(total.perPayCents).toBe(addedUp("perPayCents"));
    expect(total.windowTotalCents).toBe(addedUp("windowTotalCents"));
  });

  it("keeps the window total identical to pooling every instance", () => {
    // The window total is a plain sum of integer cents, so — unlike the
    // annualised figures, which round after scaling — it is exactly equal
    // whether the instances are pooled first or summed per bill afterwards.
    const bills = /** @type {const} */ ([
      ["internet", 90, "monthly"],
      ["electricity", 320, "quarterly"],
      ["ambulance", 51.94, "yearly"],
    ]);
    const pooled = bills.flatMap(([id, dollars, frequency]) =>
      projectInstances(
        { id, baseAmountCents: toCents(dollars), frequency, anchorDate: "2026-09-15", amountModel: "flat" },
        window,
      ),
    );
    const perBill = sumWindowFigures(bills.map(([id, dollars, frequency]) => figuresFor(id, dollars, frequency)));

    expect(perBill.windowTotalCents).toBe(billWindowFigures(pooled, window, paySchedule).windowTotalCents);
  });

  it("returns zeroes for no rows at all", () => {
    expect(sumWindowFigures([])).toEqual({
      perPayCents: 0,
      perMonthCents: 0,
      perYearCents: 0,
      windowTotalCents: 0,
    });
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
