import { z } from "zod";

// Bootstrap and later "new user" registrations both start from a display
// name; email is optional (identifier only, never sent to).
export const createUserSchema = z.object({
  displayName: z.string().trim().min(1, "Display name is required").max(120),
  email: z.string().trim().email().max(320).optional(),
});

/** @typedef {z.infer<typeof createUserSchema>} CreateUserInput */

// PATCH /users/:id — both fields optional so a caller can send just one.
export const updateUserSchema = z
  .object({
    displayName: z.string().trim().min(1, "Display name is required").max(120),
    isActive: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateUserSchema>} UpdateUserInput */
