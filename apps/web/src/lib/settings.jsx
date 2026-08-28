import { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";

/** @typedef {{ currency: string, locale: string, billsBufferCents: number, historyLookbackDefault: number }} Settings */

/** @type {Settings} */
const DEFAULT_SETTINGS = {
  currency: "AUD",
  locale: "en-AU",
  billsBufferCents: 0,
  historyLookbackDefault: 6,
};

/** @type {import("react").Context<Settings>} */
const SettingsContext = createContext(DEFAULT_SETTINGS);

// Fetches GET /settings and merges it over DEFAULT_SETTINGS, so a slow or
// failed request (most visibly: before the operator is signed in, since
// /settings sits behind the same auth guard as everything else) never
// leaves <Money> etc. without a currency to render — see useSettings().
// `retry: false` keeps a pre-login 401 from hammering the API; AuthProvider
// invalidates this query on refresh() so it re-fetches for real the moment
// a session exists (see auth.jsx).
/** @param {{ children: import("react").ReactNode }} props */
export function SettingsProvider({ children }) {
  const query = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await api.settings.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).settings;
    },
    retry: false,
  });

  const merged = useMemo(() => ({ ...DEFAULT_SETTINGS, ...query.data }), [query.data]);

  return <SettingsContext.Provider value={merged}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  return useContext(SettingsContext);
}
