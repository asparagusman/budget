import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The dashboard suite migrates a PGlite database per file, which costs a
    // few seconds before the first assertion runs. The default 5s timeout is
    // for a unit test; this one is for a Postgres.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
