// Applies pending migrations, then exits. Its whole reason to exist is the
// deployment order in phases/11-polish-mobile-import.md — "pull, rebuild,
// migrate, restart, in that order, with migrations before restart" — which
// on a thin client with only Docker installed is otherwise unreachable:
// `pnpm db:migrate` is drizzle-kit, and drizzle-kit is a devDependency that
// the production API image deliberately doesn't ship.
//
// Compose runs this as a one-shot `migrate` service that `api` waits on with
// `service_completed_successfully`, so the ordering is enforced by the
// stack rather than by the operator remembering it. Running it twice is a
// no-op: drizzle records every applied migration in
// `drizzle.__drizzle_migrations` and skips what's already there.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "@budget/schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Refusing to migrate: DATABASE_URL is not set.");
  process.exit(1);
}

// In the image this file is /app/dist/migrate.js and the SQL sits at
// /app/migrations (see apps/api/Dockerfile). Outside it, there is no such
// folder — say so instead of failing with an opaque ENOENT.
const migrationsFolder =
  process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../migrations", import.meta.url));

if (!existsSync(migrationsFolder)) {
  console.error(`Refusing to migrate: no migrations folder at ${migrationsFolder}.`);
  console.error("Set MIGRATIONS_DIR, or run `pnpm db:migrate` from a checkout instead.");
  process.exit(1);
}

const db = createDb(databaseUrl);
await migrate(db, { migrationsFolder });
console.log(`Migrations applied from ${migrationsFolder}.`);
process.exit(0);
