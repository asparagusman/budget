import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { setTopBarSlotEl } from "@/lib/topbar-slot.js";
import { pageTitle } from "@/lib/nav.js";
import { Button } from "@/components/ui/button.jsx";
import { MobileNav } from "@/components/shell/mobile-nav.jsx";

/**
 * Mobile-only bar: the menu button that opens <MobileNav>, the page title,
 * and one contextual action filled in via <TopBarAction> from wherever the
 * route wants. Desktop shows none of it — the sidebar carries navigation and
 * each page's own <PageHeader> carries title and actions inline.
 */
export function TopBar() {
  const slotRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const infoSlotRef = useRef(/** @type {HTMLSpanElement | null} */ (null));
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const title = pageTitle(pathname);

  useEffect(() => {
    setTopBarSlotEl("action", slotRef.current);
    setTopBarSlotEl("info", infoSlotRef.current);
    return () => {
      setTopBarSlotEl("action", null);
      setTopBarSlotEl("info", null);
    };
  }, []);

  return (
    <header
      // Not sticky: it is a sibling of the scroll container now, so it
      // simply never moves.
      className="z-30 flex h-14 shrink-0 items-center gap-1 border-b border-border bg-surface px-4 md:hidden"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* -ml-2 lines the glyph up with the page's 16px gutter rather than
          the button's own box. */}
      <Button
        variant="ghost"
        size="icon"
        className="-ml-2"
        aria-label="Open menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(true)}
      >
        <Menu className="size-5" aria-hidden="true" />
      </Button>
      {/* Not a heading: every page's own <PageHeader> h1 is still in the
          document on a phone (visually hidden there, because this bar
          already says it), and two h1s would announce the page twice. */}
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <p aria-hidden="true" className="min-w-0 truncate text-base font-semibold text-text">
          {title}
        </p>
        {/* The page's (i), from <PageHeader>: what this screen is for. */}
        <span ref={infoSlotRef} className="flex shrink-0" />
      </div>
      <div ref={slotRef} className="flex items-center gap-2" />
      <MobileNav open={menuOpen} onOpenChange={setMenuOpen} />
    </header>
  );
}
