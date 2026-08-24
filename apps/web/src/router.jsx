import { lazy, Suspense } from "react";
import { createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/shell/app-shell.jsx";
import { AuthLayout } from "@/components/shell/auth-layout.jsx";
import { PlaceholderPage } from "@/routes/placeholder-page.jsx";
import { LoginPage } from "@/routes/login-page.jsx";
import { InvitePage } from "@/routes/invite-page.jsx";
import { SettingsUsersPage } from "@/routes/settings-users-page.jsx";
import { NAV_ITEMS } from "@/lib/nav.js";
import { ensureAuthState } from "@/lib/auth.jsx";

// echarts is a large dependency and only this hidden dev route needs it —
// keep it out of the main bundle every real route pays for.
const DevChartsPage = lazy(() =>
  import("@/routes/dev-charts-page.jsx").then((m) => ({ default: m.DevChartsPage })),
);

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
const navRoutes = NAV_ITEMS.filter((item) => item.to !== "/settings/users").map((item) =>
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: item.to,
    component: () => <PlaceholderPage item={item} />,
  }),
);

const settingsUsersRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/settings/users",
  component: SettingsUsersPage,
});

// Hidden dev route — deliberately not in NAV_ITEMS, so it never appears in
// the sidebar, the bottom nav or the command palette.
const devChartsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/dev/charts",
  component: () => (
    <Suspense fallback={null}>
      <DevChartsPage />
    </Suspense>
  ),
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
  appLayoutRoute.addChildren([...navRoutes, settingsUsersRoute, devChartsRoute]),
  authLayoutRoute.addChildren([loginRoute, inviteRoute]),
]);

export const router = createRouter({ routeTree });
