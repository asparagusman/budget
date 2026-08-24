import { cn } from "@/lib/utils.js";

/**
 * "Empty" is what the operator sees on day one — it must explain what to do
 * next, not just say "No data".
 *
 * @param {{
 *   icon?: import("react").ComponentType<{ className?: string, "aria-hidden"?: import("react").AriaAttributes["aria-hidden"] }>,
 *   title: import("react").ReactNode,
 *   description?: import("react").ReactNode,
 *   action?: import("react").ReactNode,
 *   className?: string,
 * }} props
 */
export function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-(--radius-card) bg-surface px-6 py-12 text-center shadow-(--shadow-card)",
        className,
      )}
    >
      {Icon ? (
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-surface-muted text-text-subtle">
          <Icon className="size-6" aria-hidden="true" />
        </div>
      ) : null}
      <h2 className="text-base font-semibold text-text">{title}</h2>
      {description ? (
        <p className="mt-1.5 max-w-sm text-sm text-text-muted">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
