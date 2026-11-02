import { toCents } from "@budget/engine";

/** @import { Cents } from "@budget/engine" */

// Amounts typed over a grid of stored figures — the bill history entry form
// and the variable-costs actuals grid.
//
// Both used to copy the server's figures into local state and re-copy them
// whenever the query refetched, which is the trouble: a refetch is not only
// "after Save". Toggling a category's Essential flag, adding one, archiving
// one, a lookback change — each refetched the grid and wiped whatever had
// been typed into it. So only the TYPING is held locally, keyed by the cell
// rather than by its position, and laid over whatever the server currently
// says. A refetch can then add, drop or reorder cells without touching a
// single keystroke.
//
// And one diff, `changedCells`, answers both "what does Save send" and "is
// there anything unsaved" — two separate checks would sooner or later
// disagree, and the unsaved guard is only honest if it is the save's own.

/**
 * Typed text by cell key. A cell with no entry shows the stored figure.
 *
 * @typedef {Record<string, string>} CellEdits
 */

/**
 * A field's text as cents. Blank is `null`, meaning "no amount" (Save clears
 * a stored one).
 *
 * @param {string} text
 * @returns {Cents | null}
 */
export function parseCents(text) {
  const raw = text.trim();
  return raw === "" ? null : toCents(Number(raw));
}

/**
 * A stored figure as the text its field starts with.
 *
 * @param {Cents | null} cents
 */
export function centsText(cents) {
  return cents === null ? "" : String(cents / 100);
}

/**
 * What the field for `key` shows: the typing if there is any, the stored
 * figure otherwise.
 *
 * @param {CellEdits} edits
 * @param {string} key
 * @param {Cents | null} storedCents
 */
export function cellText(edits, key, storedCents) {
  return edits[key] ?? centsText(storedCents);
}

/**
 * Every cell whose typed amount differs from what is stored — exactly what
 * Save sends, and so exactly what counts as unsaved. A cell typed back to its
 * stored figure is not a change. Typing for a cell that isn't in `cells` (a
 * cycle outside the current lookback, a category since archived) is neither
 * sent nor counted.
 *
 * @template {{ key: string, storedCents: Cents | null }} C
 * @param {CellEdits} edits
 * @param {C[]} cells
 * @returns {(C & { nextCents: Cents | null })[]}
 */
export function changedCells(edits, cells) {
  return cells.flatMap((cell) => {
    const text = edits[cell.key];
    if (text === undefined) return [];
    const nextCents = parseCents(text);
    return nextCents === cell.storedCents ? [] : [{ ...cell, nextCents }];
  });
}

/**
 * Forgets the typing a save sent, once it has landed and the grid has
 * refetched — the stored figure now says the same thing. Anything typed into
 * a cell AFTER the save was sent no longer matches what was sent, and is
 * kept. Returns `edits` itself when nothing is forgotten, so a state update
 * with it is a no-op.
 *
 * @param {CellEdits} edits the typing now
 * @param {CellEdits} sent the typing as it was when Save was pressed
 * @returns {CellEdits}
 */
export function forgetSentEdits(edits, sent) {
  /** @type {CellEdits} */
  const kept = {};
  let forgot = false;
  for (const [key, text] of Object.entries(edits)) {
    if (sent[key] === text) {
      forgot = true;
      continue;
    }
    kept[key] = text;
  }
  return forgot ? kept : edits;
}
