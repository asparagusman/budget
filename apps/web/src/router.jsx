import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/shell/app-shell.jsx";
import { AuthLayout } from "@/components/shell/auth-layout.jsx";
import { PlaceholderPage } from "@/routes/placeholder-page.jsx";
import { LoginPage } from "@/routes/login-page.jsx";
import { InvitePage } from "@/routes/invite-page.jsx";
import { NAV_ITEMS } from "@/lib/nav.js";
import { ensureAuthState } from "@/lib/auth.jsx";

// Every authenticated page is code-split. Route-level splitting is the whole
// of phase 11's performance story: the dashboard should not pay to download
// the allocation editor, the importer or (through any of them) echarts
// (phases/11-polish-mobile-import.md, workstream B "Performance").
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

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

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
  },
});

// One route per NAV_ITEMS entry — a code-based route tree, not file-based
// codegen, since that would emit a generated .ts route tree and this repo
// has no .ts files. Every route renders the same placeholder until its own
// phase fills it in; see the phase order table in the phase README.
const BUILT_PATHS = ["/", "/settings/users", "/accounts", "/income", "/costs/fixed", "/costs/variable", "/calendar", "/allocation", "/goals", "/projections"];
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

// One page, six tabs (Users/Devices/Sessions/Invites from phase 03, People
// and Pay schedules from phase 04), each with its own route so every
// sub-screen is directly linkable — see settings-page.jsx.
const settingsRoutes = ["users", "devices", "sessions", "invites", "people", "pay-schedules"].map((tab) =>
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: `/settings/${tab}`,
    component: page(() => import("@/routes/settings-page.jsx"), "SettingsPage"),
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
// is reached from Settings and from the command palette (AppShell registers
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
      throw redirect({ to: "/" });
    }
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
    ...settingsRoutes,
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
  authLayoutRoute.addChildren([loginRoute, inviteRoute]),
]);

export const router = createRouter({
  routeTree,
  // Start fetching a route's chunk when the pointer lands on its link, so
  // the split above costs nothing perceptible on a normal click. `intent`
  // is hover/touchstart, not an eager preload of everything.
  defaultPreload: "intent",
});
