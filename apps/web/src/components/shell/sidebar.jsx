import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronsLeft, ChevronsRight, Search } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { NAV_ITEMS } from "@/lib/nav.js";
import { ThemeToggle } from "@/components/theme-toggle.jsx";
import { toggleCommandPalette } from "@/lib/commands.js";

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

/**
 * Desktop-only (`md:` and up) fixed left sidebar: brand, search/command
 * trigger, nav with the active item as a soft tinted pill, then a user block
 * and the theme control pinned to the bottom. Collapsible to icon-only.
 */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

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
      <div className="flex h-16 shrink-0 items-center gap-2 px-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-accent-brand text-sm font-bold text-accent-brand-fg">
          B
        </div>
        {!collapsed && (
          <span className="truncate text-sm font-semibold text-text">
            Budget
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={toggleCommandPalette}
        className={cn(
          "mx-3 flex items-center gap-2 rounded-(--radius-control) bg-surface-muted px-3 py-2 text-sm text-text-muted transition-colors hover:text-text",
          collapsed && "justify-center",
        )}
      >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        {!collapsed && (
          <>
            <span className="flex-1 truncate text-left">Search…</span>
            <kbd className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-text-subtle [@media(pointer:coarse)]:hidden">
              ⌘K
            </kbd>
          </>
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
                "flex items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)",
                active
                  ? "bg-accent-brand-soft text-accent-brand"
                  : "text-text-muted hover:bg-surface-muted hover:text-text",
              )}
            >
              <item.icon className="size-4 shrink-0" aria-hidden="true" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-3 border-t border-border p-3">
        <div className="flex items-center gap-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-medium text-text-muted">
            ?
          </div>
          {!collapsed && (
            <div className="min-w-0">
              {/* Placeholder user block — phase 03 owns real identity. */}
              <p className="truncate text-sm font-medium text-text">
                Operator
              </p>
              <p className="truncate text-xs text-text-subtle">
                Not signed in
              </p>
            </div>
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
