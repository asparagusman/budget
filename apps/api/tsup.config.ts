import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  // @budget/schema and @budget/engine resolve to raw .ts source via
  // node_modules, and Node's built-in type-stripping refuses to run on
  // files under node_modules — so these two MUST be inlined into the
  // bundle rather than left as runtime imports. Everything else (genuine
  // npm deps) must stay external explicitly — tsup's automatic
  // dependency-externalization heuristic doesn't reliably apply to
  // packages that are only imported transitively (e.g. `pg`, imported by
  // @budget/schema rather than by src/index.ts directly), so this list is
  // spelled out rather than left to the default.
  noExternal: ["@budget/schema", "@budget/engine"],
  external: ["hono", "@hono/node-server", "pg", "drizzle-orm", "zod", "dotenv"],
});
