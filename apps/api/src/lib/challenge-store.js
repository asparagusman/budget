import { randomUUID } from "node:crypto";

// In-memory, single-use WebAuthn challenge store. A challenge is issued
// once per registration/authentication ceremony and consumed exactly once by
// the matching /verify call. Storing the ceremony's context here — keyed by
// an opaque flowId the client just round-trips — means the client is never
// trusted with anything beyond that flowId: the invite, target user and
// displayName a registration resolves to are all pinned at /options time,
// not re-submitted (and therefore not re-trustable) at /verify time.
//
// In-memory is fine per phases/03-auth.md's threat model (single-process
// API, tailnet-only): a restart just invalidates in-flight ceremonies, and
// the operator retries.

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * @typedef {{
 *   kind: 'register',
 *   challenge: string,
 *   targetUserId?: string,
 *   displayName?: string,
 *   inviteId?: string,
 *   expiresAt: number,
 * }} RegisterChallenge
 */
/** @typedef {{ kind: 'login', challenge: string, expiresAt: number }} LoginChallenge */
/** @typedef {RegisterChallenge | LoginChallenge} StoredChallenge */

/** @type {Map<string, StoredChallenge>} */
const store = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt <= now) store.delete(id);
  }
}

/**
 * @param {Omit<RegisterChallenge, 'expiresAt'> | Omit<LoginChallenge, 'expiresAt'>} entry
 * @returns {string} flowId
 */
export function putChallenge(entry) {
  sweep();
  const flowId = randomUUID();
  store.set(flowId, { ...entry, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return flowId;
}

/**
 * Consumes (removes) the challenge for `flowId`. Returns null if it never
 * existed, already expired, or was already consumed — the caller can't
 * distinguish those, which is deliberate: none of them should behave
 * differently to a client that may be retrying or attacking.
 *
 * @param {string} flowId
 * @returns {StoredChallenge | null}
 */
export function takeChallenge(flowId) {
  sweep();
  const entry = store.get(flowId);
  if (!entry) return null;
  store.delete(flowId);
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}
