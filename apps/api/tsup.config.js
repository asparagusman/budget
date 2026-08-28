import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries: the server, and the one-shot migrator the compose
  // `migrate` service runs before the API starts (see apps/api/src/migrate.js).
  entry: ["src/index.js", "src/migrate.js"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  // @budget/schema and @budget/engine resolve to raw source via
  // node_modules. Inlining them keeps the runtime image a single bundle
  // with no workspace layout to reproduce. Everything else (genuine
  // npm deps) must stay external explicitly — tsup's automatic
  // dependency-externalization heuristic doesn't reliably apply to
  // packages that are only imported transitively (e.g. `pg`, imported by
  // @budget/schema rather than by src/index.ts directly), so this list is
  // spelled out rather than left to the default.
  noExternal: ["@budget/schema", "@budget/engine"],
  external: [
    "hono",
    "@hono/node-server",
    "@hono/zod-validator",
    "pg",
    "drizzle-orm",
    "zod",
    "dotenv",
    "@simplewebauthn/server",
  ],
});
