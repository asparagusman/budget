import { PageHeader } from "@/components/page-header.jsx";
import { EmptyState } from "@/components/empty-state.jsx";

/** @import { NavItem } from "@/lib/nav.js" */

/**
 * Every destination in NAV_ITEMS renders one of these until its own phase
 * fills it in — the route, its nav entry and its empty state already work.
 *
 * @param {{ item: NavItem }} props
 */
export function PlaceholderPage({ item }) {
  return (
    <>
      <PageHeader title={item.label} />
      <EmptyState
        icon={item.icon}
        title={`Built in phase ${item.phase}`}
        description={`${item.label} lands in phase ${item.phase}. For now this is just the route, the navigation entry and this empty state.`}
      />
    </>
  );
}
