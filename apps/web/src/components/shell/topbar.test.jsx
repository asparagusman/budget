import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { NAV_ITEMS } from "@/lib/nav.js";
import { ThemeProvider } from "@/lib/theme.jsx";
import { TopBar } from "./topbar.jsx";

vi.mock("@/lib/auth.jsx", () => ({
  useAuth: () => ({
    state: { needsBootstrap: false, user: { id: "u1", displayName: "Sam Lee", email: "sam@example.com" } },
  }),
  useSignOut: () => async () => {},
}));

// The router resets scroll on every navigation, and jsdom has no layout to
// scroll.
vi.stubGlobal("scrollTo", () => {});

// The phone's whole navigation now lives behind the top bar's menu button,
// so what has to hold is that the button reaches every destination — the
// bottom bar it replaced reached four and hid six behind "More" — and that
// the drawer says where you are even one level below a nav page.

/** @param {string} path */
async function renderAt(path) {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <ThemeProvider>
          <TopBar />
          <Outlet />
        </ThemeProvider>
      ),
      // No child routes: every path is "not found", and only the bar matters.
      notFoundComponent: () => null,
    }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await act(() => router.load());
  render(<RouterProvider router={router} />);
  return router;
}

describe("TopBar menu", () => {
  it("opens a drawer listing every destination", async () => {
    await renderAt("/income");
    await userEvent.click(await screen.findByRole("button", { name: "Open menu" }));

    const nav = within(await screen.findByRole("dialog")).getByRole("navigation");
    expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual(
      NAV_ITEMS.map((item) => item.label),
    );
  });

  it("marks the section a sub-page belongs to as current", async () => {
    await renderAt("/admin/devices");
    expect(screen.getByText("Admin")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Admin" })).toHaveAttribute("aria-current", "page");
    expect(within(dialog).getAllByRole("link", { current: "page" })).toHaveLength(1);
  });

  it("closes once a destination is chosen", async () => {
    const router = await renderAt("/income");
    await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("link", { name: "Goals" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/goals");
  });
});
