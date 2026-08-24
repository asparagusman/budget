import { cn } from "@/lib/utils.js";

/**
 * The mobile answer to a table: stacked rows with primary/secondary/trailing
 * slots. Feature phases render `<table>` at `md:` and up and `<DataList>`
 * below it — a desktop table that becomes a horizontally-scrolling table on
 * a phone is a failure, per the phase README.
 *
 * @param {{ children: import("react").ReactNode, className?: string }} props
 */
export function DataList({ children, className }) {
  return (
    <ul
      className={cn(
        "divide-y divide-border overflow-hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card)",
        className,
      )}
    >
      {children}
    </ul>
  );
}

/**
 * @param {{
 *   primary: import("react").ReactNode,
 *   secondary?: import("react").ReactNode,
 *   trailing?: import("react").ReactNode,
 *   onClick?: () => void,
 *   className?: string,
 * }} props
 */
export function DataListRow({ primary, secondary, trailing, onClick, className }) {
  const Comp = onClick ? "button" : "div";

  return (
    <li>
      <Comp
        type={onClick ? "button" : undefined}
        onClick={onClick}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-4 py-3 text-left",
          onClick &&
            "transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)",
          className,
        )}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text">{primary}</p>
          {secondary ? (
            <p className="truncate text-xs text-text-muted">{secondary}</p>
          ) : null}
        </div>
        {trailing ? (
          <div className="shrink-0 text-sm text-text">{trailing}</div>
        ) : null}
      </Comp>
    </li>
  );
}
