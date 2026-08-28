import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

// GET /dashboard?on= — which pay cycle the whole screen reports on. Optional,
// and defaulted to today in the handler; a schema-level default would freeze
// the date at module load. Everything the dashboard shows is derived from
// this one date, which is why it lives in the URL rather than in component
// state (phases/10-dashboard.md "Behaviour").
export const dashboardQuerySchema = z.object({
  on: isoDate.optional(),
});

/** @typedef {z.infer<typeof dashboardQuerySchema>} DashboardQuery */
