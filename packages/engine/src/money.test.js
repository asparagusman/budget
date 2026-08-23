import { describe, expect, it } from "vitest";
import { divideCents, pctOfCents, sumCents, toCents } from "./money.js";

describe("toCents", () => {
  it("converts dollars to whole cents", () => {
    expect(toCents(10.5)).toBe(1050);
    expect(toCents(0)).toBe(0);
  });

  it("rounds half-up on the cent to absorb float noise", () => {
    expect(toCents(19.995)).toBe(2000);
    expect(toCents(0.005)).toBe(1);
  });
});

describe("divideCents", () => {
  it("splits an exact multiple evenly", () => {
    expect(divideCents(300, [1, 1, 1])).toEqual([100, 100, 100]);
  });

  it("sums to exactly the total when it doesn't divide evenly", () => {
    const shares = divideCents(100, [1, 1, 1]);
    expect(sumCents(shares)).toBe(100);
    // Largest-remainder: 33.33 each, remainder 1 cent handed to index 0.
    expect(shares).toEqual([34, 33, 33]);
  });

  it("breaks ties deterministically by index", () => {
    // Equal weights, so equal remainders — leftover cents go to the lowest
    // indices first, every time.
    const shares = divideCents(10, [1, 1, 1, 1, 1, 1, 1]);
    expect(sumCents(shares)).toBe(10);
    expect(shares).toEqual([2, 2, 2, 1, 1, 1, 1]);
  });

  it("handles a single weight", () => {
    expect(divideCents(999, [1])).toEqual([999]);
  });

  it("handles an empty weight list", () => {
    expect(divideCents(100, [])).toEqual([]);
  });

  it("handles weights summing to zero without throwing", () => {
    const shares = divideCents(500, [0, 0, 0]);
    expect(sumCents(shares)).toBe(500);
  });

  it("handles a zero total", () => {
    expect(divideCents(0, [1, 2, 3])).toEqual([0, 0, 0]);
  });

  it("weights totals correctly, not just evenly", () => {
    const shares = divideCents(1000, [1, 3]);
    expect(sumCents(shares)).toBe(1000);
    expect(shares).toEqual([250, 750]);
  });
});

describe("pctOfCents", () => {
  it("computes a percentage of an amount", () => {
    expect(pctOfCents(10000, 8)).toBe(800);
  });

  it("rounds half-up on the cent", () => {
    expect(pctOfCents(101, 50)).toBe(51); // 50.5 -> 51
  });
});

describe("sumCents", () => {
  it("sums a list of cents", () => {
    expect(sumCents([100, 200, 300])).toBe(600);
  });

  it("sums an empty list to zero", () => {
    expect(sumCents([])).toBe(0);
  });
});
