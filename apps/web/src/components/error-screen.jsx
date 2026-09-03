import { useState } from "react";
import { Button } from "@/components/ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.jsx";
import { ApiUnreachableError } from "@/lib/api-error.js";

/**
 * The screen for a failure that stopped a route from rendering at all.
 *
 * Before this existed, a route guard that threw produced a blank page and a
 * console warning ("The following error wasn't caught by any route"), which
 * is the worst possible pairing: the user sees nothing, and the one place
 * the reason exists is a place they are not looking. Every route error now
 * lands here instead.
 *
 * @param {{ error: unknown, onRetry?: () => void }} props
 */
export function ErrorScreen({ error, onRetry }) {
  const [retrying, setRetrying] = useState(false);
  const unreachable = error instanceof ApiUnreachableError;
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error.");

  function handleRetry() {
    setRetrying(true);
    // The retry paths (router.invalidate, a refetch) resolve by re-rendering
    // this component away, so there is no "finished" callback to await — the
    // flag exists only to stop a second click landing mid-retry, and a
    // reload clears it if the retry itself fails.
    Promise.resolve(onRetry?.()).finally(() => setRetrying(false));
  }

  return (
    <div className="flex h-dvh flex-col items-center justify-center overflow-y-auto bg-bg p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{unreachable ? "Can't reach the server" : "Something went wrong"}</CardTitle>
          <CardDescription>
            {unreachable
              ? "The app loaded, but the API didn't answer. It's usually still starting up."
              : message}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* import.meta.env.DEV is compiled out of the production bundle, so
              this whole block — and the local-only instructions in it —
              never ships to the deployed app. */}
          {unreachable && import.meta.env.DEV ? (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">In local development this means one of:</p>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                <li>
                  the API isn't running — <code className="font-mono">pnpm dev</code> starts it
                </li>
                <li>
                  Docker Desktop is off, so there's no database —{" "}
                  <code className="font-mono">pnpm status</code> shows which
                </li>
              </ul>
            </div>
          ) : null}

          <div className="flex gap-2">
            <Button onClick={handleRetry} disabled={retrying}>
              {retrying ? "Retrying…" : "Try again"}
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>

          {/* The underlying message stays available for a bug report even
              when the headline above has been replaced by friendlier words,
              but it is collapsed — it is nearly always noise to the reader. */}
          {unreachable ? (
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer select-none">Technical details</summary>
              <p className="mt-2 font-mono text-xs break-words">{message}</p>
            </details>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
