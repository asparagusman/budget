import { z } from "zod";
import { accountType } from "../tables/accounts.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

// A destination is either an account that already exists, or one the operator
// has explicitly asked to create by name. There is deliberately no third
// option: an unmapped destination fails the request rather than defaulting to
// anything (phases/11-polish-mobile-import.md, workstream C, item 4 — "Do not
// create accounts silently").
export const importDestinationSchema = z.union([
  z.object({ accountId: z.string().uuid() }),
  z.object({
    create: z.object({
      name: z.string().trim().min(1, "Name is required").max(160),
      type: z.enum(accountType.enumValues),
    }),
  }),
]);

/** @typedef {z.infer<typeof importDestinationSchema>} ImportDestinationInput */

// POST /import/commit. The workbook itself is re-uploaded alongside this and
// re-parsed server-side rather than the client sending back the numbers it
// was shown — the whole value of the reconciliation summary is that the
// figures came from the file, not from a round trip through a form.
export const importCommitSchema = z.object({
  // What every imported bill and budget is dated from. The workbook holds no
  // due dates at all, so this is the operator's answer to "from when?" rather
  // than something that can be derived.
  anchorDate: isoDate,
  // Every row the operator left ticked. Absent keys are not imported; there
  // is no "import everything" shortcut, because the phantom rent row must
  // stay deselected unless it is deliberately chosen.
  selected: z.array(z.string().min(1)).max(5000),
  destinations: z.record(z.string(), importDestinationSchema),
  // Which income variant each plan divides — required only where the workbook
  // is ambiguous about it, which in the source file is the two sheets that
  // both read Income!E17.
  planVariants: z.record(z.string(), z.string()).default({}),
});

/** @typedef {z.infer<typeof importCommitSchema>} ImportCommitInput */
