import { z } from "zod";

// Every settings key any phase has introduced so far. GET /settings returns
// all of these (merged over the defaults seed.js loads unconditionally);
// PATCH accepts any subset. Later phases append their own keys here rather
// than inventing a second settings route.
export const updateSettingsSchema = z
  .object({
    currency: z.string().trim().length(3, "Use a 3-letter currency code."),
    locale: z.string().trim().min(2).max(35),
    billsBufferCents: z.number().int().min(0),
    historyLookbackDefault: z.number().int().min(1).max(24),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateSettingsSchema>} UpdateSettingsInput */
