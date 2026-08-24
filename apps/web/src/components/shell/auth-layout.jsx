import { Outlet } from "@tanstack/react-router";
import { ThemeToggle } from "@/components/theme-toggle.jsx";

/**
 * The unauthenticated frame — /login and /invite/$code render inside this
 * instead of <AppShell>: a centred card on the page ground, no sidebar, no
 * nav, because there's no session yet to navigate with.
 */
export function AuthLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <div className="flex flex-1 items-center justify-center p-4">
        <Outlet />
      </div>
      <div className="flex justify-center p-4">
        <ThemeToggle />
      </div>
    </div>
  );
}
