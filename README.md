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

Vitest, colocated as `*.test.js`. `packages/engine` is the only package with a coverage bar: every
exported function is tested, including golden fixtures transcribed from the source spreadsheet and
property tests that assert exact cent reconciliation over randomised inputs.

---

## Planning docs

Phase-by-phase implementation docs live in `.claude/plans/` and are **deliberately gitignored** —
they contain the household's real financial figures. They are the source of truth for what to build
next; this README is the source of truth for how the repo works.
