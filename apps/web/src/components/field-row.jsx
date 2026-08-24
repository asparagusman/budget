import { Label } from "@/components/ui/label.jsx";
import { cn } from "@/lib/utils.js";

/**
 * Label + control + hint/error, laid out identically on desktop and mobile
 * so no feature phase has to re-derive this by hand.
 *
 * @param {{
 *   label: import("react").ReactNode,
 *   htmlFor?: string,
 *   hint?: import("react").ReactNode,
 *   error?: import("react").ReactNode,
 *   required?: boolean,
 *   children: import("react").ReactNode,
 *   className?: string,
 * }} props
 */
export function FieldRow({ label, htmlFor, hint, error, required, children, className }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span className="text-negative">*</span> : null}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-negative">{error}</p>
      ) : hint ? (
        <p className="text-xs text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
