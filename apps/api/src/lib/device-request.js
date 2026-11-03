import { randomInt } from "node:crypto";
import { getCookie } from "hono/cookie";
import { hashToken } from "./session.js";

export const DEVICE_REQUEST_COOKIE = "budget_device_request";

// Long enough to walk to the other phone, short enough that a forgotten
// request isn't sitting in the approver's list tomorrow.
export const DEVICE_REQUEST_TTL_MS = 15 * 60 * 1000;

// Anyone on the network can ask, so the queue is capped. Two people asking
// at once is busy here; ten waiting is something gone wrong.
export const MAX_PENDING_DEVICE_REQUESTS = 10;

// No 0/O, 1/I/L: the code is read off one screen and checked against another.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;

/**
 * The short code shown on both the waiting device and the approver's screen,
 * so the approver can tell which waiting device is which. Not a secret — the
 * cookie token is what the session is handed to.
 */
export function generateDeviceRequestCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/**
 * This browser's own device request, if it has one that hasn't expired.
 *
 * @param {import("@budget/schema").Db} db
 * @param {import("hono").Context} c
 */
export async function findOwnDeviceRequest(db, c) {
  const token = getCookie(c, DEVICE_REQUEST_COOKIE);
  if (!token) return null;
  const request = await db.query.deviceRequests.findFirst({
    where: (r, { eq }) => eq(r.tokenHash, hashToken(token)),
  });
  if (!request || request.expiresAt <= new Date()) return null;
  return request;
}

/**
 * The fields of a request either screen may show.
 *
 * @param {typeof import("@budget/schema").deviceRequests.$inferSelect} request
 */
export function describeDeviceRequest(request) {
  return {
    id: request.id,
    code: request.code,
    deviceName: request.deviceName,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}
