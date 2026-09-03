/**
 * The list with two items exchanged.
 *
 * Returns the SAME array when either index is out of range, so a caller can
 * use identity to decide whether there is anything to send — a request that
 * reorders nothing is still a write, and firing one on every click of a
 * button that looks disabled is a write nobody asked for.
 *
 * @template T
 * @param {T[]} items
 * @param {number} a
 * @param {number} b
 * @returns {T[]}
 */
export function swapInList(items, a, b) {
  if (a === b) return items;
  const inRange = (/** @type {number} */ i) => i >= 0 && i < items.length;
  if (!inRange(a) || !inRange(b)) return items;
  const next = [...items];
  next[a] = /** @type {T} */ (items[b]);
  next[b] = /** @type {T} */ (items[a]);
  return next;
}

/**
 * The list with one item moved a step up (-1) or down (1). Same identity rule
 * as `swapInList`: a move off either end returns the list unchanged.
 *
 * @template T
 * @param {T[]} items
 * @param {number} index
 * @param {-1 | 1} direction
 * @returns {T[]}
 */
export function moveInList(items, index, direction) {
  return swapInList(items, index, index + direction);
}

/**
 * Moves an item a step within its own GROUP, and returns the whole flat list
 * in the resulting order.
 *
 * Accounts are listed grouped by type but ordered by one `sortOrder` across
 * all of them, and the reorder endpoint renumbers the whole list. Exchanging
 * the two rows' positions in the flat list is what makes the move mean what
 * the operator saw: their relative order flips, every other row keeps the
 * position it had, and a renumber 0..n-1 leaves the group looking exactly as
 * it does on screen. Neighbours within a group need not be adjacent in the
 * flat list for that to hold.
 *
 * Returns null when the item is already at its group's edge.
 *
 * @template {{ id: string }} T
 * @param {T[]} all Every item, in the order the list is currently in.
 * @param {T[]} group The items of one group, in that same relative order.
 * @param {number} indexInGroup
 * @param {-1 | 1} direction
 * @returns {T[] | null}
 */
export function moveWithinGroup(all, group, indexInGroup, direction) {
  const item = group[indexInGroup];
  const neighbour = group[indexInGroup + direction];
  if (!item || !neighbour) return null;
  const from = all.findIndex((candidate) => candidate.id === item.id);
  const to = all.findIndex((candidate) => candidate.id === neighbour.id);
  if (from === -1 || to === -1) return null;
  return swapInList(all, from, to);
}
