import { z } from "zod";

// POST /people/reorder and POST /accounts/reorder — the whole list, in the
// order it should now be in.
//
// Not a `sortOrder` number on the edit form, and not a PATCH per row. Every
// row created through the API took the column's default of 0, so a list that
// has never been reordered is entirely zeroes and a swap of two neighbours'
// values changes nothing at all. Sending the order instead lets the server
// renumber 0..n-1 in one transaction, which fixes that starting state on the
// first move rather than requiring a manual pass over every row.
//
// It also means the request says what the operator did ("this is the order
// now") rather than what the database should hold, so a concurrent rename
// cannot interleave with it and leave two rows claiming one position.
export const reorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, "Send the list in its new order."),
});

/** @typedef {z.infer<typeof reorderSchema>} ReorderInput */
