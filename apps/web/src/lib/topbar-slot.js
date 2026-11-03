import { useSyncExternalStore } from "react";

// Lets a route render into the fixed mobile top bar without the app shell
// needing to know anything about that route. Two slots: "action", the one
// contextual action on the right (see <TopBarAction>), and "info", beside the
// title, where <PageHeader> puts its (i). See shell/topbar.jsx.

/** @typedef {"action" | "info"} TopBarSlot */

/** @type {Record<TopBarSlot, HTMLElement | null>} */
const slotEls = { action: null, info: null };

/** @type {Set<() => void>} */
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * @param {TopBarSlot} slot
 * @param {HTMLElement | null} el
 */
export function setTopBarSlotEl(slot, el) {
  slotEls[slot] = el;
  emit();
}

/** @param {() => void} listener */
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** @param {TopBarSlot} slot */
export function useTopBarSlotEl(slot) {
  return useSyncExternalStore(subscribe, () => slotEls[slot]);
}
