# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A single household: one operator who owns and edits the budget, plus one other household member. Both use it on desktop and on phone. Access is passkey-only, by invite. The operator is a person planning their own money, not a professional accountant.

## Product Purpose

A household budgeting app that replaces a hand-built spreadsheet. It computes, projects, visualises and flags: pay schedules, income, fixed and variable costs, bills and their history, accounts, goals, allocation plans, a calendar and projections. Success is that the operator can see where the household's money stands and is going, and trust that every figure reconciles to the cent.

## Positioning

An instrument panel, not an autopilot. It never adjusts a financial figure on its own, never auto-balances, never silently corrects. Goals report an ETA and a required contribution and never write an allocation. Conflicts are surfaced, not resolved. Allocation plans from imports land as drafts because the app does not decide the household's standing orders.

## Operating Context

- Replaces an existing spreadsheet; an `.xlsx` import shows every row grouped by what it will become, is individually deselectable, flags defects in the source, is idempotent, and ends with a reconciliation of spreadsheet figures against what the app computes.
- Nothing about a household is hardcoded: paydays, bill names, category lists and seasonality are all rows the operator edits.
- Calendar dates (due dates, paydays, targets) have no timezone: a bill due on the 14th is due on the 14th everywhere.
- Money is integer cents everywhere and is formatted only at the render edge.

## Capabilities and Constraints

- Stack in place: Postgres, Hono API, React 19 + Vite + Tailwind v4 web client, one pure calculation package (`@budget/engine`), shared Drizzle/Zod schema package. JavaScript with JSDoc types, no TypeScript files.
- Command palette, light and dark themes, and phone-width layouts are part of the product.
- Admin and invite flows exist for adding household members.
- Open: currency/locale and any accessibility standard have not been confirmed.

## Evidence on Hand

The README is the source of the principles above. No testimonials, customers, benchmarks or pricing exist and none should be invented. The household's real data is private and is not in the repo; tests use invented figures.

## Product Principles

1. Show, never decide: surface figures, projections and conflicts; leave every adjustment to the operator.
2. Figures must reconcile exactly; a number that cannot be traced to its inputs is a defect.
3. Nothing about a particular household is built in; everything is editable data.
4. Surface defects and uncertainty out loud rather than handling them silently.
5. Equally usable at a desk for planning and on a phone for a quick check.
