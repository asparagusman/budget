import { z } from "zod";

export const createPersonSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  sortOrder: z.number().int().default(0),
});

/** @typedef {z.infer<typeof createPersonSchema>} CreatePersonInput */

// PATCH /people/:id — all fields optional so a caller can send just one.
export const updatePersonSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120),
    sortOrder: z.number().int(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updatePersonSchema>} UpdatePersonInput */
