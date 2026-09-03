import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/shell/app-shell.jsx";
import { CommandPalette } from "@/components/command-palette.jsx";
import { AuthLayout } from "@/components/shell/auth-layout.jsx";
import { ErrorScreen } from "@/components/error-screen.jsx";
import { PlaceholderPage } from "@/routes/placeholder-page.jsx";
import { LoginPage } from "@/routes/login-page.jsx";
import { InvitePage } from "@/routes/invite-page.jsx";
import { RecoveryPage } from "@/routes/recovery-page.jsx";
import { NAV_ITEMS } from "@/lib/nav.js";
import { ensureAuthState, invalidateAuthState } from "@/lib/auth.jsx";

// Every authenticated page is code-split. Route-level splitting is the whole
// of phase 11's performance story: the dashboard should not pay to download
// the allocation editor, the importer or (through any of them) the charting
// library (phases/11-polish-mobile-import.md, workstream B "Performance").
//
// `lazyRouteComponent` rather than a bare `React.lazy` because the router
// then knows how to *preload* a route — hovering a sidebar link starts the
// fetch, so by the time the click lands the chunk is usually already there
// — and it reloads the page rather than white-screening when a chunk 404s
// after a redeploy.
//
// /login and /invite/$code stay eager on purpose: they are the first paint
// for anyone without a session, and a spinner in front of a login form to
// save bytes the user is about to need anyway is a bad trade.
/**
 * @template {Record<string, unknown>} T
 * @param {() => Promise<T>} importer
 * @param {keyof T & string} exportName
 */
function page(importer, exportName) {
  return lazyRouteComponent(importer, exportName);
}

// The palette lives here rather than beside <RouterProvider> in main.jsx
// because it navigates: `useNavigate()` and the `g`-chord handler both need
// the router context, and outside it every entry threw
// "Cannot read properties of null (reading 'navigate')". Mounted on the root
// route, so it is still reachable from /login and /invite/$code exactly as it
// was — the routes themselves decide what a logged-out visitor may reach.
const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <CommandPalette />
    </>
  ),
  // Without this, anything a route's `beforeLoad`/loader threw escaped the
  // tree entirely: the router logged "The following error wasn't caught by
  // any route!" and the user got a white screen. Both auth guards below call
  // `ensureAuthState()`, so an api that isn't up yet took every route down
  // this path — the single most likely failure in local dev had no UI at all.
  errorComponent: RouteError,
});

/**
 * @param {{ error: unknown, reset: () => void }} props
 */
function RouteError({ error, reset }) {
  const router = useRouter();
  return (
    <ErrorScreen
      error={error}
      onRetry={() => {
        // Clear the cached auth rejection before re-running the guards, or
        // `invalidate()` just replays the same failure (see lib/auth.jsx).
        invalidateAuthState();
        reset();
        return router.invalidate();
      }}
    />
  );
}

// Everything that renders inside the authenticated app shell (sidebar +
// nav). A pathless layout route rather than part of rootRoute itself, so
// /login and /invite/$code (authLayoutRoute below) can render a completely
// different, sidebar-less frame instead.
const appLayoutRoute = createRoute({
  id: "app-layout",
  getParentRoute: () => rootRoute,
  component: AppShell,
  beforeLoad: async () => {
    const state = await ensureAuthState();
    if (state.needsBootstrap || !state.user) {
      throw redirect({ to: "/login" });
    }
    // A recovery-password session can reach none of the API behind this
    // shell, so rendering it would be a screen of 403s. Send it to the one
    // screen it can use instead (see /recovery, and the API's own guard in
    // apps/api/src/middleware/auth.js).
    if (state.authMethod === "recovery_password") {
      throw redirect({ to: "/recovery" });
    }
  },
});

// One route per NAV_ITEMS entry — a code-based route tree, not file-based
// codegen, since that would emit a generated .ts route tree and this repo
// has no .ts files. Every route renders the same placeholder until its own
// phase fills it in; see the phase order table in the phase README.
const BUILT_PATHS = ["/", "/admin/users", "/accounts", "/income", "/costs/fixed", "/costs/variable", "/calendar", "/allocation", "/goals", "/projections"];
const navRoutes = NAV_ITEMS.filter((item) => !BUILT_PATHS.includes(item.to)).map((item) =>
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: item.to,
    component: () => <PlaceholderPage item={item} />,
  }),
);

// The landing screen. `on` is a lens over which pay cycle is being reported,
// not a stored fact — a URL search param so a view is shareable and survives a
// reload (phases/10-dashboard.md "Behaviour"), the same reasoning as
// /allocation's own `on`.
const dashboardRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/",
  component: page(() => import("@/routes/dashboard-page.jsx"), "DashboardPage"),
  validateSearch: (search) => ({
    on: typeof search.on === "string" ? search.on : undefined,
  }),
});

const accountsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/accounts",
  component: page(() => import("@/routes/accounts-page.jsx"), "AccountsPage"),
});

// One page, five tabs (Users/Devices/Sessions/Invites from phase 03, People
// from phase 04), each with its own route so every sub-screen is directly
// linkable — see admin-page.jsx. Pay schedules used to be a sixth tab here
// and now lives on /income, which is what it always described.
const ADMIN_TAB_PATHS = ["users", "devices", "sessions", "invites", "people"];
const adminRoutes = ADMIN_TAB_PATHS.map((tab) =>
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: `/admin/${tab}`,
    component: page(() => import("@/routes/admin-page.jsx"), "AdminPage"),
  }),
);

