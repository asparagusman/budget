import { GoalsTabs } from "@/components/goals-tabs.jsx";
import { CardsSkeleton, ListSkeleton, PanelSkeleton, SectionsSkeleton, StatsSkeleton } from "@/components/loading.jsx";
import { DashboardSkeleton } from "@/components/dashboard-skeleton.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { PageSection } from "@/components/page-section.jsx";
import { Skeleton } from "@/components/ui/skeleton.jsx";

// What the app shell paints the instant a page is chosen, before the page
// itself renders (see `PaintFirst` in shell/app-shell.jsx). Drawing a page is
// the slow part of a click — the data is usually already in from the hover —
// and until it finishes the browser can paint nothing, so the page being left
// sat frozen and the click looked ignored. This is cheap enough to paint
// immediately.
//
// Each one is that page's own loading state — the real title, the real
// sections, the same placeholders the page shows while its queries are in
// flight — so when the page takes over, whether still loading or already
// filled in, nothing jumps. Keep them in step with the pages: a skeleton that
// no longer matches its page is a layout shift on every visit.
//
// In the main bundle on purpose: a skeleton that had to download first would
// defeat the point. They're built from the shared placeholders and come to a
// couple of KB.

/** @type {Record<string, () => import("react").ReactNode>} */
const SKELETONS = {
  "/": () => (
    <>
      <PageHeader title="Overview" />
      <div className="flex flex-col gap-4 md:gap-6">
        <DashboardSkeleton />
      </div>
    </>
  ),
  "/accounts": () => (
    <>
      <PageHeader title="Accounts" />
      <StatsSkeleton labels={["Net worth", "Stale balances"]} hints={false} label="Loading the accounts summary" />
      <ListSkeleton rows={5} label="Loading accounts" />
    </>
  ),
  "/income": () => (
    <>
      <PageHeader title="Income" />
      <div
        aria-hidden="true"
        className="flex h-24 flex-col justify-center gap-2 rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5"
      >
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-6 w-64 max-w-full" />
      </div>
      <PageSection title="Variant schedule">
        <PanelSkeleton height={140} label="Loading variant schedule" />
      </PageSection>
      <PageSection title="Variants">
        <CardsSkeleton cards={3} height={300} label="Loading income variants" />
      </PageSection>
    </>
  ),
  "/costs/fixed": () => (
    <>
      <PageHeader title="Fixed Costs" />
      <StatsSkeleton lead labels={["Bills contribution", "Total bills", "Due in 14 days"]} label="Loading the bills summary" />
      <SectionsSkeleton label="Loading bills" />
    </>
  ),
  "/costs/variable": () => (
    <>
      <PageHeader title="Variable Costs" />
      <StatsSkeleton
        lead
        labels={["Essential", "Non-essential", "Trailing average vs budget", "Cycles recorded"]}
        label="Loading the variable costs summary"
      />
      <SectionsSkeleton sections={[4, 3]} label="Loading budgets" />
      <PanelSkeleton height={360} label="Loading cycles" />
    </>
  ),
  "/allocation": () => (
    <>
      <PageHeader title="Allocation" />
      {/* The plan / date / cadence bar. */}
      <PanelSkeleton height={92} label="Loading plans" />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <SectionsSkeleton sections={[3, 4, 2]} label="Loading this allocation" />
        <PanelSkeleton height={420} label="Loading transfers" />
      </div>
    </>
  ),
  "/goals": () => (
    <>
      <PageHeader title="Goals" />
      <GoalsTabs />
      <StatsSkeleton labels={["Active goals", "Required", "Allocated", "Shortfall"]} label="Loading the goals summary" />
      <CardsSkeleton cards={3} height={280} label="Loading goals" />
    </>
  ),
  "/goals/house": () => (
    <>
      <PageHeader title="Goals" />
      <GoalsTabs />
      <CardsSkeleton cards={3} height={420} label="Loading house scenarios" />
    </>
  ),
  "/projections": () => (
    <>
      <PageHeader title="Projections" />
      <PageSection title="Net worth">
        <PanelSkeleton height={340} label="Loading net worth" />
      </PageSection>
      <PageSection title="Projected balances">
        <PanelSkeleton height={320} label="Loading projections" />
      </PageSection>
    </>
  ),
  "/calendar": () => (
    <>
      <PageHeader title="Calendar" />
      <PanelSkeleton height={600} label="Loading the calendar" />
    </>
  ),
};

/** Every admin tab shares one frame: the tab bar, then a list. */
function AdminSkeleton() {
  return (
    <>
      <PageHeader title="Admin" />
      <Skeleton className="h-9 w-full max-w-lg rounded-(--radius-control)" />
      <ListSkeleton rows={3} label="Loading" />
    </>
  );
}

/**
 * Anything without its own: a heading bar and two cards — the shape of a page
 * rather than a spinner, so the frame doesn't collapse and re-expand.
 */
function GenericSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading page</span>
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/**
 * The placeholder for the page at `path` — a route's full path, e.g.
 * `/costs/fixed`, not the URL (so `/costs/fixed/$billId/history` is one key).
 *
 * @param {{ path: string | undefined }} props
 */
export function RouteSkeleton({ path }) {
  if (path?.startsWith("/admin/")) return <AdminSkeleton />;
  const Page = path === undefined ? undefined : SKELETONS[path];
  return Page ? <Page /> : <GenericSkeleton />;
}
