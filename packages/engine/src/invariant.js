// Replacements for TypeScript's `!` non-null assertion, which JSDoc has no
// operator for. This is the better trade rather than a workaround: `!` is a
// compile-time claim that can be silently wrong at runtime, while these fail
// loudly at the exact point the assumption breaks. In a module whose failure
// mode is cents that don't reconcile, loud is what you want.
//
// Zero dependencies — `packages/engine` stays bare by design.

/**
 * Look up `key` in `map`, throwing if it is absent.
 *
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {string} [label] Noun used in the error message.
 */
export function mustGet(map, key, label = "value") {
  const found = map.get(key);
  if (found === undefined) {
    throw new Error(`Missing ${label} for key ${String(key)}.`);
  }
  return found;
}

/**
 * Read `index` from `arr`, throwing if it is out of range.
 *
 * @template T
 * @param {readonly T[]} arr
 * @param {number} index
 * @param {string} [label] Noun used in the error message.
 */
export function mustAt(arr, index, label = "element") {
  const found = arr[index];
  if (found === undefined) {
    throw new Error(
      `Missing ${label} at index ${index} (length ${arr.length}).`,
    );
  }
  return found;
}

/**
 * Find the first item matching `predicate`, throwing if there is none.
 *
 * @template T
 * @param {readonly T[]} arr
 * @param {(item: T) => boolean} predicate
 * @param {string} [label] Noun used in the error message.
 */
export function mustFind(arr, predicate, label = "match") {
  const found = arr.find(predicate);
  if (found === undefined) {
    throw new Error(`Expected to find ${label}, found none.`);
  }
  return found;
}
