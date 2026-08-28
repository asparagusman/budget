import {
  ArrowLeftRight,
  CalendarDays,
  LayoutDashboard,
  Landmark,
  Receipt,
  Settings as SettingsIcon,
  ShoppingBag,
  Target,
  TrendingUp,
  Wallet,
} from "lucide-react";

/** @typedef {{ to: string, label: string, icon: import("lucide-react").LucideIcon, phase: string, chord: string }} NavItem */

// The single source of truth for every navigable destination — the desktop
// sidebar, the mobile bottom nav + "More" sheet, and the command palette's
// Navigation group all render from this list rather than each hand-rolling
// their own copy. `chord` is the letter that follows a `g` chord press
// (see command-palette.jsx) — chosen for uniqueness, not always the first
// letter of the label, since several labels collide on that.
/** @type {NavItem[]} */
export const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, phase: "10", chord: "d" },
  { to: "/income", label: "Income", icon: Wallet, phase: "05", chord: "i" },
  { to: "/costs/fixed", label: "Fixed Costs", icon: Receipt, phase: "06", chord: "f" },
  { to: "/costs/variable", label: "Variable Costs", icon: ShoppingBag, phase: "07", chord: "v" },
  { to: "/allocation", label: "Allocation", icon: ArrowLeftRight, phase: "08", chord: "l" },
  // "t" for Target (its icon) — "g" is taken by the chord prefix itself, so
  // "g g" would be a confusing (if technically working) way to say "Goals".
  { to: "/goals", label: "Goals", icon: Target, phase: "09", chord: "t" },
  { to: "/projections", label: "Projections", icon: TrendingUp, phase: "09", chord: "p" },
  { to: "/calendar", label: "Calendar", icon: CalendarDays, phase: "06", chord: "c" },
  { to: "/accounts", label: "Accounts", icon: Landmark, phase: "04", chord: "a" },
  // /settings/users is one of six tabs on the same Settings page (phase 03's
  // Users/Devices/Sessions/Invites, phase 04's People and Pay schedules) —
  // this nav entry just points at the first one; see settings-page.jsx.
  { to: "/settings/users", label: "Settings", icon: SettingsIcon, phase: "03", chord: "s" },
];

// Routes that are deliberately NOT in NAV_ITEMS but still need a name in the
// mobile top bar: a one-time tool and a drill-down. Without these the bar
// falls back to "Budget" and the operator loses their place.
/** @type {[string, string][]} */
const EXTRA_TITLES = [
  ["/import", "Import"],
  ["/costs/fixed/", "Bill history"],
  ["/dev/charts", "Charts"],
];

/**
 * The name of the screen at `pathname`, for the mobile top bar.
 *
 * @param {string} pathname
 */
export function pageTitle(pathname) {
  const navItem = NAV_ITEMS.find((item) => item.to === pathname);
  if (navItem) return navItem.label;
  return EXTRA_TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? "Budget";
}

// The five destinations that get a permanent slot in the mobile bottom nav.
// Everything else in NAV_ITEMS surfaces through the "More" sheet.
export const MOBILE_PRIMARY_PATHS = ["/", "/costs/fixed", "/allocation", "/goals"];
