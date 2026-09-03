import { describe, expect, it } from "vitest";
import { MOBILE_PRIMARY_PATHS, NAV_ITEMS, pageTitle } from "./nav.js";

// One list drives the sidebar, the bottom nav, the "More" sheet and the
// command palette's Navigation group. Nothing here is arithmetic, and all of
// it is the kind of thing that breaks silently: a chord that two entries
// claim, a mobile path that points at no page, a screen whose top bar reads
// "Budget" because nobody gave it a name.

describe("NAV_ITEMS", () => {
  it("gives every entry its own `g` chord", () => {
    const chords = NAV_ITEMS.map((item) => item.chord);
    // A collision is silent: the palette binds both and one of them simply
    // never fires.
    expect(new Set(chords).size).toBe(chords.length);
    // "g" itself is the prefix, so nothing may claim it.
    expect(chords).not.toContain("g");
  });

  it("points every entry at a distinct path", () => {
    const paths = NAV_ITEMS.map((item) => item.to);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(path.startsWith("/")).toBe(true);
  });

  it("keeps the mobile bottom nav to destinations that exist in the list", () => {
    for (const path of MOBILE_PRIMARY_PATHS) {
      expect(NAV_ITEMS.some((item) => item.to === path)).toBe(true);
    }
    // Everything not pinned to the bar has to be reachable through "More",
    // which renders the remainder of the same list.
    expect(NAV_ITEMS.length).toBeGreaterThan(MOBILE_PRIMARY_PATHS.length);
  });
});

describe("pageTitle", () => {
  it("names a screen that is in the nav", () => {
    expect(pageTitle("/")).toBe("Dashboard");
    expect(pageTitle("/costs/variable")).toBe("Variable Costs");
  });

  it("names the screens that are deliberately not in the nav", () => {
    // A one-time tool and a drill-down. Without these the mobile top bar
    // falls back to "Budget" and the operator loses their place.
    expect(pageTitle("/import")).toBe("Import");
    expect(pageTitle("/costs/fixed/some-bill-id")).toBe("Bill history");
  });

  it("prefers the exact nav match over the prefix rule", () => {
    // "/costs/fixed" is a page in its own right; only something BELOW it is
    // a bill's history.
    expect(pageTitle("/costs/fixed")).toBe("Fixed Costs");
  });

  it("falls back rather than rendering nothing", () => {
    expect(pageTitle("/nowhere")).toBe("Budget");
  });
});
