"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react"

/** @param {import("react").ComponentProps<typeof SelectPrimitive.Root>} props */
function Select({
  ...props
}) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

/** @param {import("react").ComponentProps<typeof SelectPrimitive.Group>} props */
function SelectGroup({
  className,
  ...props
}) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-1 p-1", className)}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<typeof SelectPrimitive.Value>} props */
function SelectValue({
  ...props
}) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

/**
 * @param {import("react").ComponentProps<typeof SelectPrimitive.Trigger> &
 *   { size?: 'default' | 'sm' }} props
 */
function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit cursor-pointer items-center justify-between gap-1.5 rounded-none border-0 border-b border-input bg-transparent py-2 pr-0.5 pl-0.5 text-sm whitespace-nowrap transition-[border-color,box-shadow] outline-none select-none hover:border-text-subtle data-[state=open]:border-ring data-[state=open]:shadow-[0_1px_0_0_var(--color-ring)] [&[data-state=open]>svg]:rotate-180 [&>svg]:transition-transform [&>svg]:duration-150 focus-visible:border-ring focus-visible:shadow-[0_1px_0_0_var(--color-ring)] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:shadow-[0_1px_0_0_var(--color-destructive)] data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}>
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/**
 * Drops below the trigger (`popper`) rather than Radix's default
 * `item-aligned`, which lays the list over the trigger and over whatever
 * fields sit beneath it.
 *
 * The open/close animation is keyed on `data-[state=*]`, not shadcn's
 * `data-open:` — that variant needs shadcn's tailwind.css, which this app
 * doesn't import, so it silently matched nothing.
 *
 * @param {import("react").ComponentProps<typeof SelectPrimitive.Content>} props
 */
function SelectContent({
  className,
  children,
  position = "popper",
  align = "start",
  sideOffset = 6,
  ...props
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        data-align-trigger={position === "item-aligned"}
        className={cn(
          "relative z-50 max-h-[min(var(--radix-select-content-available-height),20rem)] min-w-36 origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-(--shadow-raised) duration-150 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-98 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98",
          className
        )}
        position={position}
        align={align}
        sideOffset={sideOffset}
        {...props}>
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          data-position={position}
          className="flex flex-col gap-0.5 p-1.5 data-[position=popper]:h-(--radix-select-trigger-height) data-[position=popper]:w-full data-[position=popper]:min-w-(--radix-select-trigger-width)">
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

/** @param {import("react").ComponentProps<typeof SelectPrimitive.Label>} props */
function SelectLabel({
  className,
  ...props
}) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-2.5 py-1 text-xs text-muted-foreground", className)}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<typeof SelectPrimitive.Item>} props */
function SelectItem({
  className,
  children,
  ...props
}) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex min-h-9 w-full cursor-pointer items-center gap-1.5 rounded-lg py-1.5 pr-9 pl-2.5 text-sm outline-hidden transition-colors select-none focus:bg-surface-muted data-[state=checked]:font-medium data-[state=checked]:text-accent-brand data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}>
      <span
        className="pointer-events-none absolute right-2.5 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="pointer-events-none" strokeWidth={2.5} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

/** @param {import("react").ComponentProps<typeof SelectPrimitive.Separator>} props */
function SelectSeparator({
  className,
  ...props
}) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1.5 my-1 h-px bg-border", className)}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<typeof SelectPrimitive.ScrollUpButton>} props */
function SelectScrollUpButton({
  className,
  ...props
}) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}>
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpButton>
  );
}

/** @param {import("react").ComponentProps<typeof SelectPrimitive.ScrollDownButton>} props */
function SelectScrollDownButton({
  className,
  ...props
}) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}>
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
