// One fixed colour per account, category or income variant — the same one
// on every chart, every visit.
//
// The household opens this app about once a month. "Savings is the teal one"
// is only worth learning if it is still true next month, and on the next
// screen. Handing colours out by list position broke both: the allocation
// pie numbered accounts in transfer order and /projections in its own order,
// so one account wore two colours a page apart, and reordering or adding an
// account repainted everything after it.
//
// So a colour is derived from the entity's ID, which never changes. Each id
// hashes to a preferred slot; ids are visited in sorted order (stable no
// matter how the operator has arranged the list) and a taken slot probes to
// the next free one. Adding an entity can only move another one off its
// colour when the two collide — never because of where it sits in a list.
//
// Always pass the FULL set of that kind of entity (every account, not just
// the ones a particular chart happens to show). Collisions are resolved
// within the set you pass, so two charts that pass different subsets could
// resolve them differently.

const PALETTE = /** @type {const} */ ([
  "var(--chart-line-1)",
  "var(--chart-line-2)",
  "var(--chart-line-3)",
  "var(--chart-line-4)",
  "var(--chart-line-5)",
]);

/**
 * FNV-1a, 32-bit. Any stable string hash would do; this one is short and has
 * no dependencies.
 *
 * @param {string} value
 */
function hash(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The colour for every id in `ids`, as a CSS variable (so it re-themes with
 * no JS). With more ids than colours, the palette is reused — a second lap,
 * resolved the same way.
 *
 * @param {Iterable<string>} ids
 * @returns {Map<string, string>}
 */
export function entityColors(ids) {
  const sorted = [...new Set(ids)].sort();
  /** @type {Map<string, string>} */
  const colors = new Map();
  /** @type {Set<number>} */
  let taken = new Set();

  for (const id of sorted) {
    if (taken.size === PALETTE.length) taken = new Set();
    let slot = hash(id) % PALETTE.length;
    while (taken.has(slot)) slot = (slot + 1) % PALETTE.length;
    taken.add(slot);
    colors.set(id, /** @type {string} */ (PALETTE[slot]));
  }

  return colors;
}

/**
 * Lookup with a neutral fallback, for an id that wasn't in the set (an
 * archived account still referenced by an old plan, say).
 *
 * @param {Map<string, string>} colors
 * @param {string} id
 */
export function colorFor(colors, id) {
  return colors.get(id) ?? "var(--chart-total)";
}
