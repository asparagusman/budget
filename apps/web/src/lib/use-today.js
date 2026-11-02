import { useEffect, useState } from "react";
import { todayIso } from "@/lib/dates.js";

/**
 * Today's local date, kept current while the page stays open.
 *
 * `useMemo(todayIso, [])` read the clock once per mount, so a tab left open
 * overnight went on reporting yesterday — the dashboard's cycle, "in 2 days",
 * every goal's ETA — until something remounted the page. The household opens
 * this app about once a month, often by switching back to a tab that has
 * been sitting there, so "came back to the tab" is exactly when to look at
 * the clock again. Re-reading on visibility and focus costs nothing while the
 * tab is hidden, and a same-day re-read sets the same string, which React
 * ignores.
 *
 * @returns {string} `YYYY-MM-DD`
 */
export function useTodayIso() {
  const [today, setToday] = useState(todayIso);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") setToday(todayIso());
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  return today;
}
