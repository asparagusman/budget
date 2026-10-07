import { useCallback, useEffect, useMemo, useRef } from "react";
import { useOverlayScrollbars } from "overlayscrollbars-react";

/** @typedef {"y" | "x" | "both"} ScrollAxis */

/** @param {ScrollAxis} axis */
function optionsFor(axis) {
  return /** @type {import("overlayscrollbars").PartialOptions} */ ({
    overflow: {
      x: axis === "y" ? "hidden" : "scroll",
      y: axis === "x" ? "hidden" : "scroll",
    },
    scrollbars: {
      // Styled in styles/app.css from the colour tokens, so it follows the
      // theme without a second set of light/dark values.
      theme: "os-theme-app",
      // Out of sight until the pointer moves over the area or it scrolls,
      // then gone again shortly after — present when you go looking for
      // it, never sitting on top of the numbers.
      autoHide: "move",
      autoHideDelay: 800,
      clickScroll: true,
    },
  });
}

/**
 * A scroll container with OverlayScrollbars in place of the native bar: the
 * scrollbar floats over the content instead of taking a strip of width, and
 * is drawn the same in every browser. Native scrollbars are hidden app-wide
 * (styles/app.css); this is what every container that scrolls a meaningful
 * distance uses to get a visible one back.
 *
 * Two elements, and the split matters:
 * - the root (`as`, `className`) is OverlayScrollbars' host. Size it here —
 *   `flex-1 min-h-0`, `max-h-*` — and nothing else.
 * - the viewport (`viewportClassName`) is what actually scrolls, and it is
 *   rendered bare: OverlayScrollbars zeroes the viewport's padding and
 *   margin. Put padding and layout on an element inside `children` instead.
 *
 * `viewportRef` reaches the scrolling element itself, for `scrollTo` and
 * scroll listeners — the root never scrolls.
 *
 * @param {{
 *   as?: "div" | "main" | "nav",
 *   axis?: ScrollAxis,
 *   className?: string,
 *   viewportClassName?: string,
 *   viewportRef?: import("react").Ref<HTMLDivElement>,
 *   children?: import("react").ReactNode,
 * } & Omit<import("react").HTMLAttributes<HTMLElement>, "className" | "children">} props
 */
export function ScrollArea({
  as: Root = "div",
  axis = "y",
  className,
  viewportClassName,
  viewportRef,
  children,
  ...props
}) {
  const rootRef = useRef(/** @type {HTMLElement | null} */ (null));
  const viewportEl = useRef(/** @type {HTMLDivElement | null} */ (null));
  const options = useMemo(() => optionsFor(axis), [axis]);
  const [initialize, instance] = useOverlayScrollbars({ options });

  useEffect(() => {
    const target = rootRef.current;
    const viewport = viewportEl.current;
    if (!target || !viewport) return undefined;
    // The viewport is React's own element, handed over rather than
    // generated, so OverlayScrollbars never moves a node React rendered.
    initialize({ target, elements: { viewport, content: viewport } });
    return () => instance()?.destroy();
  }, [initialize, instance]);

  const setViewport = useCallback(
    /** @param {HTMLDivElement | null} el */
    (el) => {
      viewportEl.current = el;
      if (typeof viewportRef === "function") viewportRef(el);
      else if (viewportRef) viewportRef.current = el;
    },
    [viewportRef],
  );

  return (
    <Root
      // @ts-expect-error -- one ref for whichever of the three tags `as` picks
      ref={rootRef}
      data-overlayscrollbars-initialize=""
      className={className}
      {...props}
    >
      <div
        ref={setViewport}
        data-overlayscrollbars-contents=""
        data-slot="scroll-area-viewport"
        className={viewportClassName}
      >
        {children}
      </div>
    </Root>
  );
}
