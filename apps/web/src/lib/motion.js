import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@/lib/use-media-query.js";

// Animation in this app exists to make a state change legible, never to
// decorate one (phases/11-polish-mobile-import.md, workstream A). The rules
// every consumer of this module inherits:
//
//   - `prefers-reduced-motion` reduces motion to opacity, it never removes
//     feedback. A number still updates; it just stops counting up to it.
//   - Nothing runs longer than 300ms except a deliberate chart entrance.
//   - Never animate a value the operator is actively typing into.
//   - Never block interaction behind an animation.
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** True when the operator has asked the OS for reduced motion. */
export function useReducedMotion() {
  return useMediaQuery(REDUCED_MOTION);
}

/** The one duration every number tween and diff flash shares. */
export const TWEEN_MS = 250;

/** Standard ease-out. Fast at the start, so the change reads immediately. */
/** @param {number} t */
function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

/**
 * Tweens toward `value` over ~250ms and returns the current frame's number,
 * so a recalculated figure visibly *moves* rather than teleporting — the
 * operator can see which figures a percentage change actually touched.
 *
 * Three deliberate behaviours:
 *
 *  - `enabled: false` short-circuits to the exact value. Callers pass the
 *    focus state of the field driving the number, because tweening the
 *    figure someone is mid-keystroke on is noise, not information.
 *  - Reduced motion also short-circuits. The number still updates; only the
 *    counting stops.
 *  - The FIRST value is never tweened. Counting up from zero on mount is
 *    decoration; only a *change* is worth animating.
 *
 * @param {number} value
 * @param {{ enabled?: boolean }} [options]
 */
export function useTweenedNumber(value, { enabled = true } = {}) {
  const reduced = useReducedMotion();
  const active = enabled && !reduced;

  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const frameRef = useRef(/** @type {number | null} */ (null));
  // Mount is not a change — see above.
  const seededRef = useRef(false);

  useEffect(() => {
    if (!seededRef.current) {
      seededRef.current = true;
      fromRef.current = value;
      setDisplay(value);
      return undefined;
    }

    if (!active || fromRef.current === value) {
      fromRef.current = value;
      setDisplay(value);
      return undefined;
    }

    const from = fromRef.current;
    const delta = value - from;
    const start = performance.now();

    const step = () => {
      const elapsed = performance.now() - start;
      const t = Math.min(1, elapsed / TWEEN_MS);
      const next = t >= 1 ? value : Math.round(from + delta * easeOutCubic(t));
      fromRef.current = next;
      setDisplay(next);
      if (t < 1) frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [value, active]);

  return display;
}

/**
 * Goes true for ~600ms whenever `key` changes, so a row can flash a tint and
 * settle. Returns false immediately under reduced motion — a tint that
 * appears and never leaves is worse than no tint.
 *
 * @param {string | number | null | undefined} key
 * @param {{ enabled?: boolean, durationMs?: number }} [options]
 */
export function useFlashOnChange(key, { enabled = true, durationMs = 600 } = {}) {
  const reduced = useReducedMotion();
  const active = enabled && !reduced;
  const [flashing, setFlashing] = useState(false);
  const previous = useRef(key);
  const seeded = useRef(false);

  useEffect(() => {
    if (!seeded.current) {
      seeded.current = true;
      previous.current = key;
      return undefined;
    }
    if (previous.current === key) return undefined;
    previous.current = key;
    if (!active) return undefined;

    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), durationMs);
    return () => clearTimeout(timer);
  }, [key, active, durationMs]);

  return flashing;
}
