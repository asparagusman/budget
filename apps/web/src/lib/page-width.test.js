import { describe, expect, it } from "vitest";
import { pageWidthClass } from "./page-width.js";

const WIDE = "max-w-[96rem]";
const NARROW = "max-w-6xl";

// The shell decides the content width from the pathname alone. A page that
// lands on the wrong side is silent: a form stretched across the screen, or a
// table scrolling sideways inside a 1152px column.

describe("pageWidthClass", () => {
  it.each([
    "/",
    "/income",
    "/costs/fixed",
    "/costs/variable",
    "/allocation",
    "/goals",
    "/goals/house",
    "/projections",
    "/calendar",
    "/accounts",
  ])("gives %s the wide column", (path) => {
    expect(pageWidthClass(path)).toBe(WIDE);
  });

  it.each([
    "/admin",
    "/admin/users",
    "/import",
    "/costs/fixed/abc/history",
    "/no/such/page",
    "/incomes",
    "/goalsfoo",
  ])("keeps %s at the default column", (path) => {
    expect(pageWidthClass(path)).toBe(NARROW);
  });

  it("ignores a trailing slash", () => {
    expect(pageWidthClass("/income/")).toBe(WIDE);
    expect(pageWidthClass("/admin/users/")).toBe(NARROW);
  });
});
