import { describe, expect, it } from "vitest";
import { moveInList, moveWithinGroup, swapInList } from "./reorder.js";

// The reorder endpoint renumbers whatever order it is sent, so these three
// functions decide what the list ends up as. Off-by-one here is silent: the
// request succeeds and the row lands somewhere nobody asked for.

/** @param {string} id */
const item = (id) => ({ id });

const ALL = ["everyday", "savings", "mojo", "shares", "mortgage"].map(item);

describe("swapInList", () => {
  it("exchanges two items and leaves the rest alone", () => {
    expect(swapInList([1, 2, 3, 4], 0, 3)).toEqual([4, 2, 3, 1]);
  });

  it("returns the same array when there is nothing to do", () => {
    const items = [1, 2, 3];
    // Identity, not just equality: the caller uses it to decide whether to
    // send a request at all.
    expect(swapInList(items, 1, 1)).toBe(items);
    expect(swapInList(items, 0, 3)).toBe(items);
    expect(swapInList(items, -1, 0)).toBe(items);
  });
});

describe("moveInList", () => {
  it("moves an item one step in each direction", () => {
    expect(moveInList(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveInList(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  it("does nothing at either end", () => {
    const items = ["a", "b", "c"];
    expect(moveInList(items, 0, -1)).toBe(items);
    expect(moveInList(items, 2, 1)).toBe(items);
  });
});

describe("moveWithinGroup", () => {
  // Accounts are shown grouped by type but ordered by one `sortOrder` across
  // all of them, so a move the operator makes inside a group has to come back
  // as an order for the whole list.
  const savings = [ALL[1], ALL[2]].map((a) => /** @type {{ id: string }} */ (a));

  it("returns the whole list with the two group members exchanged", () => {
    const next = moveWithinGroup(ALL, savings, 1, -1);
    expect(next?.map((a) => a.id)).toEqual(["everyday", "mojo", "savings", "shares", "mortgage"]);
  });

  it("works when the group's members are not adjacent in the flat list", () => {
    // Everyday and Shares with two unrelated rows between them: exchanging
    // their POSITIONS is what flips their relative order, which is all a
    // renumber 0..n-1 needs.
    const spread = [ALL[0], ALL[3]].map((a) => /** @type {{ id: string }} */ (a));
    const next = moveWithinGroup(ALL, spread, 0, 1);
    expect(next?.map((a) => a.id)).toEqual(["shares", "savings", "mojo", "everyday", "mortgage"]);
    // Everything else keeps the position it had.
    expect(next?.[1]?.id).toBe("savings");
    expect(next?.[4]?.id).toBe("mortgage");
  });

  it("returns null at the group's own edges, not at the list's", () => {
    // "savings" is second in the flat list but first in its group, so up is
    // not available even though there is a row above it on screen.
    expect(moveWithinGroup(ALL, savings, 0, -1)).toBeNull();
    expect(moveWithinGroup(ALL, savings, 1, 1)).toBeNull();
  });

  it("returns null when the group holds something the list does not", () => {
    expect(moveWithinGroup(ALL, [item("ghost"), item("savings")], 0, 1)).toBeNull();
  });
});
