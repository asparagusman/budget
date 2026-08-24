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
  // Phase 03 only builds the users/devices/sessions/invites surface — a
  // later phase may grow a general /settings landing page with this as one
  // tab among others; until then this nav entry points straight at it.
  { to: "/settings/users", label: "Settings", icon: SettingsIcon, phase: "03", chord: "s" },
];

// The five destinations that get a permanent slot in the mobile bottom nav.
// Everything else in NAV_ITEMS surfaces through the "More" sheet.
export const MOBILE_PRIMARY_PATHS = ["/", "/costs/fixed", "/allocation", "/goals"];
