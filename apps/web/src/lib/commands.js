import { useSyncExternalStore } from "react";

/**
 * @typedef {{
 *   id: string,
 *   group: 'Navigation' | 'Actions' | 'Recent',
 *   label: string,
 *   keywords?: string,
 *   icon?: import("lucide-react").LucideIcon,
 *   shortcut?: string,
 *   run: () => void,
 * }} Command
 */

/** @type {Map<string, Command>} */
const registry = new Map();

/** @type {Set<() => void>} */
const listeners = new Set();

/** @type {Command[]} */
let snapshot = [];

function recomputeSnapshot() {
  snapshot = Array.from(registry.values());
}

function emit() {
  recomputeSnapshot();
  for (const listener of listeners) listener();
}

/**
 * Feature phases register their own searchable commands through this — the
 * palette itself only renders whatever is currently registered.
 *
 * @param {Command[]} commands
 * @returns {() => void} unregister
 */
export function registerCommands(commands) {
  for (const command of commands) registry.set(command.id, command);
  emit();
  return () => {
    for (const command of commands) registry.delete(command.id);
    emit();
  };
}

/** @param {() => void} listener */
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

export function useCommands() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// Palette open/closed state lives here too, rather than as local state on
// <CommandPalette>, so anything — the sidebar's search button, a future
// "Search" menu item — can open it without needing a ref or a prop drilled
// down from the app shell.
let paletteOpen = false;
/** @type {Set<() => void>} */
const paletteListeners = new Set();

function emitPalette() {
  for (const listener of paletteListeners) listener();
}

/** @param {boolean} open */
export function setCommandPaletteOpen(open) {
  paletteOpen = open;
  emitPalette();
}

export function toggleCommandPalette() {
  setCommandPaletteOpen(!paletteOpen);
}

/** @param {() => void} listener */
function subscribePalette(listener) {
  paletteListeners.add(listener);
  return () => paletteListeners.delete(listener);
}

function getPaletteSnapshot() {
  return paletteOpen;
}

export function useCommandPaletteOpen() {
  return useSyncExternalStore(subscribePalette, getPaletteSnapshot);
}
