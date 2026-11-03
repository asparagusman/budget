import { Suspense, startTransition, useEffect, useRef, useState } from "react";
import { Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { FileSpreadsheetIcon, HouseIcon } from "lucide-react";
import { WaitingDevicesNotice } from "@/components/device-approvals.jsx";
import { Sidebar } from "@/components/shell/sidebar.jsx";
import { TopBar } from "@/components/shell/topbar.jsx";
import { RouteSkeleton } from "@/components/route-skeletons.jsx";
import { ScrollArea } from "@/components/scroll-area.jsx";
import { cn } from "@/lib/utils.js";
import { registerCommands } from "@/lib/commands.js";
import { pageWidthClass } from "@/lib/page-width.js";
import { useRouteKey } from "@/lib/route-key.js";

/**
 * Shows `fallback` for one painted frame, then renders `children` as a
 * transition.
 *
 * Drawing a page is most of what a click costs — the chunk and usually the
 * data are already in from the hover — and while React renders it the
 * browser can paint nothing. Rendering it in the same commit as the click
 * left the page being LEFT frozen on screen for that whole time (0.5–0.9s on
 * the dev server for Projections or Goals), with no sign the click had
 * registered; the skeletons inside the pages never got a frame. So the shell
 * commits the next page's skeleton first, lets it paint, and only then starts
 * on the page — as a transition, so React renders it in slices and a second
 * click mid-render is taken straight away instead of queueing behind it.
 *
 * Mounted once per page (it sits inside the per-page key), so a re-render of
 * the same page never drops back to the skeleton.
 *
 * @param {{ fallback: import("react").ReactNode, children: import("react").ReactNode }} props
 */
function PaintFirst({ fallback, children }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let timer = 0;
    // A rAF callback runs just before the frame that paints the skeleton; a
    // task queued from inside it runs after that frame. A bare timeout can
    // land before the paint, and then the page renders first after all.
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => startTransition(() => setReady(true)));
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, []);

  return ready ? children : fallback;
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
  const router = useRouter();
  // The leaf match's pathname, not `location.pathname`: like the key, it
  // changes in the same commit as the page, so the column doesn't resize
  // under the page being left.
  const pathname = useRouterState({ select: (state) => state.matches.at(-1)?.pathname ?? "/" });
  // Which page's skeleton to paint: the route's own path (`/costs/fixed`),
  // not the URL, so every bill's history page is one entry.
  const routePath = useRouterState({
    select: (state) => /** @type {string | undefined} */ (state.matches.at(-1)?.fullPath),
  });
  const scrollerRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  // <main>'s viewport is the scroller, so a navigation has to reset it, not
  // the window — otherwise the next page opens halfway down at the previous
  // page's offset. On the same key as the wrapper, so the reset lands with
  // the new page rather than scrolling the old one to the top first.
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [routeKey]);

  // Every page's code, downloaded once the app has gone quiet. Hover-preload
  // (router.jsx) only helps a pointer: a tap on a phone, a `g` chord or a
  // palette entry has no hover to get ahead of, and each paid for its chunk
  // on the click. The chunks are small and cached for the session, so
  // fetching them all once is cheaper than waiting on any one of them. Code
  // only — data stays on hover and mount (see lib/queries.js).
  useEffect(() => {
    const preloadAll = () => {
      for (const route of Object.values(router.routesById)) {
        // A failure here costs nothing: the real navigation retries it.
        route.options.component?.preload?.().catch(() => {});
      }
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(preloadAll, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    // Safari before 18.2 has no requestIdleCallback.
    const id = window.setTimeout(preloadAll, 1500);
    return () => window.clearTimeout(id);
  }, [router]);

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

            The safe-area inset clears the iOS home indicator on mobile.

            <PageHeader> pulls itself out over the top and side padding with
            matching negative margins, so a change here has to be made there
            too. */}
        <ScrollArea
          as="main"
          className="min-h-0 flex-1"
          viewportClassName="overscroll-contain"
          viewportRef={scrollerRef}
        >
          <div className="px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-8 md:pt-8 md:pb-8">
            <div className={cn("mx-auto w-full", pageWidthClass(pathname))}>
              {/* Outside the keyed route block, so it doesn't replay the
                  page's entrance on every poll or flash between routes. */}
              <WaitingDevicesNotice />
              <div
                key={routeKey}
                data-motion="route-enter"
                // The gap between a page's top-level blocks. A heading and the
                // content it names sit much closer than this (see
                // <PageSection>), so the two intervals read as "same group"
                // and "next group" rather than one even drip of 24px.
                className="flex w-full min-w-0 animate-route-enter flex-col gap-6 md:gap-8"
              >
                <PaintFirst fallback={<RouteSkeleton path={routePath} />}>
                  {/* Still needed for a chunk that isn't in yet: a tap with
                      no hover before the idle preload has finished. */}
                  <Suspense fallback={<RouteSkeleton path={routePath} />}>
                    <Outlet />
                  </Suspense>
                </PaintFirst>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
