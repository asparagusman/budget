import { describe, expect, it } from "vitest";
import { cellText, centsText, changedCells, forgetSentEdits, parseCents } from "./cell-edits.js";

// The bill history form and the variable-costs actuals grid both keep only
// the operator's typing, laid over the stored figures. These are the rules
// that decide what a Save sends and whether leaving asks first.

describe("parseCents / centsText", () => {
  it("reads blank as no amount and anything else as cents", () => {
    expect(parseCents("")).toBeNull();
    expect(parseCents("  ")).toBeNull();
    expect(parseCents("12.5")).toBe(1250);
    expect(parseCents("0")).toBe(0);
  });

  it("writes a stored figure back as the text its field starts with", () => {
    expect(centsText(null)).toBe("");
    expect(centsText(1250)).toBe("12.5");
  });
});

describe("cellText", () => {
  it("shows the typing over the stored figure, and the stored figure where nothing was typed", () => {
    const edits = { a: "40" };
    expect(cellText(edits, "a", 3000)).toBe("40");
    expect(cellText(edits, "b", 3000)).toBe("30");
    expect(cellText(edits, "c", null)).toBe("");
  });

  it("keeps a cleared field cleared rather than falling back to the stored figure", () => {
    expect(cellText({ a: "" }, "a", 3000)).toBe("");
  });
});

describe("changedCells", () => {
  const cells = [
    { key: "2026-09-01", storedCents: 3000 },
    { key: "2026-08-01", storedCents: null },
    { key: "2026-07-01", storedCents: 2500 },
  ];

  it("lists only the cells whose typed amount differs from what is stored", () => {
    const edits = {
      "2026-09-01": "30.00", // typed back to the stored figure
      "2026-08-01": "12", // a new amount
      "2026-07-01": "", // cleared
    };
    expect(changedCells(edits, cells)).toEqual([
      { key: "2026-08-01", storedCents: null, nextCents: 1200 },
      { key: "2026-07-01", storedCents: 2500, nextCents: null },
    ]);
  });

  it("ignores typing for a cell that is no longer on screen", () => {
    expect(changedCells({ "2025-01-01": "99" }, cells)).toEqual([]);
  });

  it("survives the cells being refetched in a different order", () => {
    const edits = { "2026-08-01": "12" };
    expect(changedCells(edits, [...cells].reverse())).toHaveLength(1);
  });
});

describe("forgetSentEdits", () => {
  it("forgets what a save sent and keeps what was typed after", () => {
    const sent = { a: "10", b: "20" };
    const now = { a: "10", b: "25", c: "5" };
    expect(forgetSentEdits(now, sent)).toEqual({ b: "25", c: "5" });
  });

  it("returns the same object when there is nothing to forget", () => {
    const now = { a: "11" };
    expect(forgetSentEdits(now, { a: "10" })).toBe(now);
  });
});
