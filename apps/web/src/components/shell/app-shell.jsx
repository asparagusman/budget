import { Suspense, useEffect, useRef } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { FileSpreadsheetIcon, HouseIcon } from "lucide-react";
import { Sidebar } from "@/components/shell/sidebar.jsx";
import { TopBar } from "@/components/shell/topbar.jsx";
import { Skeleton } from "@/components/ui/skeleton.jsx";
import { ScrollArea } from "@/components/scroll-area.jsx";
import { registerCommands } from "@/lib/commands.js";
import { useRouteKey } from "@/lib/route-key.js";

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
 * bar (with its menu drawer) on mobile, and a centred content column. The
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
  // Keyed per page so the entrance animation replays per navigation and
  // *only* per navigation — a re-render from a settled query must not re-fade
  // the page the operator is reading. The key is the route match, not the
  // pathname: see useRouteKey for why the pathname remounted the page being
  // LEFT on every click.
  const routeKey = useRouteKey();
  const navigate = useNavigate();
  const scrollerRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  // <main>'s viewport is the scroller, so a navigation has to reset it, not
  // the window — otherwise the next page opens halfway down at the previous
  // page's offset. On the same key as the wrapper, so the reset lands with
  // the new page rather than scrolling the old one to the top first.
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [routeKey]);

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
        // Goals' second tab isn't in NAV_ITEMS either — Goals is the entry —
        // but it's the screen someone comes back to ask "can we afford it
        // yet?", so it's one palette search away from anywhere.
        {
          id: "goals:house",
          group: "Navigation",
          label: "Buying a house",
          keywords: "house home mortgage deposit stamp duty scenarios help to buy",
          icon: HouseIcon,
          run: () => navigate({ to: "/goals/house" }),
        },
      ]),
    [navigate],
  );

  return (
    <div className="flex h-dvh overflow-hidden bg-bg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        {/* The app's one scroll container. Its scrollbar is an overlay, so
            a short page and a long one put their content in the same place
            with no gutter to reserve.

            The safe-area inset clears the iOS home indicator on mobile. */}
        <ScrollArea
          as="main"
          className="min-h-0 flex-1"
          viewportClassName="overscroll-contain"
          viewportRef={scrollerRef}
        >
          <div className="px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-8 md:pt-8 md:pb-8">
            <div className="mx-auto w-full max-w-6xl">
              <div
                key={routeKey}
                data-motion="route-enter"
                // The gap between a page's top-level blocks. A heading and the
                // content it names sit much closer than this (see
                // <PageSection>), so the two intervals read as "same group"
                // and "next group" rather than one even drip of 24px.
                className="flex w-full min-w-0 animate-route-enter flex-col gap-6 md:gap-8"
              >
                <Suspense fallback={<RouteFallback />}>
                  <Outlet />
                </Suspense>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
