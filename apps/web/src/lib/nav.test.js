import { describe, expect, it } from "vitest";
import { NAV_ITEMS, activeNavItem, pageTitle } from "./nav.js";

// One list drives the sidebar, the mobile menu and the command palette's
// Navigation group. Nothing here is arithmetic, and all of it is the kind of
// thing that breaks silently: a chord that two entries claim, a page one
// level down that highlights nothing, a screen whose top bar reads "Budget"
// because nobody gave it a name.

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

});

describe("activeNavItem", () => {
  it("matches a nav page exactly", () => {
    expect(activeNavItem("/")?.label).toBe("Dashboard");
    expect(activeNavItem("/costs/variable")?.label).toBe("Variable Costs");
  });

  it("claims a page one level down for the entry above it", () => {
    expect(activeNavItem("/costs/fixed/some-bill-id")?.label).toBe("Fixed Costs");
    // Admin's entry points at its first tab, so its other tabs only match
    // through `section`.
    expect(activeNavItem("/admin/devices")?.label).toBe("Admin");
  });

  it("never lets the dashboard claim everything", () => {
    // Every path starts with "/", so a prefix rule on it would light the
    // dashboard up on every page that isn't in the list.
    expect(activeNavItem("/import")).toBeUndefined();
    expect(activeNavItem("/nowhere")).toBeUndefined();
  });

  it("does not mistake a shared prefix for a parent", () => {
    expect(activeNavItem("/goalsx")).toBeUndefined();
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

  it("names an admin tab after the section it belongs to", () => {
    expect(pageTitle("/admin/sessions")).toBe("Admin");
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
