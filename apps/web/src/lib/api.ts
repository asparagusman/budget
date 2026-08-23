import type { ApiRoutes } from "@budget/api";
import { hc } from "hono/client";

// Type-only import above — apps/web never depends on apps/api's runtime
// code, only the route types, so the RPC client is fully typed with zero
// coupling to the server bundle.
const apiUrl = import.meta.env.VITE_API_URL;
if (!apiUrl) {
  throw new Error("VITE_API_URL is not set.");
}

export const api = hc<ApiRoutes>(apiUrl);
