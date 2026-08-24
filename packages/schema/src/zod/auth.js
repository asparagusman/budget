import { z } from "zod";

// POST /auth/register/options — bootstrap (no invite yet, empty users
// table) supplies just a displayName; every later registration supplies an
// invite code instead, plus a displayName only when the invite is
// 'new_user' (a 'new_device' invite already knows whose it is).
export const registerOptionsSchema = z.object({
  inviteCode: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1, "Display name is required").max(120).optional(),
});

/** @typedef {z.infer<typeof registerOptionsSchema>} RegisterOptionsInput */

// POST /auth/register/verify — flowId round-trips the opaque id the server
// handed back from /register/options (which is what the challenge, invite
// and displayName are actually pinned to server-side), plus the WebAuthn
// attestation response itself.
export const registerVerifySchema = z.object({
  flowId: z.string().min(1),
  // The WebAuthn browser API's RegistrationResponseJSON — shaped by the
  // authenticator, not by us, so it stays a passthrough object rather than a
  // fully-specified schema.
  response: z.looseObject({}),
});

/** @typedef {z.infer<typeof registerVerifySchema>} RegisterVerifyInput */

// POST /auth/login/verify — same flowId + WebAuthn assertion response
// shape. Usernameless, so there's nothing else to validate here.
export const loginVerifySchema = z.object({
  flowId: z.string().min(1),
  response: z.looseObject({}),
});

/** @typedef {z.infer<typeof loginVerifySchema>} LoginVerifyInput */
