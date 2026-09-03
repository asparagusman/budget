import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./router.jsx";
import { ThemeProvider } from "./lib/theme.jsx";
import { SettingsProvider } from "./lib/settings.jsx";
import { AuthProvider } from "./lib/auth.jsx";
import { TooltipProvider } from "./components/ui/tooltip.jsx";
import { Toaster } from "./components/ui/sonner.jsx";
import { ConfirmProvider } from "./components/confirm-dialog.jsx";
import { AppErrorBoundary } from "./components/app-error-boundary.jsx";
import "./styles/app.css";

const queryClient = new QueryClient();

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
