import * as React from "react"
import { Dialog as SheetPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"
import { ScrollArea } from "@/components/scroll-area"

/** @param {import("react").ComponentProps<typeof SheetPrimitive.Root>} props */
function Sheet({
  ...props
}) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

/** @param {import("react").ComponentProps<typeof SheetPrimitive.Trigger>} props */
function SheetTrigger({
  ...props
}) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

/** @param {import("react").ComponentProps<typeof SheetPrimitive.Close>} props */
function SheetClose({
  ...props
}) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

/** @param {import("react").ComponentProps<typeof SheetPrimitive.Portal>} props */
function SheetPortal({
  ...props
}) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

/** @param {import("react").ComponentProps<typeof SheetPrimitive.Overlay>} props */
function SheetOverlay({
  className,
  ...props
}) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props} />
  );
}

// How far the grabber has to travel before releasing dismisses the sheet.
// Below this it springs back, so a mis-grab while scrolling does not close
// the sheet out from under the operator.
const DISMISS_PX = 72;

/**
 * Sheets slide from the edge on a strong ease-out — the near-spring
 * `cubic-bezier(0.16, 1, 0.3, 1)` rather than a literal overshoot, because a
 * bottom sheet that overshoots lifts off the bottom edge and shows a strip
 * of overlay underneath itself.
 *
 * Top and bottom sheets also get a grabber and are dismissible by dragging
 * it (phases/11-polish-mobile-import.md: dismissible by swipe AND by an
 * explicit close control — both, so the close button stays). The drag is
 * bound to the grabber only, never to the body: these sheets scroll, and a
 * body-wide drag handler turns scrolling them into a coin-flip between
 * panning and dismissing.
 *
 * `scrollable` puts the children in a <ScrollArea> (overlay scrollbar, see
 * components/scroll-area.jsx) for a sheet capped with `max-h-*` whose body
 * can outgrow it. The grabber and the close button stay outside it, so they
 * are still there once the body has scrolled.
 *
 * @param {import("react").ComponentProps<typeof SheetPrimitive.Content> &
 *   { side?: 'top' | 'right' | 'bottom' | 'left', showCloseButton?: boolean, scrollable?: boolean }} props
 */
function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  scrollable = false,
  ...props
}) {
  const closeRef = React.useRef(/** @type {HTMLButtonElement | null} */ (null));
  const [dragPx, setDragPx] = React.useState(0);
  const dragging = React.useRef(false);
  const startY = React.useRef(0);
  // Mirrors dragPx so pointerup reads the final offset without depending on
  // a state update having been flushed first.
  const currentY = React.useRef(0);

  const swipeable = side === "bottom" || side === "top";

  /** @param {import("react").PointerEvent<HTMLDivElement>} event */
  function onPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    dragging.current = true;
    startY.current = event.clientY;
    currentY.current = 0;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  /** @param {import("react").PointerEvent<HTMLDivElement>} event */
  function onPointerMove(event) {
    if (!dragging.current) return;
    const raw = event.clientY - startY.current;
    // Only toward the edge the sheet came from; dragging the other way
    // would peel it off the viewport edge.
    const clamped = side === "bottom" ? Math.max(0, raw) : Math.min(0, raw);
    currentY.current = clamped;
    setDragPx(clamped);
  }

  /** @param {import("react").PointerEvent<HTMLDivElement>} event */
  function onPointerUp(event) {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const dismissed = Math.abs(currentY.current) > DISMISS_PX;
    currentY.current = 0;
    setDragPx(0);
    // Radix owns the open state; clicking its own Close is how a child asks
    // to shut without the caller having to thread `onOpenChange` down.
    if (dismissed) closeRef.current?.click();
  }

  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        style={dragPx ? { transform: `translateY(${dragPx}px)`, transition: "none" } : undefined}
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg transition duration-200 ease-in-out data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
          // Enter/exit: a full slide from the edge on a near-spring curve,
          // capped at 280ms in and 200ms out.
          "data-open:animate-in data-open:fade-in-0 data-open:duration-[280ms] data-open:ease-[cubic-bezier(0.16,1,0.3,1)] data-[side=bottom]:data-open:slide-in-from-bottom data-[side=left]:data-open:slide-in-from-left data-[side=right]:data-open:slide-in-from-right data-[side=top]:data-open:slide-in-from-top",
          "data-closed:animate-out data-closed:fade-out-0 data-closed:duration-200 data-[side=bottom]:data-closed:slide-out-to-bottom data-[side=left]:data-closed:slide-out-to-left data-[side=right]:data-closed:slide-out-to-right data-[side=top]:data-closed:slide-out-to-top",
          // The iOS home indicator sits under a bottom sheet's own footer.
          "data-[side=bottom]:pb-[env(safe-area-inset-bottom)]",
          className
        )}
        {...props}>
        {swipeable && (
          <div
            role="presentation"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            // touch-none so the browser hands us the gesture instead of
            // scrolling whatever is behind the sheet.
            className={cn(
              "flex shrink-0 cursor-grab touch-none justify-center py-3 active:cursor-grabbing",
              side === "top" && "order-last",
            )}
          >
            <span className="h-1 w-10 rounded-full bg-border" />
          </div>
        )}
        {scrollable ? (
          // flex-auto + min-h-0: fills a full-height side sheet, and gives up
          // height inside a `max-h-*` one instead of overflowing it. The
          // inner column restores the gap-4 the children had as direct
          // items of this one.
          <ScrollArea className="min-h-0 flex-auto">
            <div className="flex flex-col gap-4">{children}</div>
          </ScrollArea>
        ) : (
          children
        )}
        {showCloseButton && (
          <SheetPrimitive.Close data-slot="sheet-close" asChild>
            <Button ref={closeRef} variant="ghost" className="absolute top-3 right-3" size="icon-sm">
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </SheetPrimitive.Close>
        )}
        {/* When the caller suppressed the visible close button, the swipe
            still needs something to click. Only rendered in that case, and
            only for a swipeable side, so it can never become the ONLY way
            out of a sheet. */}
        {!showCloseButton && swipeable && (
          <SheetPrimitive.Close ref={closeRef} className="hidden" aria-hidden="true" tabIndex={-1} />
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

/** @param {import("react").ComponentProps<"div">} props */
function SheetHeader({
  className,
  ...props
}) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<"div">} props */
function SheetFooter({
  className,
  ...props
}) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<typeof SheetPrimitive.Title>} props */
function SheetTitle({
  className,
  ...props
}) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-heading text-base font-medium text-foreground", className)}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<typeof SheetPrimitive.Description>} props */
function SheetDescription({
  className,
  ...props
}) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props} />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
