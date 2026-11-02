import { useState } from "react";
import { RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { Notice } from "@/components/notice.jsx";
import { ApiUnreachableError } from "@/lib/api-error.js";

/**
 * What a section shows when its query failed — in place of the section, never
 * in place of its empty state. The two used to be the same branch: an API
 * error on /allocation rendered "No allocation plan yet" beside the New plan
 * button, which invited creating a duplicate of a plan that existed all along.
 * "Nothing here" and "couldn't load what's here" have to look different.
 *
 * An expired session never reaches this: main.jsx sends a 401 to /login.
 *
 * @param {{
 *   error: unknown,
 *   onRetry: () => unknown,
 *   what?: string,
 *   compact?: boolean,
 *   className?: string,
 * }} props `what` names the thing that didn't load ("your goals"), so the
 *   message says what is missing rather than only that something failed.
 */
export function QueryError({ error, onRetry, what, compact = false, className }) {
  const [retrying, setRetrying] = useState(false);
  const unreachable = error instanceof ApiUnreachableError;
  const detail = unreachable
    ? "The server didn't answer — it may still be starting up."
    : error instanceof Error
      ? error.message
      : null;

  function handleRetry() {
    setRetrying(true);
    // A successful refetch re-renders this component away, so there is no
    // "done" to await beyond the promise itself; the flag only stops a
    // second press landing mid-retry.
    Promise.resolve(onRetry()).finally(() => setRetrying(false));
  }

  return (
    <div role="alert" className={className}>
      <Notice kind="error" compact={compact}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="font-medium">{what ? `Couldn't load ${what}.` : "Couldn't load this."}</p>
            {detail ? <p className="text-text-muted">{detail}</p> : null}
          </div>
          <Button variant="outline" size="sm" onClick={handleRetry} disabled={retrying}>
            <RotateCwIcon aria-hidden="true" className={retrying ? "animate-spin" : undefined} />
            Try again
          </Button>
        </div>
      </Notice>
    </div>
  );
}
