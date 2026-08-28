import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  countPaydays,
  daysBetween,
  projectPaydays,
  resolveCycle,
  resolveVariant,
  windowLengthDays,
  periodsBetween,
} from "./calendar.js";

/** @import { PaySchedule } from "./calendar.js" */

describe("projectPaydays", () => {
  it("projects a weekly schedule", () => {
    /** @type {PaySchedule} */
    const schedule = { anchorDate: "2026-01-01", cadence: "weekly" };
    const dates = projectPaydays(schedule, { from: "2026-01-01", to: "2026-02-01" });
    expect(dates).toEqual(["2026-01-01", "2026-01-08", "2026-01-15", "2026-01-22", "2026-01-29"]);
  });

  it("is half-open: excludes `to` itself", () => {
    /** @type {PaySchedule} */
    const schedule = { anchorDate: "2026-01-01", cadence: "weekly" };
    const dates = projectPaydays(schedule, { from: "2026-01-01", to: "2026-01-08" });
    expect(dates).toEqual(["2026-01-01"]);
  });

  it("excludes `from` when the anchor lands before the window", () => {
    /** @type {PaySchedule} */
    const schedule = { anchorDate: "2026-01-01", cadence: "fortnightly" };
    const dates = projectPaydays(schedule, { from: "2026-01-02", to: "2026-01-29" });
    expect(dates).toEqual(["2026-01-15"]);
  });

  it("handles an anchor far in the past relative to the window", () => {
    /** @type {PaySchedule} */
    const schedule = { anchorDate: "2000-01-06", cadence: "fortnightly" };
    const dates = projectPaydays(schedule, { from: "2026-01-01", to: "2026-01-29" });
    expect(dates.length).toBeGreaterThan(0);
    dates.forEach((d) => {
      expect(d >= "2026-01-01" && d < "2026-01-29").toBe(true);
    });
  });

  it("finds at least one 27-payday year for a fortnightly schedule over a 12-year window", () => {
    /** @type {PaySchedule} */
    const schedule = { anchorDate: "2020-01-03", cadence: "fortnightly" };
    let found27 = false;
    for (let year = 2020; year < 2032; year++) {
      const count = countPaydays(schedule, { from: `${year}-01-01`, to: `${year + 1}-01-01` });
      if (count === 27) found27 = true;
      // Never assume 26 — a fortnightly schedule drifts against the calendar.
      expect(count === 26 || count === 27).toBe(true);
    }
    expect(found27).toBe(true);
  });

  describe("month-end anchors", () => {
    it("clamps to the last day of a shorter month without permanent drift", () => {
      /** @type {PaySchedule} */
      const schedule = { anchorDate: "2026-01-31", cadence: "monthly" };
      const dates = projectPaydays(schedule, { from: "2026-01-01", to: "2026-05-01" });
      // Jan 31 -> Feb 28 (clamped, 2026 not a leap year) -> Mar 31 (anchor day
      // restored, computed straight from the anchor) -> Apr 30 (clamped).
      expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    });

    it("clamps to Feb 29 in a leap year", () => {
      /** @type {PaySchedule} */
      const schedule = { anchorDate: "2024-01-31", cadence: "monthly" };
      const dates = projectPaydays(schedule, { from: "2024-01-01", to: "2024-04-01" });
      expect(dates).toEqual(["2024-01-31", "2024-02-29", "2024-03-31"]);
    });

    it("handles a 30th-anchored series through February", () => {
      /** @type {PaySchedule} */
      const schedule = { anchorDate: "2026-01-30", cadence: "monthly" };
      const dates = projectPaydays(schedule, { from: "2026-01-01", to: "2026-04-01" });
      expect(dates).toEqual(["2026-01-30", "2026-02-28", "2026-03-30"]);
    });

    it("handles a 29th-anchored series through a non-leap February", () => {
      /** @type {PaySchedule} */
      const schedule = { anchorDate: "2026-01-29", cadence: "monthly" };
      const dates = projectPaydays(schedule, { from: "2026-01-01", to: "2026-04-01" });
      expect(dates).toEqual(["2026-01-29", "2026-02-28", "2026-03-29"]);
    });
  });
});

describe("countPaydays", () => {
  it("counts the same set projectPaydays returns", () => {
    /** @type {PaySchedule} */
    const schedule = { anchorDate: "2026-01-01", cadence: "weekly" };
    const window = { from: "2026-01-01", to: "2026-02-01" };
    expect(countPaydays(schedule, window)).toBe(projectPaydays(schedule, window).length);
  });
});

describe("resolveCycle", () => {
  /** @type {PaySchedule} */
  const schedule = { anchorDate: "2026-01-01", cadence: "fortnightly" };

  it("finds the cycle containing a date between paydays", () => {
    expect(resolveCycle(schedule, "2026-01-10")).toEqual({ cycleStart: "2026-01-01", cycleEnd: "2026-01-15" });
  });

  it("treats a date exactly on a payday as that cycle's start", () => {
    expect(resolveCycle(schedule, "2026-01-15")).toEqual({ cycleStart: "2026-01-15", cycleEnd: "2026-01-29" });
  });

  it("works for dates before the anchor", () => {
    expect(resolveCycle(schedule, "2025-12-20")).toEqual({ cycleStart: "2025-12-18", cycleEnd: "2026-01-01" });
  });
});

