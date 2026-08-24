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
  },
  // Vite's default envDir is this package's own directory; the repo keeps a
  // single .env at the root (see apps/api/src/env.js, packages/schema's
  // seed/drizzle configs), so VITE_* vars — VITE_API_URL in particular —
  // would otherwise silently never load in dev.
  envDir: fileURLToPath(new URL("../../", import.meta.url)),
});
