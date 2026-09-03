import { Suspense, useEffect, useRef } from "react";
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
 *
 * The frame is exactly one viewport tall and does not scroll; `<main>` is the
 * only scroller in the app. That makes the sidebar and top bar fixed by
 * construction rather than by `position: sticky`, and it is also what stops
 * every portal open/close from shifting the layout — see the "who scrolls"
 * note in styles/app.css for why those are the same fact.
 */
export function AppShell() {
  // Keyed on the pathname so the entrance animation replays per navigation
  // and *only* per navigation — a re-render from a settled query must not
  // re-fade the page the operator is reading.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const mainRef = useRef(/** @type {HTMLElement | null} */ (null));

  // <main> is the scroller now, so a navigation has to reset <main>, not the
  // window — otherwise the next page opens halfway down at the previous
  // page's offset.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

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
    <div className="flex h-dvh overflow-hidden bg-bg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        {/* The app's one scroll container. `scrollbar-gutter: stable`
            reserves the track whether or not this page overflows, so a short
            page and a long one put their content in the same place.

            pb-20 clears the fixed bottom nav on mobile; the extra safe-area
            inset clears the iOS home indicator underneath it. */}
        <main
          ref={mainRef}
          className="flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-[calc(5rem+env(safe-area-inset-bottom))] [scrollbar-gutter:stable] md:px-8 md:pt-8 md:pb-8"
        >
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
