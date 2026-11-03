import { z } from "zod";
import { deviceNameSchema } from "./devices.js";

const displayName = z.string().trim().min(1, "Display name is required").max(120);

// POST /auth/bootstrap — the household's first user, on the household's
// first device. Only accepted while the users table is empty.
export const bootstrapSchema = z.object({
  displayName,
  deviceName: deviceNameSchema.optional(),
});

/** @typedef {z.infer<typeof bootstrapSchema>} BootstrapInput */

// POST /auth/invite/:code/redeem — a link minted from the recovery screen or
// the server's shell. A 'new_user' invite needs the newcomer's name; a
// 'new_device' invite already knows whose device it is.
export const redeemInviteSchema = z.object({
  displayName: displayName.optional(),
  deviceName: deviceNameSchema.optional(),
});

/** @typedef {z.infer<typeof redeemInviteSchema>} RedeemInviteInput */

// The recovery password.
//
// Sixteen characters minimum, and no symbol-soup rule. This secret is written
// down once or kept in a password manager — it is not typed daily — so length
// is the only thing that buys real entropy, while a "must contain a symbol"
// rule mostly buys `Passw0rd!`. The two distinct-class check below rejects
// only the degenerate cases (sixteen a's, sixteen 1s) without pushing anyone
// towards a shorter, cleverer password.
//
// It is also not a way in to the figures. See users.recoveryPasswordHash: a
// session opened with it reaches only the screens that get a device
// approved.
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

// PUT /auth/recovery-password — set or replace it. Only ever accepted on an
// approved device, so there is no current-password field: holding a device
// the household let in is a stronger claim than knowing the password you are
// replacing.
export const setRecoveryPasswordSchema = z.object({ password: recoveryPassword });

/** @typedef {z.infer<typeof setRecoveryPasswordSchema>} SetRecoveryPasswordInput */

// POST /auth/login/password — the break-glass sign-in. Usernameless: there is
// at most one recovery password in the household, so the password itself
// identifies the user.
export const passwordLoginSchema = z.object({ password: z.string().min(1).max(200) });

/** @typedef {z.infer<typeof passwordLoginSchema>} PasswordLoginInput */
