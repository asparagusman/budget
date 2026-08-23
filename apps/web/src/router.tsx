import { createRootRoute, createRouter, Outlet } from "@tanstack/react-router";
import { RootPage } from "./root-page.js";

const rootRoute = createRootRoute({
  component: () => (
    <>
      <RootPage />
      <Outlet />
    </>
  ),
});

export const router = createRouter({ routeTree: rootRoute });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
