import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  LogOut,
  Settings as SettingsIcon,
} from "lucide-react";
import { cn } from "@/lib/utils.js";
import { NAV_ITEMS, activeNavItem } from "@/lib/nav.js";
import { ThemeMenuItems } from "@/components/theme-toggle.jsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.jsx";
import { useAuth, useSignOut } from "@/lib/auth.jsx";
import { AccountAvatar } from "@/components/shell/account-avatar.jsx";
import { ScrollArea } from "@/components/scroll-area.jsx";

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
//
// Rows never switch to `justify-center` when collapsed. That switch lands
// in one frame while the label is still full width, so the icon was
// centred together with its label — thrown toward the middle of the
// row — and then slid back as the label shrank. Instead every row stays
// left-aligned and its padding puts the icon on the collapsed column's
// centre line (36px of 4.5rem) in BOTH states, so the icon never moves.
// The icon-to-label gap is the label's own margin, so it animates out with
// the label instead of snapping.
const LABEL = "overflow-hidden whitespace-nowrap transition-[opacity,max-width,margin] duration-150";
/**
 * @param {boolean} collapsed
 * @param {"ml-2" | "ml-3"} [gap] the icon-to-label gap while expanded
 */
function labelClass(collapsed, gap = "ml-3") {
  return collapsed ? "ml-0 max-w-0 opacity-0" : cn(gap, "max-w-48 opacity-100");
}

// The bottom cluster's three rows (Settings, collapse, account) borrow the
// nav pill's shape so the whole column reads as one list rather than as a
// nav plus a footer of loose controls.
// px-4 inside the column's p-3: 12 + 16 = 28px to a 16px icon, centred on 36.
const ROW = cn(
  "flex items-center rounded-full px-4 py-2 text-sm font-medium text-text-muted transition-colors",
  "hover:bg-surface-muted hover:text-text",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)",
);

/**
 * Desktop-only (`md:` and up) fixed left sidebar: brand, nav with the active item as a soft tinted pill, then a bottom
 * cluster of Settings (a menu carrying the theme preference), the collapse
 * toggle, and the account — which is a menu too, and holds Sign out.
 * Collapsible to icon-only, with the labels fading as the width transitions.
 */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeTo = activeNavItem(pathname)?.to;
  const { state: authState } = useAuth();
  const user = authState?.user ?? null;
  const signOut = useSignOut();

  useEffect(() => {
    writeCollapsed(collapsed);
  }, [collapsed]);

  return (
    <aside
      className={cn(
        // `h-full` inside a frame that is already exactly one viewport tall,
        // not `sticky h-screen`: the shell no longer scrolls, so there is
        // nothing to stick to and nothing to scroll away from.
        "hidden h-full shrink-0 flex-col overflow-hidden border-r border-border bg-surface transition-[width] duration-150 md:flex",
        collapsed ? "w-[4.5rem]" : "w-64",
      )}
    >
      {/* px-5 puts the 32px mark at 20–52px: centred on 36 at both widths. */}
      <div className="flex h-16 shrink-0 items-center px-5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-accent-brand text-sm font-bold text-accent-brand-fg">
          B
        </div>
        <span className={cn(LABEL, labelClass(collapsed, "ml-2"), "text-sm font-semibold text-text")}>
          Budget
        </span>
      </div>

      {/* The column itself never scrolls: brand and the bottom
          cluster are always in view. Only this list can, and only on a
          window too short to hold all ten — min-h-0 is what lets it give up
          height instead of pushing the account off the bottom. */}
      <ScrollArea as="nav" className="mt-2 min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-3 py-2">
          {NAV_ITEMS.map((item) => {
            const active = item.to === activeTo;
            return (
              <Link
                key={item.to}
                to={item.to}
                title={collapsed ? item.label : undefined}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center rounded-full px-4 py-2 text-sm font-medium transition-colors",
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
        </div>
      </ScrollArea>

      {/* Settings, then collapse, then the account — controls first and
          identity last, with the account pinned to the very bottom. */}
      <div className="flex shrink-0 flex-col gap-0.5 border-t border-border p-3">
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
              className={ROW}
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
          className={ROW}
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
                // px-2: the column's inner width is 3rem, so 0.5rem either
                // side of the 2rem avatar fills it exactly when collapsed —
                // and the avatar sits at 20–52px, centred on 36, either way.
                "mt-1 flex items-center rounded-full px-2 py-1.5 transition-colors hover:bg-surface-muted",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)",
              )}
            >
              <AccountAvatar user={user} />
              <div className={cn(LABEL, labelClass(collapsed, "ml-2"), "min-w-0 flex-1 text-left")}>
                <p className="truncate text-sm font-medium text-text">
                  {user?.displayName ?? "Not signed in"}
                </p>
                <p className="truncate text-xs text-text-subtle">
                  {user?.email ?? ""}
                </p>
              </div>
              {!collapsed && (
                <ChevronsUpDown className="ml-2 size-4 shrink-0 text-text-subtle" aria-hidden="true" />
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
