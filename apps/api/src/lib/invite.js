import { createHash, randomBytes } from "node:crypto";

/** A raw, single-use invite code — shown once, never stored. */
export function generateInviteCode() {
  return randomBytes(24).toString("base64url");
}

/** @param {string} code */
export function hashInviteCode(code) {
  return createHash("sha256").update(code).digest("hex");
}
