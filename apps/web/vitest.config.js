import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Deliberately NOT `mergeConfig(viteConfig, …)`. vite.config.js loads the
// Tailwind plugin, which compiles the whole stylesheet on every run — and no
// test here asserts anything about compiled CSS, because a class name in the
// DOM is what our components decide and the utility it expands to is
// Tailwind's business. What this file does have to keep in step with
// vite.config.js is the `@` alias, since half of src/ imports through it.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // jsdom rather than happy-dom: the component tests below turn on Radix,
    // which reaches for APIs (pointer events, ResizeObserver) that only one
    // of the two implements enough of.
    //
    // jsdom is pinned to v25 in package.json, not left to float. From v26 it
    // pulls an ESM-only encoding sniffer that vitest's environment loader
    // `require`s, and the whole run dies before collection with
    // ERR_REQUIRE_ESM and no test names in the output.
    environment: "jsdom",
    setupFiles: ["./src/test/setup.js"],
    include: ["src/**/*.test.{js,jsx}"],
    restoreMocks: true,
  },
});