describe("resolveVariant", () => {
  it("resolves cleanly when exactly one entry covers the date", () => {
    const entries = [{ variantId: "usual", startsOn: "2026-01-01", endsOn: null }];
    expect(resolveVariant(entries, "2026-06-01")).toEqual({ variantId: "usual", diagnostics: [] });
  });

  it("resolves across a bounded-then-open-ended pair", () => {
    const entries = [
      { variantId: "usual", startsOn: "2026-01-01", endsOn: "2026-06-01" },
      { variantId: "pl_gov", startsOn: "2026-06-01", endsOn: null },
    ];
    expect(resolveVariant(entries, "2026-03-01")).toEqual({ variantId: "usual", diagnostics: [] });
    expect(resolveVariant(entries, "2026-06-01")).toEqual({ variantId: "pl_gov", diagnostics: [] });
  });

  it("flags an overlap and never guesses a winner", () => {
    const entries = [
      { variantId: "usual", startsOn: "2026-01-01", endsOn: "2026-07-01" },
      { variantId: "pl_gov", startsOn: "2026-06-01", endsOn: "2026-09-01" },
    ];
    const result = resolveVariant(entries, "2026-06-15");
    expect(result.variantId).toBeNull();
    expect(result.diagnostics).toEqual([
      { kind: "overlap", variantIds: ["usual", "pl_gov"], from: "2026-06-01", to: "2026-07-01" },
    ]);
  });

  it("flags a gap and never invents a default", () => {
    const entries = [
      { variantId: "usual", startsOn: "2026-01-01", endsOn: "2026-03-01" },
      { variantId: "pl_gov", startsOn: "2026-04-01", endsOn: null },
    ];
    const result = resolveVariant(entries, "2026-03-15");
    expect(result.variantId).toBeNull();
    expect(result.diagnostics).toEqual([{ kind: "gap", from: "2026-03-01", to: "2026-04-01" }]);
  });

  it("reports no coverage at all as a gap", () => {
    const result = resolveVariant([], "2026-03-15");
    expect(result.variantId).toBeNull();
    expect(result.diagnostics).toEqual([{ kind: "gap", from: "2026-03-15", to: "2026-03-15" }]);
  });
});

describe("windowLengthDays / daysBetween / addDaysIso", () => {
  it("computes window length in days", () => {
    expect(windowLengthDays({ from: "2026-01-01", to: "2026-02-01" })).toBe(31);
  });

  it("computes days between two dates", () => {
    expect(daysBetween("2026-01-01", "2026-01-08")).toBe(7);
  });

  it("shifts a date forward and backward", () => {
    expect(addDaysIso("2026-01-01", 31)).toBe("2026-02-01");
    expect(addDaysIso("2026-02-01", -31)).toBe("2026-01-01");
  });
});

describe("periodsBetween", () => {
  it("counts fortnights, and never calls them weeks", () => {
    // One year is 26 fortnights by the conventional divisor, not 52 of
    // anything — the spreadsheet's own mislabelling, made impossible here.
    expect(periodsBetween("2026-01-01", "2027-01-01", "fortnightly")).toBe(26);
    expect(periodsBetween("2026-01-01", "2027-01-01", "weekly")).toBe(52);
  });

  it("expresses the same span in whichever cadence is asked for", () => {
    expect(periodsBetween("2026-01-01", "2027-01-01", "monthly")).toBe(12);
    expect(periodsBetween("2026-01-01", "2027-01-01", "quarterly")).toBe(4);
    expect(periodsBetween("2026-01-01", "2027-01-01", "yearly")).toBe(1);
  });

  it("rounds to the nearest whole period", () => {
    // The conventional fortnight is 365.25/26 = 14.05 days, so 7 days is a
    // shade under half of one and rounds down; 8 rounds up.
    expect(periodsBetween("2026-01-01", "2026-01-08", "fortnightly")).toBe(0);
    expect(periodsBetween("2026-01-01", "2026-01-09", "fortnightly")).toBe(1);
  });

  it("is zero for the same date and negative going backwards", () => {
    expect(periodsBetween("2026-01-01", "2026-01-01", "monthly")).toBe(0);
    expect(periodsBetween("2027-01-01", "2026-01-01", "monthly")).toBe(-12);
  });

  it("reproduces the Mojo duration the phase doc states in fortnights", () => {
    // 39 fortnights is about 18 months — the doc's own worked example
    // (phases/09-goals-projections.md "/goals").
    const eta = addDaysIso("2026-01-01", 39 * 14);
    expect(periodsBetween("2026-01-01", eta, "fortnightly")).toBe(39);
    expect(periodsBetween("2026-01-01", eta, "monthly")).toBe(18);
  });
});
