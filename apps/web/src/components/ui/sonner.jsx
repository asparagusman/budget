import { Toaster as Sonner } from "sonner";
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { useResolvedTheme } from "@/lib/theme.jsx"

/** @param {import("react").ComponentProps<typeof Sonner>} props */
const Toaster = ({
  ...props
}) => {
  const theme = useResolvedTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        // Sonner's own `style` type comes from a stricter csstype version
        // with no index signature for custom properties; React's does.
        //
        // Raw tokens.css names only. The generated `var(--popover)` named a
        // property that doesn't exist (only Tailwind's `--color-popover`
        // does), and an undefined var() here doesn't fall back to Sonner's
        // white — it overrides it, and every toast rendered see-through over
        // the figures underneath.
        /** @type {import("react").CSSProperties} */ ({
          "--normal-bg": "var(--surface)",
          "--normal-text": "var(--text)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-control)"
        })
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props} />
  );
}

export { Toaster }
