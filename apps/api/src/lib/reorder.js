/**
 * Checks a reorder request against the rows that actually exist.
 *
 * A reorder is only meaningful as a statement about the WHOLE list: the
 * server renumbers 0..n-1 from it, so a request that omits a row would leave
 * that row holding a position now claimed by something else, and one that
 * repeats a row would give two rows the same. Both are silent — the list just
 * comes back in an order nobody chose — so they are rejected rather than
 * partially applied.
 *
 * Returns the message to send, or null when the request is sound.
 *
 * @param {string[]} ids The order the client is asking for.
 * @param {string[]} existing Every unarchived row's id.
 * @param {string} noun Plural, lowercase — "people", "accounts".
 */
export function reorderError(ids, existing, noun) {
  if (new Set(ids).size !== ids.length || ids.length !== existing.length) {
    return `Send every one of the ${noun} exactly once, in the order they should appear.`;
  }
  const known = new Set(existing);
  return ids.every((id) => known.has(id))
    ? null
    : `Send every one of the ${noun} exactly once, in the order they should appear.`;
}
