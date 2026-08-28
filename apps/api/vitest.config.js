import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The importer's tests read the household's real workbook, which lives in
    // the gitignored `.claude/plans/` directory. On a machine without it the
    // suite is empty rather than failing — see parse.test.js, which says so
    // out loud rather than skipping quietly.
    passWithNoTests: true,
  },
});
