import * as React from "react"

import { cn } from "@/lib/utils"

/** @param {import("react").ComponentProps<"div"> & { size?: 'default' | 'sm' }} props */
function Card({
  className,
  size = "default",
  ...props
}) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        // Separation from the page comes from the surface/bg tonal step
        // plus this shadow — deliberately no ring/border (aesthetic target
        // in the phase README). Generous 24px padding by default, per spec.
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-(--radius-card) bg-card py-(--card-spacing) text-sm text-card-foreground shadow-(--shadow-card) [--card-spacing:--spacing(6)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(4)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-(--radius-card) *:[img:last-child]:rounded-b-(--radius-card)",
        className
      )}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<"div">} props */
function CardHeader({
  className,
  ...props
}) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-(--radius-card) px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<"div">} props */
function CardTitle({
  className,
  ...props
}) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<"div">} props */
function CardDescription({
  className,
  ...props
}) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<"div">} props */
function CardAction({
  className,
  ...props
}) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<"div">} props */
function CardContent({
  className,
  ...props
}) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props} />
  );
}

/** @param {import("react").ComponentProps<"div">} props */
function CardFooter({
  className,
  ...props
}) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-(--radius-card) border-t bg-muted/50 p-(--card-spacing)",
        className
      )}
      {...props} />
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
