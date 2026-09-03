# budget

A household budgeting app for a single operator. Postgres + Hono API + React web client, with all
financial rules isolated in one pure calculation package.

**The app is an instrument panel, not an autopilot.** It computes, projects, visualises and flags.
It never adjusts a financial figure on its own, never auto-balances, never silently corrects. Goals
report an ETA and a required contribution; they never write an allocation. Conflicts are surfaced,
not resolved.

Nothing about a particular household is hardcoded — no paydays, bill names, category lists or
seasonality assumptions. Every one of those is a row in a table the operator edits.

---

## Requirements

- Node **>= 22.3.0**
- pnpm **10.34.5** (`corepack enable`)
- Postgres 16 (or `infra/docker-compose.dev.yml`)

## Getting started

```bash
pnpm install
cp .env.example .env      # then fill in DATABASE_URL, SESSION_SECRET, PUBLIC_ORIGIN
pnpm db:migrate
pnpm db:seed
pnpm dev                  # api on :3001, web on :5173
```

## Commands

Every one of these runs from the repo root and fans out across the workspaces.

| Command | Does |
|---|---|
| `pnpm dev` | API + web together |
| `pnpm typecheck` | `tsc --noEmit` over the JSDoc types — **the** correctness gate |
| `pnpm test` | Vitest |
| `pnpm build` | API bundle (tsup) + web bundle (Vite) |
| `pnpm db:generate` | Generate a migration from the Drizzle schema |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:seed` | Idempotent seed (infrastructure rows only, never household data) |
| `pnpm status` | What's holding :3001/:5173/:5432, what's in docker, what's stale |
| `pnpm stop` | Kill this repo's dev processes and stop any `api`/`web` container |
| `pnpm dev:api` / `pnpm dev:web` | One side only |
| `pnpm api <script>` | Run any `apps/api` script, e.g. `pnpm api auth:invite` |
| `pnpm web <script>` | Run any `apps/web` script, e.g. `pnpm web build` |

`api`/`web` are `pnpm --filter` prefixes, so anything after them runs scoped to that package's
directory — you never need to `cd` into a workspace. For a one-off command that isn't a declared
script, use `exec`: `pnpm api exec node src/scripts/auth-invite.js`.

**Nothing here needs docker rebuilt.** Backend edits included — `pnpm dev` runs the API under
`node --watch`, so a change to `apps/api` is live on save. Rebuilding images is only for testing a
prod-like build or deploying.

`pnpm dev` is safe to run over a broken session, and over a machine that has just booted. Before
starting anything it:

1. sweeps this repo's leftover dev processes,
2. **starts Docker Desktop if it isn't running**, and waits for the engine,
3. stops any `api`/`web` container holding a port,
4. brings the db up and waits for it to actually accept a connection on 5432,
5. **applies any pending migrations**, the same guarantee compose's one-shot `migrate` service
   gives the deployed stack — so pulling a branch that adds a column can't leave you with an api
   that starts cleanly and then 500s every request.

If any of those can't be completed it **refuses to start** rather than launching an api that
cannot work — those failures surface in the browser as a wall of CORS/NetworkError messages, or as
Postgres `column ... does not exist` buried in a Drizzle stack trace, neither of which points
anywhere near the real cause. `pnpm status` says what's up, what's held and whether Postgres is
genuinely answering. `pnpm dev --no-db` skips steps 2, 4 and 5 if you really want it.

<details>
<summary>Why that sweep exists</summary>

Stopping a dev session on Windows does not reliably kill its descendants. `node --watch` is the
worst offender: it does *not* exit when the watched script throws — it prints the error and waits
for a file change. So a crashed API dev server stays resident and re-races for :3001 on your next
save, while a leaked vite still owns 5173 and pushes the real one to 5174, off the single origin
`PUBLIC_ORIGIN` and the CORS allowlist accept. A stale `api` container does the same to :3001. All
three surface in the browser as a wall of CORS/NetworkError noise that points nowhere near the
cause.

Hence: `apps/api`'s dev script tags itself with a `--budget-dev` marker arg (node ignores anything
after the entry script) so the sweep can identify its own strays precisely rather than pattern-
matching every `node --watch` on the machine; vite runs with `strictPort` so it fails loudly
instead of drifting; and `concurrently` runs with `--kill-others-on-fail` so a dead API takes the
web server down with it instead of leaving a half-up session that looks like a CORS bug.

</details>

### Docker

The full containerized stack (`infra/docker-compose.yml`) is for testing a prod-like build, not
day-to-day dev. Everyday work needs only the db container, which `pnpm dev` starts for you.

| Command | Does |
|---|---|
| `pnpm docker:up` | Build (never cached — avoids running stale code) + start the full stack, detached |
| `pnpm docker:down` | Stop and remove the full stack |
| `pnpm docker <args>` | Prefix for anything else, e.g. `pnpm docker ps`, `pnpm docker logs -f api` |
| `pnpm docker:db <args>` | Same, with `docker-compose.dev.yml` merged in — e.g. `pnpm docker:db up -d db` runs just Postgres with 5432 published |

The stack is four services, not three: a one-shot `migrate` container runs `dist/migrate.js` on
the api image and exits, and `api` waits for it to exit **successfully**. That is what makes
"pull, rebuild, migrate, restart" a single command on a deployed host, and what stops the app ever
starting against a schema older than its own code. `GET /health` reports the applied migration
count beside the one the running build expects, and answers **503** when they disagree.

Two traps worth knowing, both of which `pnpm dev` now handles on your behalf:

- `docker compose up` **reuses a cached image** unless you pass `--build`, so it will happily
  serve code from before your last commit. `pnpm docker:up` always builds.
- Bringing anything up with the base file *alone* recreates `db` without its published port, which
  silently breaks `pnpm db:migrate` and local dev's `DATABASE_URL`. Use `pnpm docker:db` for db work.

## Importing the old spreadsheet

**Settings → Import spreadsheet** (or `/import`, or "Import a spreadsheet" in the command palette)
takes an `.xlsx` export, parses it server-side, and shows every row it found grouped by what it
will become. Nothing is written until you confirm; every row is individually deselectable; defects
in the source workbook are flagged with an explanation rather than silently handled. The import is
additive and idempotent — re-importing the same file matches on natural keys and updates rather
than duplicating — and allocation plans land as **drafts**, because the app does not get to decide
what your standing orders are.

Afterwards it prints a reconciliation: every figure the spreadsheet held, beside what the app now
computes, with the differences explained.

## Layout

```
packages/
  engine/     pure calculation core — zero I/O, zero React, zero DB
  schema/     Drizzle tables + Zod schemas, shared by api and web
