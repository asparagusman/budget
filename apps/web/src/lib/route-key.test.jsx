import { act, render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { Suspense, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { useRouteKey } from "./route-key.js";

// The router resets scroll on every navigation, and jsdom has no layout to
// scroll.
vi.stubGlobal("scrollTo", () => {});

// The app shell keys its page wrapper on this hook. Keyed on
// `location.pathname` instead, every navigation unmounted and REMOUNTED the
// page being left — its charts, effects and queries — while the next page's
// chunk was still loading, and only then swapped the new page in. That was
// the largest avoidable cost of changing page (perf-inp-plan.md, P1.2).

/** @param {string} name @param {string[]} log */
function tracked(name, log) {
  return function TrackedPage() {
    useEffect(() => {
      log.push(`mount ${name}`);
      return () => {
        log.push(`unmount ${name}`);
      };
    }, []);
    return <p>{name}</p>;
  };
}

/** The shape of AppShell's page wrapper, without the rest of the frame. */
function Shell() {
  const key = useRouteKey();
  return (
    <div key={key}>
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    </div>
  );
}

async function setup() {
  /** @type {string[]} */
  const log = [];
  /** @type {() => void} */
  let releaseChunk = () => {};
  // Page B's chunk resolves only when the test says so, so the window where
  // the router has moved but the new page isn't here yet is observable.
  const chunk = new Promise((resolve) => {
    releaseChunk = () => resolve({ PageB: tracked("B", log) });
  });

  const root = createRootRoute({ component: Shell });
  const pageA = createRoute({
    getParentRoute: () => root,
    path: "/a",
    component: tracked("A", log),
    validateSearch: (search) => ({ on: typeof search.on === "string" ? search.on : undefined }),
  });
  const pageB = createRoute({
    getParentRoute: () => root,
    path: "/b",
    component: lazyRouteComponent(() => chunk, "PageB"),
  });
  const router = createRouter({
    routeTree: root.addChildren([pageA, pageB]),
    history: createMemoryHistory({ initialEntries: ["/a"] }),
  });

  await act(() => router.load());
  render(<RouterProvider router={router} />);
  await screen.findByText("A");
  log.length = 0;

  return { router, log, releaseChunk };
}

describe("useRouteKey", () => {
  it("leaves the outgoing page alone while the next one loads, then swaps once", async () => {
    const { router, log, releaseChunk } = await setup();

    /** @type {Promise<void>} */
    let navigation = Promise.resolve();
    act(() => {
      navigation = router.navigate({ to: "/b" });
    });
    // The router has started moving; the chunk is still in flight.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(log).toEqual([]);

    await act(async () => {
      releaseChunk();
      await navigation;
    });

    expect(await screen.findByText("B")).toBeInTheDocument();
    expect(log).toEqual(["unmount A", "mount B"]);
  });

  it("does not remount the page when only a search param changes", async () => {
    const { router, log } = await setup();

    await act(() => router.navigate({ to: "/a", search: { on: "2026-10-01" } }));

    expect(router.state.location.search).toEqual({ on: "2026-10-01" });
    expect(log).toEqual([]);
  });
});
