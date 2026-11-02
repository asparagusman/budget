import {
  ArrowLeftRight,
  CalendarDays,
  LayoutDashboard,
  Landmark,
  Receipt,
  ShieldCheck,
  ShoppingBag,
  Target,
  TrendingUp,
  Wallet,
} from "lucide-react";

/** @typedef {{ to: string, label: string, icon: import("lucide-react").LucideIcon, chord: string, section?: string }} NavItem */

// The single source of truth for every navigable destination — the desktop
// sidebar, the mobile menu drawer, and the command palette's Navigation group
// all render from this list rather than each hand-rolling their own copy.
// `chord` is the letter that follows a `g` chord press (see
// command-palette.jsx) — chosen for uniqueness, not always the first letter
// of the label, since several labels collide on that. `section` is set only
// where the entry's pages live under a different prefix than `to` itself
// (see activeNavItem).
/** @type {NavItem[]} */
export const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, chord: "d" },
  { to: "/income", label: "Income", icon: Wallet, chord: "i" },
  { to: "/costs/fixed", label: "Fixed Costs", icon: Receipt, chord: "f" },
  { to: "/costs/variable", label: "Variable Costs", icon: ShoppingBag, chord: "v" },
  { to: "/allocation", label: "Allocation", icon: ArrowLeftRight, chord: "l" },
  // "t" for Target (its icon) — "g" is taken by the chord prefix itself, so
  // "g g" would be a confusing (if technically working) way to say "Goals".
  { to: "/goals", label: "Goals", icon: Target, chord: "t" },
  { to: "/projections", label: "Projections", icon: TrendingUp, chord: "p" },
  { to: "/calendar", label: "Calendar", icon: CalendarDays, chord: "c" },
  { to: "/accounts", label: "Accounts", icon: Landmark, chord: "a" },
  // The old "Settings" entry, renamed to what it always was: user and
  // household administration. Pay schedules moved out to /income (they are
  // income, not admin) and the theme preference moved into the sidebar's
  // Settings dropdown, which is a menu rather than a destination — so
  // nothing in NAV_ITEMS points at /settings any more. "m" for adMin: "a"
  // is Accounts and "s" no longer names a page.
  { to: "/admin/users", label: "Admin", icon: ShieldCheck, chord: "m", section: "/admin" },
];

// Routes that are deliberately NOT in NAV_ITEMS but still need a name in the
// mobile top bar: a one-time tool and a drill-down. Without these the bar
// falls back to "Budget" and the operator loses their place. The dev gallery
// exists only in a dev build (see router.jsx), so its title does too.
/** @type {[string, string][]} */
const EXTRA_TITLES = [
  ["/import", "Import"],
  ["/costs/fixed/", "Bill history"],
  ...(import.meta.env.DEV ? /** @type {[string, string][]} */ ([["/dev/charts", "Charts"]]) : []),
];

/**
 * The name of the screen at `pathname`, for the mobile top bar.
 *
 * @param {string} pathname
 */
export function pageTitle(pathname) {
  const navItem = NAV_ITEMS.find((item) => item.to === pathname);
  if (navItem) return navItem.label;
  return (
    EXTRA_TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ??
    activeNavItem(pathname)?.label ??
    "Budget"
  );
}

/**
 * The nav entry `pathname` belongs to: its own page, or a page beneath it —
 * a bill's history under Fixed Costs, any admin tab under Admin. Exact
 * matching alone left those pages highlighting nothing in the sidebar and
 * the mobile menu, which is exactly when someone needs telling where they
 * are. "/" only ever matches itself, since every path starts with it.
 *
 * @param {string} pathname
 */
export function activeNavItem(pathname) {
  const exact = NAV_ITEMS.find((item) => item.to === pathname);
  if (exact) return exact;
  return NAV_ITEMS.find((item) => {
    const base = item.section ?? item.to;
    // A section's own root ("/admin") counts too: it is never a page of its
    // own, only a redirect into its first tab, but the bar can see it for
    // the moment before the redirect lands.
    return base !== "/" && (pathname === base || pathname.startsWith(`${base}/`));
  });
}
