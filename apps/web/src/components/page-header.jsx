import { cn } from "@/lib/utils.js";

/**
 * @param {{
 *   title: import("react").ReactNode,
 *   description?: import("react").ReactNode,
 *   actions?: import("react").ReactNode,
 *   className?: string,
 * }} props
 */
export function PageHeader({ title, description, actions, className }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div>
        <h1 className="text-xl font-semibold text-text sm:text-2xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
