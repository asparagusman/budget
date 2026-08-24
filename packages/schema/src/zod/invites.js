import { z } from "zod";

// POST /invites — 'new_user' mints an invite for anyone to redeem;
// 'new_device' requires the id of the existing user it attaches to.
export const createInviteSchema = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("new_user") }),
  z.object({ purpose: z.literal("new_device"), targetUserId: z.string().uuid() }),
]);

/** @typedef {z.infer<typeof createInviteSchema>} CreateInviteInput */
