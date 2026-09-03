import { useEffect, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import { setTopBarSlotEl } from "@/lib/topbar-slot.js";
import { pageTitle } from "@/lib/nav.js";

/**
 * Mobile-only sticky bar: page title + one contextual action, filled in via
 * <TopBarAction> from wherever the route wants. Desktop shows neither — the
 * sidebar carries navigation and each page's own <PageHeader> carries title
 * and actions inline.
 */
export function TopBar() {
  const slotRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const title = pageTitle(pathname);

  useEffect(() => {
    setTopBarSlotEl(slotRef.current);
    return () => setTopBarSlotEl(null);
  }, []);

  return (
    <header
      // Not sticky: it is a sibling of the scroll container now, so it
      // simply never moves.
      className="z-30 flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-4 md:hidden"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <h1 className="truncate text-base font-semibold text-text">
        {title}
      </h1>
      <div ref={slotRef} className="flex items-center gap-2" />
    </header>
  );
}
