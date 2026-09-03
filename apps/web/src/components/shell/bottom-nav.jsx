import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { MOBILE_PRIMARY_PATHS, NAV_ITEMS } from "@/lib/nav.js";
import { ThemeToggle } from "@/components/theme-toggle.jsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet.jsx";

// Short labels for the five permanent tabs — five columns at 375px is tight,
// and "Fixed Costs" doesn't fit where "Costs" does. The sidebar and command
// palette still use NAV_ITEMS' full label.
/** @type {Record<string, string>} */
const TAB_LABEL = {
  "/costs/fixed": "Costs",
};

const primaryItems = MOBILE_PRIMARY_PATHS.map((path) =>
  NAV_ITEMS.find((item) => item.to === path),
).filter((item) => item !== undefined);

const restItems = NAV_ITEMS.filter(
  (item) => !MOBILE_PRIMARY_PATHS.includes(item.to),
);

/**
 * Bottom navigation with five destinations — Dashboard, Costs, Allocation,
 * Goals, and More, which opens a sheet with everything else. Respects the
 * iOS home-indicator safe area.
 */
export function BottomNav() {
  const [moreOpen, setMoreOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {primaryItems.map((item) => {
          const active = pathname === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "flex flex-1 flex-col items-center gap-1 py-2 text-xs font-medium",
                active ? "text-accent-brand" : "text-text-muted",
              )}
            >
              <item.icon className="size-5" aria-hidden="true" />
              {TAB_LABEL[item.to] ?? item.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className="flex flex-1 flex-col items-center gap-1 py-2 text-xs font-medium text-text-muted"
        >
          <MoreHorizontal className="size-5" aria-hidden="true" />
          More
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
          </SheetHeader>
          <div className="grid grid-cols-3 gap-3 px-4 pb-6">
            {restItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setMoreOpen(false)}
                className="flex flex-col items-center gap-2 rounded-(--radius-card) bg-surface-muted p-4 text-center text-xs font-medium text-text"
              >
                <item.icon className="size-5" aria-hidden="true" />
                {item.label}
              </Link>
            ))}
          </div>
          {/* The theme control's only other home is the desktop sidebar, so
              before this there was no way to change theme on a phone at all
              — the one place the preference matters most. */}
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-4">
            <span className="text-sm font-medium text-text">Theme</span>
            <ThemeToggle />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
