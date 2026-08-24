import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/** @typedef {'light' | 'dark' | 'system'} ThemePref */
/** @typedef {'light' | 'dark'} ResolvedTheme */

// Must match the inline blocking script in index.html byte-for-byte on the
// storage key and the three stored values, or the pre-paint script and this
// module disagree about what "no flash" means.
const STORAGE_KEY = "budget:theme";

/** @returns {ThemePref} */
function readStoredPref() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") {
      return value;
    }
  } catch {
    // Private window or blocked site data — fall back to system, same as a
    // first-ever visit.
  }
  return "system";
}

/** @param {ThemePref} pref */
function writeStoredPref(pref) {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Can't persist, but the in-memory state still drives this session.
  }
}

/** @param {ThemePref} pref */
function applyPref(pref) {
  if (pref === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", pref);
  }
}

function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** @typedef {{ pref: ThemePref, resolved: ResolvedTheme, setPref: (pref: ThemePref) => void }} ThemeContextValue */

// The null default is cast at the call site — createContext(null) alone
// infers Context<null>, which can't later widen to accept the real value.
const ThemeContext = createContext(
  /** @type {ThemeContextValue | null} */ (null),
);

/** @param {{ children: import("react").ReactNode }} props */
export function ThemeProvider({ children }) {
  const [pref, setPrefState] = useState(readStoredPref);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // The CSS itself already flips on `prefers-color-scheme` with no JS
  // involved (see tokens.css) — this effect exists only so JS consumers
  // (the chart wrapper re-reading token colours, the toast theme) also know
  // when the OS preference changes, live, without a reload.
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (/** @type {MediaQueryListEvent} */ event) => {
      setSystemDark(event.matches);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    applyPref(pref);
  }, [pref]);

  const setPref = useCallback((/** @type {ThemePref} */ next) => {
    writeStoredPref(next);
    setPrefState(next);
  }, []);

  /** @type {ResolvedTheme} */
  const resolved = pref === "system" ? (systemDark ? "dark" : "light") : pref;

  const value = useMemo(
    () => ({ pref, resolved, setPref }),
    [pref, resolved, setPref],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider.");
  return ctx;
}

/** The concrete light/dark value after resolving "system". */
export function useResolvedTheme() {
  return useTheme().resolved;
}
