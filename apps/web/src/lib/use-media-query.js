import { useSyncExternalStore } from "react";

/** @type {Map<string, MediaQueryList>} */
const lists = new Map();

/** @param {string} query */
function listFor(query) {
  let list = lists.get(query);
  if (!list) {
    list = window.matchMedia(query);
    lists.set(query, list);
  }
  return list;
}

/**
 * A CSS media query as a boolean, read SYNCHRONOUSLY on the first render —
 * `useSyncExternalStore`'s snapshot is `matches`, not state seeded by an
 * effect, so there is no wrong first frame and nothing shifts once it
 * corrects itself.
 *
 * Reach for it only when the two branches must not both exist in the DOM.
 * Plain responsive classes are the default answer and cost nothing; this is
 * for the cases where rendering the hidden branch is actively wrong — an
 * echarts canvas inside `display: none` initialises at 0x0 and logs "Can't
 * get DOM width or height" instead of drawing.
 *
 * @param {string} query
 */
export function useMediaQuery(query) {
  return useSyncExternalStore(
    (onChange) => {
      const list = listFor(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => listFor(query).matches,
  );
}

// Tailwind's own `lg` breakpoint, so `useMediaQuery(LG)` and a `lg:` class
// always agree about which side of it the viewport is on.
export const LG = "(min-width: 64rem)";
