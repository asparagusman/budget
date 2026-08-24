import { z } from "zod";

// PATCH /credentials/:id — rename only; the phase doc has no other
// operator-editable field on a credential.
export const renameCredentialSchema = z.object({
  deviceName: z.string().trim().min(1, "Device name is required").max(120),
});

/** @typedef {z.infer<typeof renameCredentialSchema>} RenameCredentialInput */
