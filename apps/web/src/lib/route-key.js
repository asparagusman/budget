import { useRouterState } from "@tanstack/react-router";

/**
 * A key that changes exactly when the page on screen does — for keying the
 * app shell's page wrapper (entrance animation, scroll reset) per navigation.
 *
 * It is the leaf route MATCH, not `location.pathname`. The router updates
 * `location` at the START of a navigation, before the next page's chunk and
 * data have arrived, while `<Outlet>` is still rendering the page being left.
 * A wrapper keyed on the pathname therefore changed key first, and React
 * threw the outgoing page away and mounted it again — every chart, effect and
 * query on it — before swapping the new page in. The leaf match changes in
 * the same commit as the page itself, so a navigation mounts once
 * (.claude/plans/perf-inp-plan.md, P1.2; pinned by route-key.test.jsx).
 *
 * Not `resolvedLocation` either: that updates only after the new page has
 * committed, which mounts the NEW page twice instead.
 *
 * A match id is the route plus its path params, so `/costs/fixed/a/history`
 * → `/costs/fixed/b/history` is a new page, and a search-param change (the
 * dashboard's `?on=`, the allocation `?plan=`) is not — the same as the
 * pathname key it replaces.
 */
export function useRouteKey() {
  return useRouterState({ select: (state) => state.matches.at(-1)?.id });
}
