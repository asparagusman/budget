import { Skeleton } from "@/components/ui/skeleton.jsx";

// Shared by the dashboard and the app shell (see route-skeletons.jsx), so the
// placeholder the shell paints on a click and the one the page shows while its
// data loads are the same placeholder, and swapping one for the other moves
// nothing.

// The five cards under the cycle summary. One column on a phone, two from `lg`
// (income across the top, then pairs), three from `xl`: income over a
// two-wide span, the standing orders in the third column running down beside
// it, and goals under them. The middle row is `1fr`, so a card spanning into it
// is left out of the auto rows' sizing — the tall transfers list and the
// bills/net-worth pair set the height between them and the slack lands in
// those cards, never as a gap under one. DOM order is the phone's order.
export const CARD_GRID =
  "grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2 xl:grid-cols-3 xl:grid-rows-[auto_1fr_auto]";

/**
 * Card-shaped placeholders in the real grid positions, so nothing moves when
 * the data lands (phases/10-dashboard.md "Skeletons, not spinners").
 */
export function DashboardSkeleton() {
  return (
    <>
      <Skeleton className="h-36 rounded-(--radius-card)" />
      <div className={CARD_GRID}>
        <Skeleton className="h-64 rounded-(--radius-card) lg:col-span-2" />
        <Skeleton className="h-96 rounded-(--radius-card) xl:row-span-2" />
        <Skeleton className="h-72 rounded-(--radius-card) xl:row-span-2" />
        <Skeleton className="h-72 rounded-(--radius-card) xl:row-span-2" />
      </div>
    </>
  );
}
