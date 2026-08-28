import { useEffect, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronsLeft, ChevronsRight, LogOut, Search } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { NAV_ITEMS } from "@/lib/nav.js";
import { ThemeToggle } from "@/components/theme-toggle.jsx";
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

/**
 * Desktop-only (`md:` and up) fixed left sidebar: brand, search/command
 * trigger, nav with the active item as a soft tinted pill, then a user block
 * and the theme control pinned to the bottom. Collapsible to icon-only,
 * with the labels fading as the width transitions.
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
        "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150 md:flex",
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

      <div className="flex flex-col gap-3 border-t border-border p-3">
        <div className={cn("flex items-center", collapsed ? "justify-center gap-0" : "gap-2")}>
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-brand-soft text-xs font-medium text-accent-brand">
            {user ? initials(user.displayName) : "?"}
          </div>
          <div className={cn(LABEL, labelClass(collapsed), "min-w-0 flex-1")}>
            <p className="truncate text-sm font-medium text-text">
              {user?.displayName ?? "Not signed in"}
            </p>
            <p className="truncate text-xs text-text-subtle">
              {user?.email ?? ""}
            </p>
          </div>
          {!collapsed && user && (
            <button
              type="button"
              onClick={signOut}
              title="Sign out"
              aria-label="Sign out"
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-muted hover:text-text"
            >
              <LogOut className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <div
          className={cn(
            "flex items-center",
            collapsed ? "justify-center" : "justify-between",
          )}
        >
          {!collapsed && <ThemeToggle />}
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-muted hover:text-text"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <ChevronsRight className="size-4" aria-hidden="true" />
            ) : (
              <ChevronsLeft className="size-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}
