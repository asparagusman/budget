import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { InfoIcon } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.jsx";
import { cn } from "@/lib/utils.js";
import { useTopBarSlotEl } from "@/lib/topbar-slot.js";

/**
 * Whether the app's one scroll container (`<main>`'s <ScrollArea> viewport,
 * see shell/app-shell.jsx) is scrolled away from the top. Used to reveal a sticky header's edge only
 * once there is something underneath it — a border and shadow drawn at rest
 * reads as a mistake.
 *
 * Listens on that viewport rather than the window because the window never
 * scrolls in this app, and an IntersectionObserver sentinel would have to
 * fight the route wrapper's `gap-6` for a position.
 *
 * @param {import("react").RefObject<HTMLElement | null>} ref an element inside the scroller
 */
function useScrolled(ref) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const scroller = ref.current?.closest('[data-slot="scroll-area-viewport"]');
    if (!scroller) return undefined;
    const onScroll = () => setScrolled(scroller.scrollTop > 0);
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [ref]);

  return scrolled;
}

/**
 * Publishes the header's height as `--page-header-h` on its parent — the
 * shell's per-route wrapper — so anything else pinned further down the page
 * (Allocation's preview panel) can sit below the header rather than slide
 * under it. On the parent rather than `:root` so it leaves with the page.
 *
 * @param {import("react").RefObject<HTMLElement | null>} ref
 */
function usePublishHeight(ref) {
  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return undefined;
    const observer = new ResizeObserver(() => {
      parent.style.setProperty("--page-header-h", `${el.offsetHeight}px`);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      parent.style.removeProperty("--page-header-h");
    };
  }, [ref]);
}

/**
 * The page's description, folded into an (i) beside its title: worth
 * re-reading on a monthly visit, not worth a line of every screen.
 *
 * A popover rather than a tooltip so a tap opens it on a phone too.
 *
 * @param {{ children: import("react").ReactNode, className?: string }} props
 */
function PageInfo({ children, className }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="About this page" className={cn("text-text-subtle", className)}>
          <InfoIcon className="size-4" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="text-pretty text-text-muted">
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * @param {{
 *   title: import("react").ReactNode,
 *   description?: import("react").ReactNode,
 *   actions?: import("react").ReactNode,
 *   stickyOnMobile?: boolean,
 *   className?: string,
 * }} props
 *
 * One row of one fixed height on every page — title and (i) on the left,
 * actions on the right — so the frame doesn't change shape as you move
 * between screens or scroll. `description` is what the (i) opens; it is
 * reference text, not something to show every time.
 *
 * From `md` up the header is always pinned to the top of the scroller, so a
 * page's title and actions stay in reach however far down it you've read.
 *
 * Below `md` it scrolls away unless `stickyOnMobile` is set: the top bar
 * already names the page there, and pinned buttons would spend a phone's
 * most valuable space for nothing. Set it for a screen whose header carries
 * controls the operator needs mid-page — Save and Cancel on an editable
 * table, say.
 *
 * The negative margins let the background reach the scroller's own padding
 * edge, so content passes underneath rather than beside.
 *
 * Below `md` the title is visually hidden: the mobile top bar already names
 * the page one line above, and the (i) moves up there beside it. The h1 stays
 * in the document as the page's one heading. A header with no actions leaves
 * the flow entirely there, so it doesn't leave a gap's worth of empty space
 * at the top of the page either.
 */
export function PageHeader({ title, description, actions, stickyOnMobile = false, className }) {
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  const scrolled = useScrolled(ref);
  usePublishHeight(ref);
  const topBarInfoEl = useTopBarSlotEl("info");

  return (
    <div
      ref={ref}
      className={cn(
        "flex items-center justify-between gap-3 md:gap-6",
        !actions && !stickyOnMobile && "max-md:sr-only",
        // The negative margins pull the header out over `<main>`'s own
        // padding (`px-4 pt-4` / `md:px-8 md:pt-8`, shell/app-shell.jsx), so
        // it starts at the very top of the scroller. At rest and pinned at
        // `top-0` it is then the same box in the same place — the title
        // doesn't jump up when the page starts to scroll — and content
        // passes under its background rather than through a visible gap
        // above it. (Sticky pins the border edge, not the margin edge, so the
        // `-mt` doesn't hide anything.) These numbers have to track `<main>`'s
        // padding.
        //
        // One 64px band on every page, title centred in it. `min-` only so a
        // page with too many actions wraps rather than overflowing.
        //
        // z-30, above the z-10/z-20 that in-page layers use (the income
        // timeline's today marker, sticky table columns), which would
        // otherwise paint over it as it scrolls past.
        //
        // Desktop pins always; the branch below is the same thing at every
        // width. Spelled out twice because Tailwind only sees literal
        // class names.
        !stickyOnMobile && [
          "md:sticky md:top-0 md:z-30 md:-mx-8 md:-mt-8 md:min-h-16 md:bg-bg md:px-8",
          "md:border-b md:transition-colors",
          scrolled ? "md:border-border" : "md:border-transparent",
        ],
        stickyOnMobile && [
          "sticky top-0 z-30 -mx-4 -mt-4 bg-bg px-4 py-2 md:-mx-8 md:-mt-8 md:min-h-16 md:px-8 md:py-0",
          // Transition only the edge, never the layout: a header that
          // changed height on scroll would move the text being read.
          "border-b transition-colors",
          scrolled ? "border-border" : "border-transparent",
        ],
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1 max-md:sr-only">
        <h1 className="truncate text-2xl font-semibold text-text">{title}</h1>
        {description ? <PageInfo className="max-md:hidden">{description}</PageInfo> : null}
      </div>
      {description && topBarInfoEl ? createPortal(<PageInfo>{description}</PageInfo>, topBarInfoEl) : null}
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
