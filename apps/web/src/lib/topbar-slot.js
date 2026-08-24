import { useSyncExternalStore } from "react";

// Lets a route render into the fixed mobile top bar's contextual-action slot
// without the app shell needing to know anything about that route. See
// <TopBarAction> and shell/topbar.jsx.
/** @type {HTMLElement | null} */
let slotEl = null;

/** @type {Set<() => void>} */
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

/** @param {HTMLElement | null} el */
export function setTopBarSlotEl(el) {
  slotEl = el;
  emit();
}

/** @param {() => void} listener */
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return slotEl;
}

export function useTopBarSlotEl() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
