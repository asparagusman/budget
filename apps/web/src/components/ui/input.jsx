import * as React from "react"

import { cn } from "@/lib/utils"

/** @param {import("react").ComponentProps<"input">} props */
function Input({
  className,
  type,
  ...props
}) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-none border-0 border-b border-input bg-transparent px-0.5 py-1 text-base transition-[border-color,box-shadow] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:border-text-subtle focus-visible:border-ring focus-visible:shadow-[0_1px_0_0_var(--color-ring)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:shadow-[0_1px_0_0_var(--color-destructive)] md:text-sm",
        className
      )}
      {...props} />
  );
}

export { Input }
