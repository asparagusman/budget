import { Suspense, useEffect } from "react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { FileSpreadsheetIcon } from "lucide-react";
import { Sidebar } from "@/components/shell/sidebar.jsx";
import { TopBar } from "@/components/shell/topbar.jsx";
import { BottomNav } from "@/components/shell/bottom-nav.jsx";
import { Skeleton } from "@/components/ui/skeleton.jsx";
import { registerCommands } from "@/lib/commands.js";

/**
 * What shows while a route's chunk is in flight. Deliberately the shape of a
 * page — a heading bar and two cards — rather than a spinner, so the frame
 * doesn't collapse and re-expand as the real page lands. That collapse is
 * the layout shift the phase's "No layout shift after first paint" line is
 * about.
 */
function RouteFallback() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading page</span>
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/**
 * The application frame every route renders inside: sidebar on desktop, top
 * bar + bottom nav on mobile, and a centred content column in between. The
 * page body never scrolls horizontally — a wide table or chart gets its own
 * `overflow-x: auto` container instead.
 */
export function AppShell() {
  // Keyed on the pathname so the entrance animation replays per navigation
  // and *only* per navigation — a re-render from a settled query must not
  // re-fade the page the operator is reading.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();

  // /import is not in NAV_ITEMS (a one-time migration tool does not earn a
  // permanent nav slot), so the palette entry is registered from the shell
  // rather than from the page — a command you can only find once you are
  // already on the page is not a command.
  useEffect(
    () =>
      registerCommands([
        {
          id: "import:spreadsheet",
          group: "Actions",
          label: "Import a spreadsheet",
          keywords: "xlsx excel migrate workbook",
          icon: FileSpreadsheetIcon,
          run: () => navigate({ to: "/import" }),
        },
      ]),
    [navigate],
  );

  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {/* pb-20 clears the fixed bottom nav on mobile; the extra
            safe-area inset clears the iOS home indicator underneath it. */}
        <main className="flex-1 px-4 pt-4 pb-[calc(5rem+env(safe-area-inset-bottom))] md:px-8 md:pt-8 md:pb-8">
          <div className="mx-auto w-full max-w-6xl">
            <div
              key={pathname}
              data-motion="route-enter"
              className="flex w-full min-w-0 animate-route-enter flex-col gap-6"
            >
              <Suspense fallback={<RouteFallback />}>
                <Outlet />
              </Suspense>
            </div>
          </div>
        </main>
      </div>
      <BottomNav />
    </div>
  );
}
