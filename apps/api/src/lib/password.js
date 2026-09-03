import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

// The recovery password's storage format, and nothing else in the app hashes
// a password.
//
// scrypt from node:crypto rather than argon2 or bcrypt from npm: this hash is
// verified at most a handful of times in the life of the installation, the
// algorithm is memory-hard, and it is already in the runtime. A native
// dependency that has to compile on the box is a worse trade for a
// two-person household app than one that ships with Node.
//
// N=2^16 with r=8 costs about 64MB and a fraction of a second per verify.
// That is deliberately slow: the only thing that ever calls it is a human
// typing a password they wrote down once, and the rate limiter in front of it
// is tighter still.
//
// Every byte string here is a plain `Uint8Array`, never a Node `Buffer`.
// apps/web typechecks this file too — it reaches it through
// `import("@budget/api").ApiRoutes` — and under web's DOM lib a Buffer and
// the ambient ArrayBufferView are not the same type. Same reason
// import/parse.js hashes a Uint8Array.
const N = 65_536;
const r = 8;
const p = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

// scrypt with these parameters needs more than node's default 32MB.
const MAX_MEMORY = 256 * 1024 * 1024;

/**
 * Promisified by hand rather than with `util.promisify`: its overloads only
 * cover the three-argument form, so the options object — which is where N,
 * r, p and maxmem live, and therefore the whole point — does not typecheck
 * through it.
 *
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {number} keylen
 * @param {import("node:crypto").ScryptOptions} options
 * @returns {Promise<Uint8Array>}
 */
function scrypt(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(new Uint8Array(derived));
    });
  });
}

/** @param {Uint8Array} bytes */
function toBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

/** @param {string} text */
function fromBase64Url(text) {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

/**
 * `scrypt$N$r$p$salt$hash`, both byte halves base64url. The parameters travel
 * with the hash so raising them later does not invalidate what is already
 * stored — an old hash still verifies against its own cost.
 *
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  const salt = new Uint8Array(randomBytes(SALT_BYTES));
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_BYTES, { N, r, p, maxmem: MAX_MEMORY });
  return ["scrypt", N, r, p, toBase64Url(salt), toBase64Url(derived)].join("$");
}

/**
 * Constant-time verify.
 *
 * Returns false rather than throwing for a stored value it cannot parse: a
 * corrupted or hand-edited column must fail the sign-in, not 500 the endpoint
 * and tell the caller that something interesting is in there.
 *
 * @param {string} password
 * @param {string | null} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  const cost = { N: Number(rawN), r: Number(rawR), p: Number(rawP) };
  if (!Number.isInteger(cost.N) || !Number.isInteger(cost.r) || !Number.isInteger(cost.p)) return false;

  const expected = fromBase64Url(/** @type {string} */ (rawHash));
  if (expected.length === 0) return false;

  let derived;
  try {
    derived = await scrypt(password.normalize("NFKC"), fromBase64Url(/** @type {string} */ (rawSalt)), expected.length, {
      ...cost,
      maxmem: MAX_MEMORY,
    });
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected);
}