apps/
  api/        Hono
  web/        Vite + React 19 + Tailwind v4
infra/        docker-compose, database backup
```

Cross-workspace imports always use the package name (`@budget/engine`), never a relative path that
escapes a package.

---

## JavaScript + JSDoc

**There are no `.ts` files and no `.d.ts` files.** Sources are plain `.js` / `.jsx`; types live in
JSDoc and are checked by `tsc --noEmit` through `jsconfig.json` with `checkJs` and `strict`.
`typescript` is a single workspace-root tool, not a per-package dependency. `pnpm typecheck` is a
real gate, not a formality.

- Declare shapes as inline object literals — `@typedef {{ from: IsoDate, to: IsoDate }} DateWindow`
  — not `@typedef {object}` plus a stack of `@property` tags.
- Bring types across files with the `@import` tag, not inline `import()` types.
- There is no `export type`. A barrel re-exports types by re-declaring them as `@typedef` aliases;
  see [`packages/engine/src/index.js`](packages/engine/src/index.js).
- Omit `@returns` where the body makes it inferable. Keep it only where it is load-bearing — most
  often a factory whose object literal would otherwise widen `"flat"` to `string`.
- **Never use a JSDoc cast in place of a `!`.** JSDoc has no non-null assertion, and a cast is the
  wrong substitute: a cast that is wrong is silent. Use `mustGet` / `mustAt` / `mustFind` from
  [`packages/engine/src/invariant.js`](packages/engine/src/invariant.js), which throw at the point
  the assumption breaks. The one sanctioned cast in the repo is the Hono RPC client.
- Expect roughly **35% more lines than the equivalent TypeScript**. Under `strict`, every parameter
  needs a `@param` or it is implicitly `any`. That is the cost of this setup — not something to
  format away, and not a reason to disable `noImplicitAny` in one package.

### Two traps

**`maxNodeModuleJsDepth` must be repeated in every package's `jsconfig.json`.** Because the file is
*named* `jsconfig.json`, TypeScript forces its own default of `2` over any **inherited** value —
only a locally-set one wins. At `2`, `checkJs` typechecks dependencies' own `.js` sources and the
gate fails with hundreds of errors from `node_modules`. Setting it in `jsconfig.base.json` alone
does nothing. Don't tidy the duplicates away.

**A `.d.ts` needs a top-level import or export.** Without one it is a global script, so
`declare module "x"` *shadows* package `x` instead of augmenting it and all its exports vanish. The
repo currently has no `.d.ts` at all; adding one should feel like a defeat.

## Money

- **Integer cents everywhere.** Never a float. Columns and fields are named `*_cents` / `*Cents`.
- `Cents` is a **documentation alias** (`@typedef {number} Cents`), not a distinct type. It marks
  intent but will not stop a dollars value reaching a cents parameter. The enforcement is the naming
  rule, `toCents()` at every input edge, and the reconciliation tests. A missing `toCents()` at a
  boundary is a defect, because nothing else will catch it.
- Convert to a display string only at the render edge, via one shared `formatMoney()`.
- Division is the dangerous operation. Splitting an amount across N destinations always goes through
  `divideCents(total, weights)`, which allocates remainder cents by largest-remainder so totals
  reconcile exactly.

## Dates

- Calendar dates (due dates, paydays, targets) are Postgres `date` and `'YYYY-MM-DD'` strings.
  **No timezone, ever** — a bill due on the 14th is due on the 14th everywhere.
- Event timestamps (created, activated) are `timestamptz`.
- The engine is pure: it never calls `new Date()` or `Date.now()`. Callers pass `today` in. This is
  enforced by a test, not a convention.

## Testing

Vitest, colocated as `*.test.js`. `pnpm test` runs all three suites and needs nothing running —
no database, no dev server, no environment variables.

- **`packages/engine`** is the only package with a coverage bar: every exported function is tested,
  including golden fixtures transcribed from the source spreadsheet and property tests that assert
  exact cent reconciliation over randomised inputs.
- **`apps/api`** tests that touch the database migrate a [PGlite](https://pglite.dev) instance per
  file (`src/test/db.js`) — real Postgres compiled to WASM, so enums, `jsonb` and
  `gen_random_uuid()` behave as they do in the container. `/dashboard` is checked against the
  endpoints it aggregates rather than against hardcoded figures, since drifting apart from them is
  the only failure that endpoint really has.
- **`apps/web`** runs under jsdom (pinned to v25 — see its `vitest.config.js`). No snapshot tests:
  the suites cover the allocation draft store, money formatting, the nav list, and the component
  behaviour that has broken silently before.
- No test depends on a file that is not in the repo. The importer runs against a workbook generated
  by `apps/api/src/lib/import/__fixtures__/make-workbook.js`, which reproduces the source
  spreadsheet's structure with invented figures; only the assertions about the real workbook's own
  numbers are skipped where it is absent, and the suite says so out loud when it skips them.

---

## Planning docs

Phase-by-phase implementation docs live in `.claude/plans/` and are **deliberately gitignored** —
they contain the household's real financial figures. They are the source of truth for what to build
next; this README is the source of truth for how the repo works.
