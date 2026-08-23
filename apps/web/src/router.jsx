import { createRootRoute, createRouter, Outlet } from "@tanstack/react-router";
import { RootPage } from "./root-page.jsx";

const rootRoute = createRootRoute({
  component: () => (
    <>
      <RootPage />
      <Outlet />
    </>
  ),
});

export const router = createRouter({ routeTree: rootRoute });
