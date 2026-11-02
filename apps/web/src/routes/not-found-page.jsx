import { Link } from "@tanstack/react-router";
import { CompassIcon } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { PageHeader } from "@/components/page-header.jsx";

/**
 * An address the app has no screen for — a mistyped URL, an old bookmark.
 * Rendered inside the shell, so the sidebar and the phone's menu are still
 * there to go anywhere else; the router's own fallback was a bare "Not Found"
 * on an empty page with no way out but the back button.
 */
export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState
        icon={CompassIcon}
        title="There's no page at this address"
        description="It may have moved, or the link was mistyped. Everything is still reachable from the menu."
        action={
          <Button asChild>
            <Link to="/">Go to the overview</Link>
          </Button>
        }
      />
    </>
  );
}
