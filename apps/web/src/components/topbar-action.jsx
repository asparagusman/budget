import { createPortal } from "react-dom";
import { useTopBarSlotEl } from "@/lib/topbar-slot.js";

/**
 * Renders into the mobile top bar's one contextual-action slot. A no-op on
 * desktop, where the top bar doesn't render at all and a page's own
 * <PageHeader actions> covers the same need.
 *
 * @param {{ children: import("react").ReactNode }} props
 */
export function TopBarAction({ children }) {
  const el = useTopBarSlotEl("action");
  if (!el) return null;
  return createPortal(children, el);
}
