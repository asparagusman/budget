import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Vitest's globals are off, so nothing unmounts the previous test's tree on
// its own — without this, a `getByRole` in the second test finds two matches
// and fails for a reason that has nothing to do with what it was checking.
afterEach(cleanup);

/**
 * jsdom implements no media queries at all: `window.matchMedia` is simply
 * absent, and any component that asks about the viewport throws before it
 * renders. This is the smallest stand-in that is still honest — it answers
 * from a set of queries the test declares to be matching, and it really does
 * notify its listeners when that set changes, so a hook built on
 * `addEventListener("change")` is exercised rather than bypassed.
 *
 * Defaults to a desktop-width viewport (Tailwind's `lg` and below all match)
 * because that is what most component tests want without saying so.
 */
/** @type {Set<string>} */
let matching = new Set();

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Declares which media queries match from now on, notifying anything already
 * listening. Call it in a test before rendering to put the tree on a phone.
 *
 * @param {string[]} queries
 */
export function setMatchingMedia(queries) {
  matching = new Set(queries);
  for (const notify of [...listeners]) notify();
}

vi.stubGlobal(
  "matchMedia",
  /** @param {string} query */ (query) => ({
    media: query,
    get matches() {
      return matching.has(query);
    },
    /** @param {string} type @param {() => void} listener */
    addEventListener: (type, listener) => {
      if (type === "change") listeners.add(listener);
    },
    /** @param {string} type @param {() => void} listener */
    removeEventListener: (type, listener) => {
      if (type === "change") listeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }),
);

afterEach(() => {
  matching = new Set();
  listeners.clear();
});

// Radix measures elements on open and jsdom has no layout, so without these
// a popover, a select or a tab list throws on the first interaction rather
// than on anything the test is about.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
