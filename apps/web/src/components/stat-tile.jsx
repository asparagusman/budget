import { cn } from "@/lib/utils.js";

/**
 * Muted label above a dominant figure, per the aesthetic target: the
 * headline number should beat its label by a clear step in size and weight.
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
