import { useEffect, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  LogOut,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { cn } from "@/lib/utils.js";
import { NAV_ITEMS } from "@/lib/nav.js";
import { ThemeMenuItems } from "@/components/theme-toggle.jsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.jsx";
import { toggleCommandPalette } from "@/lib/commands.js";
import { api } from "@/lib/api.js";
import { useAuth } from "@/lib/auth.jsx";

/** @param {string} name */
function initials(name) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase() || "?";
}

const STORAGE_KEY = "budget:sidebar-collapsed";

function readCollapsed() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** @param {boolean} collapsed */
function writeCollapsed(collapsed) {
  try {
    localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // Private window or blocked storage — the preference just won't survive
    // this session.
  }
}

// Collapsing animates two things at once: the aside's width, and each
// label's own width and opacity. Labels are kept MOUNTED at zero width
// rather than conditionally rendered — a conditional render pops, and it
// would also strip the accessible name off every collapsed nav link, since
// the icon is aria-hidden and the text is all a screen reader has.
const LABEL = "overflow-hidden whitespace-nowrap transition-[opacity,max-width] duration-150";
/** @param {boolean} collapsed */
function labelClass(collapsed) {
  return collapsed ? "max-w-0 opacity-0" : "max-w-48 opacity-100";
}

// The bottom cluster's three rows (Settings, collapse, account) borrow the
// nav pill's shape so the whole column reads as one list rather than as a
// nav plus a footer of loose controls.
/** @param {boolean} collapsed */
function rowClass(collapsed) {
  return cn(
    "flex items-center rounded-full px-3 py-2 text-sm font-medium text-text-muted transition-colors",
    "hover:bg-surface-muted hover:text-text",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)",
    collapsed ? "justify-center gap-0" : "gap-3",
  );
}

/**
 * Desktop-only (`md:` and up) fixed left sidebar: brand, search/command
 * trigger, nav with the active item as a soft tinted pill, then a bottom
 * cluster of Settings (a menu carrying the theme preference), the collapse
 * toggle, and the account — which is a menu too, and holds Sign out.
 * Collapsible to icon-only, with the labels fading as the width transitions.
 */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const { state: authState, refresh } = useAuth();
  const user = authState?.user ?? null;

  async function signOut() {
    await api.auth.logout.$post();
    await refresh();
    navigate({ to: "/login", replace: true });
  }

  useEffect(() => {
    writeCollapsed(collapsed);
  }, [collapsed]);

  return (
    <aside
      className={cn(
        // `h-full` inside a frame that is already exactly one viewport tall,
        // not `sticky h-screen`: the shell no longer scrolls, so there is
        // nothing to stick to and nothing to scroll away from.
        "hidden h-full shrink-0 flex-col overflow-y-auto border-r border-border bg-surface transition-[width] duration-150 md:flex",
        collapsed ? "w-[4.5rem]" : "w-64",
      )}
    >
      {/* gap collapses along with the labels — a surviving gap next to a
          zero-width label pushes every icon a few pixels off centre. */}
      <div className={cn("flex h-16 shrink-0 items-center px-4", collapsed ? "justify-center gap-0 px-0" : "gap-2")}>
        <div className="flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-accent-brand text-sm font-bold text-accent-brand-fg">
          B
        </div>
        <span className={cn(LABEL, labelClass(collapsed), "text-sm font-semibold text-text")}>
          Budget
        </span>
      </div>

      <button
        type="button"
        onClick={toggleCommandPalette}
        className={cn(
          "mx-3 flex items-center rounded-(--radius-control) bg-surface-muted px-3 py-2 text-sm text-text-muted transition-colors hover:text-text",
          collapsed ? "justify-center gap-0" : "gap-2",
        )}
      >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <span className={cn(LABEL, labelClass(collapsed), "flex-1 text-left")}>Search…</span>
        {!collapsed && (
          <kbd className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-text-subtle [@media(pointer:coarse)]:hidden">
            ⌘K
          </kbd>
        )}
      </button>

      <nav className="mt-2 flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              title={collapsed ? item.label : undefined}
              className={cn(
                "flex items-center rounded-full px-3 py-2 text-sm font-medium transition-colors",
                collapsed ? "justify-center gap-0" : "gap-3",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)",
                active
                  ? "bg-accent-brand-soft text-accent-brand"
                  : "text-text-muted hover:bg-surface-muted hover:text-text",
              )}
            >
              <item.icon className="size-4 shrink-0" aria-hidden="true" />
              <span className={cn(LABEL, labelClass(collapsed))}>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Settings, then collapse, then the account — controls first and
          identity last, with the account pinned to the very bottom. */}
      <div className="flex flex-col gap-0.5 border-t border-border p-3">
        {/* Settings is a menu, not a destination. The only thing in it is a
            preference, and a route that exists to hold one radio group is a
            route the operator has to leave the screen they were reading to
            reach. Everything that IS a destination — users, devices,
            sessions, invites, people — is the Admin item in the nav above. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={collapsed ? "Settings" : undefined}
              className={rowClass(collapsed)}
            >
              <SettingsIcon className="size-4 shrink-0" aria-hidden="true" />
              <span className={cn(LABEL, labelClass(collapsed))}>Settings</span>
            </button>
          </DropdownMenuTrigger>
          {/* Flies out to the right rather than up: at the bottom of a
              full-height column there is nothing above the trigger to open
              into. Explicit width because the shared content class sizes
              itself from the trigger, which is 4.5rem wide when collapsed. */}
          <DropdownMenuContent side="right" align="end" className="w-48">
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <ThemeMenuItems />
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? "Expand sidebar" : undefined}
          className={rowClass(collapsed)}
        >
          {collapsed ? (
            <ChevronsRight className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronsLeft className="size-4 shrink-0" aria-hidden="true" />
          )}
          {/* Kept mounted at zero width like every other label, so the
              collapsed button still has an accessible name. */}
          <span className={cn(LABEL, labelClass(collapsed))}>
            {collapsed ? "Expand sidebar" : "Collapse sidebar"}
          </span>
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={collapsed ? (user?.displayName ?? "Account") : undefined}
              className={cn(
                "mt-1 flex items-center rounded-full py-1.5 transition-colors hover:bg-surface-muted",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)",
                // No horizontal padding when collapsed: the avatar is 2rem
                // and the column's inner width is 3rem, so padding either
                // side would not fit.
                collapsed ? "justify-center gap-0 px-0" : "gap-2 px-2",
              )}
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-brand-soft text-xs font-medium text-accent-brand">
                {user ? initials(user.displayName) : "?"}
              </div>
              <div className={cn(LABEL, labelClass(collapsed), "min-w-0 flex-1 text-left")}>
                <p className="truncate text-sm font-medium text-text">
                  {user?.displayName ?? "Not signed in"}
                </p>
                <p className="truncate text-xs text-text-subtle">
                  {user?.email ?? ""}
                </p>
              </div>
              {!collapsed && (
                <ChevronsUpDown className="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="w-56">
            {/* Guarded on the email itself, not on `user`: an account with
                no email address rendered an empty label and a separator
                above nothing. */}
            {user?.email ? (
              <>
                <DropdownMenuLabel className="truncate">{user.email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem disabled={!user} onSelect={() => void signOut()}>
              <LogOut aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
