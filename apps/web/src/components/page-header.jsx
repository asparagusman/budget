import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils.js";

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
 * @param {boolean} enabled
 */
function useScrolled(ref, enabled) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    const scroller = ref.current?.closest('[data-slot="scroll-area-viewport"]');
    if (!scroller) return undefined;
    const onScroll = () => setScrolled(scroller.scrollTop > 0);
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [ref, enabled]);

  return scrolled;
}

/**
 * @param {{
 *   title: import("react").ReactNode,
 *   description?: import("react").ReactNode,
 *   actions?: import("react").ReactNode,
 *   sticky?: boolean,
 *   className?: string,
 * }} props
 *
 * `sticky` pins the header to the top of the scroller, for a screen whose
 * header carries controls the operator needs while reading further down the
 * page — Save and Cancel on an editable table, say. It is opt-in: a header
 * that is only a title has nothing to offer once scrolled past, and pinning
 * it would just spend vertical space on a phone.
 *
 * The negative margins let the background reach the scroller's own padding
 * edge, so content passes underneath rather than beside.
 *
 * Below `md` the title is visually hidden: the mobile top bar already names
 * the page one line above, and saying it twice spends the most valuable 40px
 * on a phone. It stays in the document as the page's one h1. A header with
 * nothing else to show leaves the flow entirely there, so it doesn't leave a
 * gap's worth of empty space at the top of the page either.
 */
export function PageHeader({ title, description, actions, sticky = false, className }) {
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  const scrolled = useScrolled(ref, sticky);
  const titleOnly = !description && !actions;

  return (
    <div
      ref={ref}
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6",
        titleOnly && !sticky && "max-md:sr-only",
        sticky && [
          // The horizontal negative margins are what let the background reach
          // the scroller's padding edge. There are deliberately no vertical
          // ones: a sticky box is pinned by its margin edge, so a `-mt-8`
          // would leave 32px of the page scrolling past *above* the header.
          "sticky top-0 z-20 -mx-4 bg-bg px-4 py-3 md:-mx-8 md:px-8",
          // A sticky element cannot rise above its containing block, and this
          // one's containing block starts below `<main>`'s own `pt-4`/`md:pt-8`
          // — so pinned at `top-0` it still leaves that band of padding for
          // content to scroll through in plain sight. The strip above paints
          // over exactly that band; its height has to track `<main>`'s
          // padding-top (shell/app-shell.jsx). No `relative` alongside it —
          // `sticky` already positions the pseudo-element, and both live in
          // Tailwind's position group, so twMerge would keep only the last of
          // the two and silently unstick the header.
          "before:absolute before:inset-x-0 before:bottom-full before:h-4 before:bg-bg before:content-[''] md:before:h-8",
          // Transition only the edge, never the layout: a header that
          // changed height on scroll would move the text being read.
          "border-b transition-colors",
          scrolled ? "border-border" : "border-transparent",
        ],
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-text max-md:sr-only">
          {title}
        </h1>
        {description ? (
          // A measure, not the full column: at 1440px an unbounded line runs
          // past 150 characters and the eye loses its way back.
          <p className="max-w-3xl text-sm text-pretty text-text-muted md:mt-1">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
