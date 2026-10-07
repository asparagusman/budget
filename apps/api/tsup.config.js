import { defineConfig } from "tsup";

export default defineConfig({
  // Three entries: the server; the one-shot migrator the compose `migrate`
  // service runs before the API starts (see apps/api/src/migrate.js); and the
  // break-glass invite CLI. The runtime image has no pnpm and no src/, so
  // `pnpm auth:invite` cannot run there — `node dist/scripts/auth-invite.js`
  // can (infra/README.md, "Recovering when every passkey is gone"). Output
  // paths mirror src/, because src/ is the entries' common root.
  entry: ["src/index.js", "src/migrate.js", "src/scripts/auth-invite.js"],
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
