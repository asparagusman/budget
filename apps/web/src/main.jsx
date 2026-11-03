import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { router } from "./router.jsx";
import { ThemeProvider } from "./lib/theme.jsx";
import { SettingsProvider } from "./lib/settings.jsx";
import { AuthProvider, invalidateAuthState, wasSignedIn } from "./lib/auth.jsx";
import { createExpiryRedirect, onSessionExpired } from "./lib/session-expiry.js";
import { TooltipProvider } from "./components/ui/tooltip.jsx";
import { Toaster } from "./components/ui/sonner.jsx";
import { ConfirmProvider } from "./components/confirm-dialog.jsx";
import { AppErrorBoundary } from "./components/app-error-boundary.jsx";
import { queryClient } from "./lib/query-client.js";
import "./styles/app.css";

// A session that ended while this tab was open — 30 days up, or revoked from
// another device — answers every request with a 401. Send the operator to
// sign in, once, with a sentence saying why; otherwise each screen renders
// its own error and nothing explains them. The cached auth state goes first,
// or /login's guard would read the stale "signed in" and bounce straight
// back. The failing queries themselves are left to unmount with their page.
onSessionExpired(
  createExpiryRedirect({
    currentPath: () => window.location.pathname,
    isSignedIn: wasSignedIn,
    redirect: () => {
      invalidateAuthState();
      toast.info("You've been signed out. Sign in again to carry on.");
      return router.navigate({ to: "/login", replace: true });
    },
  }),
);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found.");

createRoot(rootEl).render(
  <StrictMode>
    {/* Outermost, and outside ThemeProvider on purpose: a throw inside the
        theme provider itself still has to render something, and ErrorScreen
        uses only tokens that resolve without it. */}
    <AppErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          {/* SettingsProvider now fetches GET /settings via react-query (see
              lib/settings.jsx), so it needs QueryClientProvider above it —
              that's the only reason this swapped places with phase 03's
              original ThemeProvider > SettingsProvider > QueryClientProvider
              order. */}
          <SettingsProvider>
            <AuthProvider>
              <TooltipProvider>
                {/* Above the router so any screen can `await confirm(...)`
                    before a destructive mutation without carrying its own
                    dialog state. */}
                <ConfirmProvider>
                  {/* <CommandPalette /> is mounted by the root route, not here:
                      it calls useNavigate(), which needs the router's context.
                      As a sibling of <RouterProvider> it had none, so every
                      palette entry and every `g` chord threw on click. */}
                  <RouterProvider router={router} />
                  <Toaster />
                </ConfirmProvider>
              </TooltipProvider>
            </AuthProvider>
          </SettingsProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
