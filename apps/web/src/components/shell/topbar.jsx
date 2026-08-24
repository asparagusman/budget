import { useEffect, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import { setTopBarSlotEl } from "@/lib/topbar-slot.js";
import { NAV_ITEMS } from "@/lib/nav.js";

/**
 * Mobile-only sticky bar: page title + one contextual action, filled in via
 * <TopBarAction> from wherever the route wants. Desktop shows neither — the
 * sidebar carries navigation and each page's own <PageHeader> carries title
 * and actions inline.
 */
export function TopBar() {
  const slotRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = NAV_ITEMS.find((item) => item.to === pathname);

  useEffect(() => {
    setTopBarSlotEl(slotRef.current);
    return () => setTopBarSlotEl(null);
  }, []);

  return (
    <header
      className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-4 md:hidden"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <h1 className="truncate text-base font-semibold text-text">
        {current?.label ?? "Budget"}
      </h1>
      <div ref={slotRef} className="flex items-center gap-2" />
    </header>
  );
}
