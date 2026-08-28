import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

export const listVariableActualsQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
});

/** @typedef {z.infer<typeof listVariableActualsQuerySchema>} ListVariableActualsQuery */

// PUT /variable-actuals — one bulk upsert across every category and cycle
// entered on the grid, spanning the whole entry screen rather than one bill
// (phases/07-variable-costs.md "Actuals entry": "Single bulk upsert on
// save."). `amountCents: null` clears a previously entered cell — unlike
// bill_instances, `variable_actuals.amount_cents` is NOT NULL, so a cleared
// cell means the route deletes the row rather than storing a null.
export const upsertVariableActualsSchema = z.object({
  entries: z.array(
    z.object({
      categoryId: z.string().uuid(),
      cycleStart: isoDate,
      amountCents: z.number().int().nullable(),
    }),
  ),
});

/** @typedef {z.infer<typeof upsertVariableActualsSchema>} UpsertVariableActualsInput */
