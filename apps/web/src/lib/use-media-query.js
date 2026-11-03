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

/** @type {Map<string, (onChange: () => void) => () => void>} */
const subscribers = new Map();

/**
 * One `subscribe` per query, kept for the life of the page. React
 * re-subscribes whenever `useSyncExternalStore` is handed a different
 * function, so an inline one detached and re-attached a `matchMedia`
 * listener on every render — and every `<Money>` asks about reduced motion,
 * so a keystroke on a big page did that hundreds of times
 * (.claude/plans/perf-inp-plan.md, P1.4).
 *
 * @param {string} query
 */
function subscriberFor(query) {
  let subscribe = subscribers.get(query);
  if (!subscribe) {
    subscribe = (onChange) => {
      const list = listFor(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    };
    subscribers.set(query, subscribe);
  }
  return subscribe;
}

/**
 * A CSS media query as a boolean, read SYNCHRONOUSLY on the first render —
 * `useSyncExternalStore`'s snapshot is `matches`, not state seeded by an
 * effect, so there is no wrong first frame and nothing shifts once it
 * corrects itself.
 *
 * Reach for it only when the two branches must not both exist in the DOM.
 * Plain responsive classes are the default answer and cost nothing; this is
 * for the cases where rendering the hidden branch is actively wrong — a
 * chart measures its container, and inside `display: none` that container
 * is 0x0, so it mounts and draws nothing — or where it's expensive: the
 * fixed-costs table in edit mode is a form per bill, and building a hidden
 * phone copy of every one doubled the cost of pressing Edit.
 *
 * @param {string} query
 */
export function useMediaQuery(query) {
  return useSyncExternalStore(subscriberFor(query), () => listFor(query).matches);
}

// Tailwind's own `lg` breakpoint, so `useMediaQuery(LG)` and a `lg:` class
// always agree about which side of it the viewport is on.
export const LG = "(min-width: 64rem)";

// Tailwind's `md`, likewise.
export const MD = "(min-width: 48rem)";
