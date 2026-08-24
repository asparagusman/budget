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
 * @param {string} bucket
 * @returns {import("hono").MiddlewareHandler}
 */
export function rateLimit(bucket) {
  return async (c, next) => {
    const forwardedFor = c.req.header("x-forwarded-for");
    const ip = forwardedFor?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    const key = `${bucket}:${ip}`;
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
