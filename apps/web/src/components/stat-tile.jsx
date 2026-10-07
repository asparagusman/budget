import { Children, cloneElement, isValidElement } from "react";
import { cn } from "@/lib/utils.js";

/**
 * Muted label above a dominant figure, per the aesthetic target: the
 * headline number should beat its label by a clear step in size and weight.
 *
 * A tile is its own floating card. For a row of summary figures at the top of
 * a page, reach for <StatGroup> instead — see there for why.
 *
 * @param {{
 *   label: import("react").ReactNode,
 *   value: import("react").ReactNode,
 *   delta?: import("react").ReactNode,
 *   sparkline?: import("react").ReactNode,
 *   className?: string,
 * }} props
 */
export function StatTile({ label, value, delta, sparkline, className }) {
  return (
    <div
      className={cn(
        "rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)",
        className,
      )}
    >
      <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
        {label}
      </p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="text-3xl font-bold tracking-tight text-text">{value}</p>
        {delta}
      </div>
      {sparkline ? <div className="mt-3">{sparkline}</div> : null}
    </div>
  );
}

/**
 * @typedef {{
 *   label: import("react").ReactNode,
 *   value: import("react").ReactNode,
 *   delta?: import("react").ReactNode,
 *   hint?: import("react").ReactNode,
 *   lead?: boolean,
 *   tone?: "default" | "attention",
 *   span?: string,
 * }} StatProps
 */

/**
 * One figure inside a <StatGroup>. Renders nothing of its own surface — the
 * group owns the card, the dividers and the placement. `lead` marks the one
 * figure the page is about; it must be the group's first child.
 *
 * `tone="attention"` turns the cell amber — "needs a look", like every other
 * amber in the app (a goal shortfall, say). Not red: red is money out.
 *
 * @param {StatProps} props
 */
export function Stat({ label, value, delta, hint, lead = false, tone = "default", span }) {
  return (
    <div
      className={cn(
        // Three subgrid rows — label, figure, hint — shared with every other
        // figure on the same line, so a label that wraps to two lines at
        // 375px pushes its neighbour's figure down with it and the two
        // figures still sit level.
        "row-span-3 grid min-w-0 grid-rows-subgrid gap-y-1 bg-surface p-4 lg:px-5",
        tone === "attention" && "bg-warning-soft",
        span,
      )}
    >
      <dt
        className={cn(
          "text-xs font-medium tracking-wide text-balance uppercase",
          tone === "attention" ? "text-warning-strong" : "text-text-subtle",
        )}
      >
        {label}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-end justify-between gap-x-3 gap-y-1 self-end">
        <span
          className={cn(
            "font-bold tracking-tight text-text tabular-nums",
            lead ? "text-3xl" : "text-xl lg:text-2xl",
          )}
        >
          {value}
        </span>
        {delta}
      </dd>
      {hint ? (
        <dd className={cn("text-xs text-pretty", tone === "attention" ? "text-text" : "text-text-muted")}>{hint}</dd>
      ) : null}
    </div>
  );
}

// Static strings so Tailwind's scanner sees every class it has to generate.
/** @type {Record<number, string>} */
const DESKTOP_COLUMNS = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
};

/**
 * A page's summary figures as one surface split by hairlines, rather than a
 * grid of separate floating tiles.
 *
 * Separate tiles were costing the phone its whole first screen: four cards,
 * four shadows, four sets of 20px padding and a 16px gutter between each, so
 * on /goals the operator scrolled 360px before reaching a goal. One surface
 * with 1px dividers carries the same figures in about half the height, and
 * reads as one statement ("here is where this page stands") instead of four
 * equal-weight objects.
 *
 * Placement: below `lg`, two columns — a `lead` figure takes the whole first
 * line, and a figure left alone on the last line widens to fill it, so there
 * is never an empty cell showing the divider colour. At `lg` and up, every
 * figure sits on one line; a lead in a group of three takes two columns of
 * four, which is the width the old tiles gave it.
 *
 * The dividers are the container's own background showing through a 1px
 * gap, which works for any arrangement of cells without per-cell border
 * bookkeeping.
 *
 * @param {{ children: import("react").ReactNode, className?: string, "aria-label"?: string }} props
 */
export function StatGroup({ children, className, "aria-label": ariaLabel }) {
  const items = /** @type {import("react").ReactElement<StatProps>[]} */ (
    Children.toArray(children).filter(isValidElement)
  );
  const hasLead = items[0]?.props.lead === true;
  const rest = hasLead ? items.length - 1 : items.length;
  const leadWide = hasLead && items.length === 3;
  const desktopColumns = leadWide ? 4 : Math.min(items.length, 4);

  return (
    <dl
      aria-label={ariaLabel}
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-(--radius-card) bg-border shadow-(--shadow-card)",
        DESKTOP_COLUMNS[desktopColumns],
        className,
      )}
    >
      {items.map((item, index) => {
        const isLead = hasLead && index === 0;
        const restIndex = hasLead ? index - 1 : index;
        const alone = !isLead && rest % 2 === 1 && restIndex === rest - 1;
        const span = cn(
          (isLead || alone) && "col-span-2",
          isLead && leadWide ? "lg:col-span-2" : "lg:col-span-1",
        );
        return cloneElement(item, { span, lead: isLead });
      })}
    </dl>
  );
}
