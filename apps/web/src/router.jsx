import { lazy, Suspense } from "react";
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/shell/app-shell.jsx";
import { PlaceholderPage } from "@/routes/placeholder-page.jsx";
import { NAV_ITEMS } from "@/lib/nav.js";

// echarts is a large dependency and only this hidden dev route needs it —
// keep it out of the main bundle every real route pays for.
const DevChartsPage = lazy(() =>
  import("@/routes/dev-charts-page.jsx").then((m) => ({ default: m.DevChartsPage })),
);

const rootRoute = createRootRoute({
  component: AppShell,
});

// One route per NAV_ITEMS entry — a code-based route tree, not file-based
// codegen, since that would emit a generated .ts route tree and this repo
// has no .ts files. Every route renders the same placeholder until its own
// phase fills it in; see the phase order table in the phase README.
const navRoutes = NAV_ITEMS.map((item) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: item.to,
    component: () => <PlaceholderPage item={item} />,
  }),
);

// Hidden dev route — deliberately not in NAV_ITEMS, so it never appears in
// the sidebar, the bottom nav or the command palette.
const devChartsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dev/charts",
  component: () => (
    <Suspense fallback={null}>
      <DevChartsPage />
    </Suspense>
  ),
});

const routeTree = rootRoute.addChildren([...navRoutes, devChartsRoute]);

export const router = createRouter({ routeTree });
