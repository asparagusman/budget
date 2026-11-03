import * as React from "react"

import { cn } from "@/lib/utils"

/** @param {import("react").ComponentProps<"textarea">} props */
function Textarea({
  className,
  ...props
}) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-none border-0 border-b border-input bg-transparent px-0.5 py-1.5 text-base transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground hover:border-text-subtle focus-visible:border-ring focus-visible:shadow-[0_1px_0_0_var(--color-ring)] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:shadow-[0_1px_0_0_var(--color-destructive)] md:text-sm",
        className
      )}
      {...props} />
  );
}

export { Textarea }
