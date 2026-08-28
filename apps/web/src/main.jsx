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
import { CommandPalette } from "./components/command-palette.jsx";
import "./styles/app.css";

const queryClient = new QueryClient();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found.");

createRoot(rootEl).render(
  <StrictMode>
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
              <RouterProvider router={router} />
              <CommandPalette />
              <Toaster />
            </TooltipProvider>
          </AuthProvider>
        </SettingsProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
