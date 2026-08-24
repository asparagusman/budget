import { createContext, useContext, useMemo } from "react";

/** @typedef {{ currency: string, locale: string }} Settings */

/** @type {Settings} */
const DEFAULT_SETTINGS = {
  currency: "AUD",
  locale: "en-AU",
};

/** @type {import("react").Context<Settings>} */
const SettingsContext = createContext(DEFAULT_SETTINGS);

// A later phase (03/04) replaces the hardcoded default with a value read
// from the `settings` table over the API and keeps this same Provider/hook
// shape — nothing that reads useSettings() should need to change. Until
// then, this is the one and only place `'AUD'` / `'en-AU'` appear; every
// other component reads them from here, never inline.
/** @param {{ children: import("react").ReactNode, value?: Partial<Settings> }} props */
export function SettingsProvider({ children, value }) {
  const merged = useMemo(
    () => ({ ...DEFAULT_SETTINGS, ...value }),
    [value],
  );
  return (
    <SettingsContext.Provider value={merged}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
