import { Skeleton } from "@/components/ui/skeleton.jsx";
import { cn } from "@/lib/utils.js";

// In-page loading states. Route-level Suspense already covers the gap while a
// route's CHUNK is in flight (`RouteFallback`, shell/app-shell.jsx); this
// covers the gap after that, while the route's own queries are in flight.
//
// Every one of these sites used to render `null` while loading, so a section
// occupied no height at all and then pushed everything below it down when the
// data landed — the layout shift phase 10's "Skeletons, not spinners" line is
// about, and the input-delay complaint in adjustment #11.
//
// Two rules these all follow:
//
//   - A placeholder is the SHAPE of what is coming, at roughly its height. A
//     spinner reserves nothing, so it fixes the "blank" and not the shift.
//   - `aria-busy` plus one visually-hidden word. Assistive tech gets "loading"
//     once, not a description of grey rectangles.

/**
 * @param {{ label: string, className?: string, children: import("react").ReactNode }} props
 */
function Loading({ label, className, children }) {
  return (
    <div aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/**
 * A `<DataList>`-shaped placeholder: one rounded card, rows divided the same
 * way, each with a primary and secondary line.
 *
 * @param {{ rows?: number, label?: string, className?: string }} props
 */
export function ListSkeleton({ rows = 4, label = "Loading list", className }) {
  return (
    <Loading label={label} className={className}>
      <div className="divide-y divide-border overflow-hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {/* Widths vary per row so the block reads as a list of
                  different things rather than as a striped placeholder. */}
              <Skeleton className="h-4" style={{ width: `${40 + ((i * 17) % 35)}%` }} />
              <Skeleton className="h-3" style={{ width: `${25 + ((i * 23) % 30)}%` }} />
            </div>
            <Skeleton className="h-4 w-16 shrink-0" />
          </div>
        ))}
      </div>
    </Loading>
  );
}

/**
 * Card placeholders in a grid, for sections that render a card per record.
 *
 * @param {{ cards?: number, height?: number, label?: string, className?: string }} props
 */
export function CardsSkeleton({ cards = 3, height = 220, label = "Loading", className }) {
  return (
    <Loading label={label} className={className}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: cards }, (_, i) => (
          <Skeleton key={i} className="rounded-(--radius-card)" style={{ height }} />
        ))}
      </div>
    </Loading>
  );
}

/**
 * One card-shaped block, for a section that is a single panel — a table, a
 * grid of inputs, a timeline.
 *
 * @param {{ height?: number, label?: string, className?: string }} props
 */
export function PanelSkeleton({ height = 240, label = "Loading", className }) {
  return (
    <Loading label={label} className={cn("w-full", className)}>
      <Skeleton className="w-full rounded-(--radius-card)" style={{ height }} />
    </Loading>
  );
}