// The page was /settings/* for phases 03–04 and every one of its tabs was a
// linkable URL, so a bookmark or a pasted link to one is a real thing that
// exists. Redirect rather than 404: /settings/pay-schedules has moved to a
// different page entirely, and the rest have only been renamed.
const settingsRedirectRoutes = [...ADMIN_TAB_PATHS, "pay-schedules"].map((tab) =>
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: `/settings/${tab}`,
    beforeLoad: () => {
      throw redirect({ to: tab === "pay-schedules" ? "/income" : `/admin/${tab}`, replace: true });
    },
    component: () => null,
  }),
);

// `variant` is a lens over the resolved-active-variant banner, not a stored
// fact — a URL search param rather than a record, so it's shareable and
// survives a reload for free (phases/05-income.md "Resolution rules").
const incomeRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/income",
  component: page(() => import("@/routes/income-page.jsx"), "IncomePage"),
  validateSearch: (search) => ({
    variant: typeof search.variant === "string" ? search.variant : undefined,
  }),
});

const fixedCostsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/costs/fixed",
  component: page(() => import("@/routes/fixed-costs-page.jsx"), "FixedCostsPage"),
});

const variableCostsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/costs/variable",
  component: page(() => import("@/routes/variable-costs-page.jsx"), "VariableCostsPage"),
});

// Not in NAV_ITEMS — reached by tapping a bill on /costs/fixed, not from the
// sidebar/bottom nav/command palette's Navigation group directly.
const billHistoryRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/costs/fixed/$billId/history",
  component: page(() => import("@/routes/bill-history-page.jsx"), "BillHistoryPage"),
});

// `plan` and `on` are lenses, not stored facts — which plan is on screen and
// which date it's previewed against, in the URL so both are shareable and
// survive a reload (same reasoning as /income's `variant`).
const allocationRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/allocation",
  component: page(() => import("@/routes/allocation-page.jsx"), "AllocationPage"),
  validateSearch: (search) => ({
    plan: typeof search.plan === "string" ? search.plan : undefined,
    on: typeof search.on === "string" ? search.on : undefined,
  }),
});

const goalsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/goals",
  component: page(() => import("@/routes/goals-page.jsx"), "GoalsPage"),
});

const projectionsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/projections",
  component: page(() => import("@/routes/projections-page.jsx"), "ProjectionsPage"),
});

// The one-time spreadsheet migration. Deliberately not in NAV_ITEMS — a tool
// used once does not earn a permanent slot in a five-item bottom nav — so it
// is reached from Admin and from the command palette (AppShell registers
// the command).
const importRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/import",
  component: page(() => import("@/routes/import-page.jsx"), "ImportPage"),
});

const calendarRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/calendar",
  component: page(() => import("@/routes/calendar-page.jsx"), "CalendarPage"),
});

// Hidden dev route — deliberately not in NAV_ITEMS, so it never appears in
// the sidebar, the bottom nav or the command palette.
const devChartsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/dev/charts",
  component: page(() => import("@/routes/dev-charts-page.jsx"), "DevChartsPage"),
});

// The unauthenticated section — no sidebar, no nav, just a centred card
// (see AuthLayout). Its routes never redirect away from themselves; the
// pages redirect *into* "/" once a session exists (LoginPage) or don't
// apply here at all (InvitePage, reachable while logged out or in).
const authLayoutRoute = createRoute({
  id: "auth-layout",
  getParentRoute: () => rootRoute,
  component: AuthLayout,
});

const loginRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: "/login",
  component: LoginPage,
  beforeLoad: async () => {
    const state = await ensureAuthState();
    if (!state.needsBootstrap && state.user) {
      throw redirect({ to: state.authMethod === "recovery_password" ? "/recovery" : "/" });
    }
  },
});

// The confined screen a recovery-password session lands on. It sits under
// the auth layout, not the app shell, because it is not the app: there is no
// nav to it and nothing to navigate to.
const recoveryRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: "/recovery",
  component: RecoveryPage,
  beforeLoad: async () => {
    const state = await ensureAuthState();
    if (!state.user) throw redirect({ to: "/login" });
    // A passkey session has no business here — it can just use the app.
    if (state.authMethod !== "recovery_password") throw redirect({ to: "/" });
  },
});

const inviteRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: "/invite/$code",
  component: InvitePage,
});

const routeTree = rootRoute.addChildren([
  appLayoutRoute.addChildren([
    ...navRoutes,
    ...adminRoutes,
    ...settingsRedirectRoutes,
    dashboardRoute,
    accountsRoute,
    incomeRoute,
    fixedCostsRoute,
    variableCostsRoute,
    allocationRoute,
    goalsRoute,
    projectionsRoute,
    billHistoryRoute,
    calendarRoute,
    importRoute,
    devChartsRoute,
  ]),
  authLayoutRoute.addChildren([loginRoute, inviteRoute, recoveryRoute]),
]);

export const router = createRouter({
  routeTree,
  // Start fetching a route's chunk when the pointer lands on its link, so
  // the split above costs nothing perceptible on a normal click. `intent`
  // is hover/touchstart, not an eager preload of everything.
  defaultPreload: "intent",
  // rootRoute's own errorComponent only catches what reaches the root. This
  // is the same screen for any *child* route that throws — a page's loader,
  // a lazy chunk that fails to fetch — so no route can white-screen just by
  // not having thought about errors.
  defaultErrorComponent: RouteError,
});
