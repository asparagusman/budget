import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { rateLimit } from "./rate-limit.js";

// Which address a request is counted against. The limiter's buckets are
// module state, so each test uses a bucket name of its own.

/** @param {string} bucket */
function limitedApp(bucket) {
  return new Hono().use(rateLimit(bucket)).get("/", (c) => c.json({ ok: true }));
}

/**
 * @param {import("hono").Hono} app
 * @param {Record<string, string>} headers
 * @param {number} times
 */
async function statuses(app, headers, times) {
  const result = [];
  for (let i = 0; i < times; i += 1) {
    result.push((await app.request("/", { headers })).status);
  }
  return result;
}

describe("rateLimit", () => {
  it("can't be dodged by varying a forged first X-Forwarded-For hop", async () => {
    const app = limitedApp("forged-first-hop");
    const results = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await app.request("/", {
        headers: { "x-forwarded-for": `10.9.9.${i}, 100.64.0.1` },
      });
      results.push(res.status);
    }
    expect(results.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(results[10]).toBe(429);
  });

  it("prefers X-Real-IP, which nginx sets, over X-Forwarded-For", async () => {
    const app = limitedApp("real-ip-first");
    for (let i = 0; i < 10; i += 1) {
      const res = await app.request("/", {
        headers: { "x-real-ip": "100.64.0.2", "x-forwarded-for": `100.64.1.${i}` },
      });
      expect(res.status).toBe(200);
    }
    const res = await app.request("/", {
      headers: { "x-real-ip": "100.64.0.2", "x-forwarded-for": "100.64.1.99" },
    });
    expect(res.status).toBe(429);
  });

  it("counts different clients separately", async () => {
    const app = limitedApp("separate-clients");
    expect((await statuses(app, { "x-real-ip": "100.64.0.3" }, 11)).at(-1)).toBe(429);
    expect(await statuses(app, { "x-real-ip": "100.64.0.4" }, 1)).toEqual([200]);
  });
});
