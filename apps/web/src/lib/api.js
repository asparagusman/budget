import { hc } from "hono/client";

/** @import { ApiRoutes } from "@budget/api" */

// Types only — apps/web never depends on apps/api's runtime code, so the RPC
// client is fully typed with zero coupling to the server bundle.
//
// `hc` takes its route type as an explicit type argument, and JS has no
// syntax for that on a call — `hc`'s `T` appears only in its return type, so
// nothing infers it either. JSDoc type positions are parsed with the full
// TypeScript type grammar, so the instantiation expression works there; it
// has to be a cast rather than an annotation, and it has to route through
// `unknown` because the uninferred call type doesn't overlap the target.
//
// Only this one assignment is unchecked, and it costs nothing real: `hc`
// returns a proxy that answers any path at runtime, so the type argument is
// pure declaration. Every call site through `api` is fully typed.
const apiUrl = import.meta.env.VITE_API_URL;
if (!apiUrl) {
  throw new Error("VITE_API_URL is not set.");
}

export const api = /** @type {ReturnType<typeof hc<ApiRoutes>>} */ (
  /** @type {unknown} */ (hc(apiUrl))
);
