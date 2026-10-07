import { Outlet } from "@tanstack/react-router";
import { ThemeToggle } from "@/components/theme-toggle.jsx";
import { ScrollArea } from "@/components/scroll-area.jsx";

/**
 * The unauthenticated frame — /login and /invite/$code render inside this
 * instead of <AppShell>: a centred card on the page ground, no sidebar, no
 * nav, because there's no session yet to navigate with.
 */
export function AuthLayout() {
  return (
    // `h-dvh` + its own scroller, not `min-h-screen`: the document no longer
    // scrolls (see styles/app.css), so every frame has to carry its own
    // scroller or a tall viewport clips it.
    <ScrollArea className="h-dvh bg-bg">
      <div className="flex min-h-dvh flex-col">
        <div className="flex flex-1 items-center justify-center p-4">
          <Outlet />
        </div>
        <div className="flex justify-center p-4">
          <ThemeToggle />
        </div>
      </div>
    </ScrollArea>
  );
}
