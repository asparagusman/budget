import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTodayIso } from "./use-today.js";

// A tab left open overnight used to keep reporting yesterday — the dashboard's
// pay cycle included — until the page remounted.

describe("useTodayIso", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves to the new day when the tab is looked at again", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 7, 23, 50) });
    const { result } = renderHook(() => useTodayIso());
    expect(result.current).toBe("2026-10-07");

    // Midnight passes while nobody is looking: nothing to re-render for.
    vi.setSystemTime(new Date(2026, 9, 8, 7, 30));
    expect(result.current).toBe("2026-10-07");

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe("2026-10-08");
  });

  it("also catches a window regaining focus", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 7, 12, 0) });
    const { result } = renderHook(() => useTodayIso());
    vi.setSystemTime(new Date(2026, 9, 9, 9, 0));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current).toBe("2026-10-09");
  });
});
