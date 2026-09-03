import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/** @param {import("react").ComponentProps<typeof PopoverPrimitive.Root>} props */
function Popover({
  ...props
}) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

/** @param {import("react").ComponentProps<typeof PopoverPrimitive.Trigger>} props */
function PopoverTrigger({
  ...props
}) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/** @param {import("react").ComponentProps<typeof PopoverPrimitive.Content>} props */
function PopoverContent({
  className,
  align = /** @type {const} */ ("center"),
  sideOffset = 4,
  ...props
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 flex w-72 origin-(--radix-popover-content-transform-origin) flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props} />
    </PopoverPrimitive.Portal>
  );
}

/** @param {import("react").ComponentProps<typeof PopoverPrimitive.Anchor>} props */
function PopoverAnchor({
  ...props
}) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

/** @param {import("react").ComponentProps<"div">} props */
function PopoverHeader({
  className,
  ...props
}) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 text-sm", className)}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<"div">} props */
function PopoverTitle({
  className,
  ...props
}) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<"p">} props */
function PopoverDescription({
  className,
  ...props
}) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props} />
  );
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}
