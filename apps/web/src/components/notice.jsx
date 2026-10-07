import { AlertTriangleIcon, CircleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils.js";

/**
 * Amber means "needs a look" — the one way this app asks for attention, on
 * every screen (see the vocabulary in styles/tokens.css). Warnings from the
 * engine, a conflict, a defect in imported data, a request that failed: all
 * of them arrive in this panel, so a household that opens the app once a
 * month learns one shape, not six.
 *
 * Errors included. Red means money out here; an error painted red read as
 * "you're losing money" before it read as "that didn't save". The icon and
 * the wording carry the difference between "have a look" and "that failed".
 *
 * @typedef {"attention" | "error"} NoticeKind
 */

/** @type {Record<NoticeKind, import("lucide-react").LucideIcon>} */
const ICONS = { attention: AlertTriangleIcon, error: CircleAlertIcon };

/**
 * One message in an amber panel.
 *
 * @param {{
 *   children: import("react").ReactNode,
 *   kind?: NoticeKind,
 *   compact?: boolean,
 *   className?: string,
 * }} props
 */
export function Notice({ children, kind = "attention", compact = false, className }) {
  const Icon = ICONS[kind];
  return (
    <div
      className={cn(
        "flex items-start gap-2 bg-warning-soft text-text",
        compact ? "rounded-(--radius-control) px-3 py-2 text-xs" : "rounded-(--radius-card) p-4 text-sm",
        className,
      )}
    >
      <Icon className={cn("shrink-0 text-warning-strong", compact ? "mt-px size-3.5" : "mt-0.5 size-4")} aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * Several messages in ONE amber panel — a list of engine warnings, say —
 * rather than a stack of panels.
 *
 * @param {{
 *   items: { key: string, content: import("react").ReactNode }[],
 *   kind?: NoticeKind,
 *   children?: import("react").ReactNode,
 *   className?: string,
 * }} props `children` renders under the list (a "show more" toggle).
 */
export function NoticeList({ items, kind = "attention", children, className }) {
  const Icon = ICONS[kind];
  return (
    <div className={cn("flex flex-col gap-2 rounded-(--radius-card) bg-warning-soft p-4", className)}>
      {items.map((item) => (
        <div key={item.key} className="flex items-start gap-2 text-sm text-text">
          <Icon className="mt-0.5 size-4 shrink-0 text-warning-strong" aria-hidden="true" />
          <div className="min-w-0 flex-1">{item.content}</div>
        </div>
      ))}
      {children}
    </div>
  );
}

/**
 * A one-line error under a field or a form ("Amount must be more than
 * zero", "Couldn't save — try again"). Amber like every other error.
 *
 * @param {{ children: import("react").ReactNode, size?: "sm" | "xs", className?: string }} props
 */
export function InlineError({ children, size = "sm", className }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-warning-strong", size === "xs" ? "text-xs" : "text-sm", className)}>
      <CircleAlertIcon className={cn("shrink-0", size === "xs" ? "mt-px size-3" : "mt-0.5 size-3.5")} aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
