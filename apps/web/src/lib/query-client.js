import { QueryClient } from "@tanstack/react-query";

// One client for the whole app, in its own module so the router can reach it
// too: route loaders prefetch into it (see router.jsx and lib/queries.js),
// and that only helps if it is the same cache the pages read.
//
// Deliberately no default `staleTime` — see lib/queries.js for why every
// mount has to refetch.
export const queryClient = new QueryClient();
