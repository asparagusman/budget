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

// The recovery password.
//
// Sixteen characters minimum, and no symbol-soup rule. This secret is written
// down once or kept in a password manager — it is not typed daily — so length
// is the only thing that buys real entropy, while a "must contain a symbol"
// rule mostly buys `Passw0rd!`. The two distinct-class check below rejects
// only the degenerate cases (sixteen a's, sixteen 1s) without pushing anyone
// towards a shorter, cleverer password.
//
// It is also NOT a way in to the app. See users.recoveryPasswordHash: a
// session opened with it reaches only the screens that mint a new-device
// invite, so the thing an attacker gets by phishing it is the ability to ask
// the household for a passkey.
export const RECOVERY_PASSWORD_MIN_LENGTH = 16;

const characterClasses = (/** @type {string} */ value) =>
  [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((pattern) => pattern.test(value)).length;

const recoveryPassword = z
  .string()
  .min(RECOVERY_PASSWORD_MIN_LENGTH, `Use at least ${RECOVERY_PASSWORD_MIN_LENGTH} characters.`)
  .max(200)
  .refine((value) => value.trim().length >= RECOVERY_PASSWORD_MIN_LENGTH, {
    message: "Leading or trailing spaces do not count towards the length.",
  })
  .refine((value) => characterClasses(value) >= 2, {
    message: "Mix at least two of: lower case, upper case, digits, symbols.",
  });

// PUT /auth/recovery-password — set or replace it. Only ever accepted on a
// passkey session, so there is no current-password field: proving you hold a
// passkey is a stronger claim than knowing the password you are replacing.
export const setRecoveryPasswordSchema = z.object({ password: recoveryPassword });

/** @typedef {z.infer<typeof setRecoveryPasswordSchema>} SetRecoveryPasswordInput */

// POST /auth/login/password — the break-glass sign-in. Usernameless, like
// the passkey flow: there is at most one recovery password in the household,
// so the password itself identifies the user.
export const passwordLoginSchema = z.object({ password: z.string().min(1).max(200) });

/** @typedef {z.infer<typeof passwordLoginSchema>} PasswordLoginInput */
