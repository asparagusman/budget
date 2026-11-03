import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils.js";
import { NAV_ITEMS, activeNavItem } from "@/lib/nav.js";
import { useAuth, useSignOut } from "@/lib/auth.jsx";
import { ThemeToggle } from "@/components/theme-toggle.jsx";
import { ScrollArea } from "@/components/scroll-area.jsx";
import { AccountAvatar } from "@/components/shell/account-avatar.jsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet.jsx";

// The sidebar's pill row. `data-touch-target` lifts it to 44px under a
// finger only (styles/app.css) — a fixed 44px on every pointer made the ten
// rows alone taller than a laptop window narrowed to phone width.
const ROW =
  "flex items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)";

/**
 * The phone's navigation: a drawer from the left, opened by the top bar's
 * menu button. It is the desktop sidebar folded away — every NAV_ITEMS
 * entry in the same order with the same active pill, then theme and the
 * account — so the menu someone learned on one screen size is the menu
 * on the other. The bottom bar it replaced pinned four of ten destinations
 * and hid the rest behind "More", which made where a page lived depend on
 * the width of the screen.
 *
 * Like the sidebar, the drawer itself never scrolls: the header and the
 * footer are always in view, and only the page list gives up height, on a
 * screen too short for all ten.
 *
 * @param {{ open: boolean, onOpenChange: (open: boolean) => void }} props
 */
export function MobileNav({ open, onOpenChange }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeTo = activeNavItem(pathname)?.to;
  const { state: authState } = useAuth();
  const user = authState?.user ?? null;
  const signOut = useSignOut();

  const close = () => onOpenChange(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="gap-0 overflow-hidden">
        <SheetHeader className="h-14 shrink-0 flex-row items-center gap-2 px-4 py-0">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-accent-brand text-sm font-bold text-accent-brand-fg">
            B
          </div>
          <SheetTitle className="text-sm font-semibold text-text">Budget</SheetTitle>
          <SheetDescription className="sr-only">Go to another page</SheetDescription>
        </SheetHeader>

        <ScrollArea as="nav" className="mt-2 min-h-0 flex-1">
          <div className="flex flex-col gap-0.5 px-3 py-2">
            {NAV_ITEMS.map((item) => {
              const active = item.to === activeTo;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  data-touch-target
                  onClick={close}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    ROW,
                    active
                      ? "bg-accent-brand-soft text-accent-brand"
                      : "text-text-muted hover:bg-surface-muted hover:text-text",
                  )}
                >
                  <item.icon className="size-4 shrink-0" aria-hidden="true" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </ScrollArea>

        <div className="flex shrink-0 flex-col gap-0.5 border-t border-border p-3">
          <div className="flex items-center justify-between gap-3 px-3">
            <span className="text-sm font-medium text-text-muted">Theme</span>
            <ThemeToggle />
          </div>
          {/* Sign out shares the account's row: it acts on the person named
              beside it, and a row of its own cost the list another 44px. */}
          <div className="flex items-center gap-2 py-1.5 pl-2">
            <AccountAvatar user={user} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text">
                {user?.displayName ?? "Not signed in"}
              </p>
              {user?.email ? (
                <p className="truncate text-xs text-text-subtle">{user.email}</p>
              ) : null}
            </div>
            <button
              type="button"
              data-touch-target
              disabled={!user}
              onClick={() => void signOut()}
              className={cn(
                ROW,
                "shrink-0 text-text-muted hover:bg-surface-muted hover:text-text disabled:opacity-50",
              )}
            >
              Sign out
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
