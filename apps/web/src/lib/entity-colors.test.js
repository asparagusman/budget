import { describe, expect, it } from "vitest";
import { colorFor, entityColors } from "./entity-colors.js";

const IDS = [
  "3f1c2a9e-0b7d-4c55-9a51-1d2e3f4a5b6c",
  "8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d",
  "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
  "0f9e8d7c-6b5a-4938-8271-605f4e3d2c1b",
];

describe("entityColors", () => {
  it("gives an id the same colour whatever order the list is in", () => {
    const forward = entityColors(IDS);
    const reversed = entityColors([...IDS].reverse());
    for (const id of IDS) expect(reversed.get(id)).toBe(forward.get(id));
  });

  it("never gives two ids the same colour while there are colours to spare", () => {
    const colors = entityColors(IDS);
    expect(new Set(colors.values()).size).toBe(IDS.length);
  });

  it("keeps existing colours when an id is added, unless the new one collides", () => {
    const before = entityColors(IDS);
    const after = entityColors([...IDS, "ffffffff-1111-4222-8333-444444444444"]);
    const moved = IDS.filter((id) => before.get(id) !== after.get(id));
    // Linear probing can displace at most the ids that probed past the new
    // one's slot — in practice none or one, never the whole list.
    expect(moved.length).toBeLessThanOrEqual(1);
  });

  it("reuses the palette rather than failing when there are more ids than colours", () => {
    const many = Array.from({ length: 9 }, (_, i) => `id-${i}`);
    const colors = entityColors(many);
    expect(colors.size).toBe(9);
    for (const value of colors.values()) expect(value).toMatch(/^var\(--chart-line-[1-5]\)$/);
  });

  it("only ever hands out CSS variables, never resolved colours", () => {
    for (const value of entityColors(IDS).values()) expect(value).toMatch(/^var\(--/);
  });
});

describe("colorFor", () => {
  it("falls back to ink for an id outside the set", () => {
    expect(colorFor(entityColors(IDS), "not-in-the-set")).toBe("var(--chart-total)");
  });
});
