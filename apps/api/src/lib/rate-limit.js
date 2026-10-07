// Minimal in-memory fixed-window rate limiter. Per phases/03-auth.md's
// threat model — "basic rate limiting is worth having; a WAF is not" —
// there is no internet attacker here, just a cheap guard against a runaway
// client. Keyed by client IP plus a caller-supplied bucket name so
// /auth/login and /auth/register track separately.

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 10;

/** @type {Map<string, { count: number, resetAt: number }>} */
const buckets = new Map();

/**
 * The client address a request is counted against.
 *
 * In the deployed stack nothing off the host reaches this process except
 * through nginx (both published ports are bound to 127.0.0.1), and nginx
 * SETS X-Real-IP and X-Forwarded-For to the client address it resolved —
 * overwriting whatever the client sent, never appending to it (see
 * apps/web/nginx.conf). So X-Real-IP comes first. The LAST X-Forwarded-For
 * hop is the fallback because, if a proxy ever appends instead, the last hop
 * is the one that proxy added; the first is whatever the client chose to
 * send, which is how keying on it let a forged header dodge the limit.
 * With neither — local dev, where the browser calls the api directly —
 * every caller shares one bucket, which is fine for a guard against a
 * runaway client.
 *
 * @param {import("hono").Context} c
 */
function clientAddress(c) {
  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;
  return c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}

/**
 * @param {string} bucket
 * @returns {import("hono").MiddlewareHandler}
 */
export function rateLimit(bucket) {
  return async (c, next) => {
    const key = `${bucket}:${clientAddress(c)}`;
    const now = Date.now();
    const entry = buckets.get(key);

    if (!entry || entry.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      entry.count += 1;
      if (entry.count > MAX_REQUESTS) {
        return c.json(
          { error: { code: "rate_limited", message: "Too many requests. Try again shortly." } },
          429,
        );
      }
    }

    await next();
  };
}
