import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": srcDir,
    },
  },
  server: {
    port: 5173,
    // PUBLIC_ORIGIN and the API's CORS allowlist name this exact origin, so
    // vite quietly sliding to 5174 when 5173 is taken produces a wall of CORS
    // errors instead of a working dev server. Fail loudly instead — `pnpm dev`
    // frees the port before we get here.
    strictPort: true,
  },
  // Vite's default envDir is this package's own directory; the repo keeps a
  // single .env at the root (see apps/api/src/env.js, packages/schema's
  // seed/drizzle configs), so VITE_* vars — VITE_API_URL in particular —
  // would otherwise silently never load in dev.
  envDir: fileURLToPath(new URL("../../", import.meta.url)),
});
