import { Outlet } from "@tanstack/react-router";
import { Sidebar } from "@/components/shell/sidebar.jsx";
import { TopBar } from "@/components/shell/topbar.jsx";
import { BottomNav } from "@/components/shell/bottom-nav.jsx";

/**
 * The application frame every route renders inside: sidebar on desktop, top
 * bar + bottom nav on mobile, and a centred content column in between. The
 * page body never scrolls horizontally — a wide table or chart gets its own
 * `overflow-x: auto` container instead.
 */
export function AppShell() {
  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 px-4 pt-4 pb-20 md:px-8 md:pt-8 md:pb-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <Outlet />
          </div>
        </main>
      </div>
      <BottomNav />
    </div>
  );
}
