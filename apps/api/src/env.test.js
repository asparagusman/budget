import { describe, expect, it } from "vitest";
import { envSchema } from "./env.js";

// PUBLIC_ORIGIN is the WebAuthn RP ID's source, and getting it slightly
// wrong doesn't fail at startup on its own — it fails at the passkey prompt,
// naming nothing. These are the near-misses that actually happen.

const BASE = {
  DATABASE_URL: "postgres://budget:pw@db:5432/budget",
  SESSION_SECRET: "x".repeat(32),
};

/** @param {string} origin */
function parseOrigin(origin) {
  return envSchema.safeParse({ ...BASE, PUBLIC_ORIGIN: origin });
}

/** @param {string} origin */
function problemWith(origin) {
  const result = parseOrigin(origin);
  if (result.success) return null;
  return result.error.issues.map((issue) => issue.message).join("; ");
}

describe("PUBLIC_ORIGIN", () => {
  it.each([
    ["https://budget.tail1234.ts.net", "https://budget.tail1234.ts.net"],
    // Harmless spellings of the same origin, normalised to what the browser
    // sends — so CORS and the invite CLI's links match it exactly.
    ["https://budget.tail1234.ts.net/", "https://budget.tail1234.ts.net"],
    ["https://Budget.Tail1234.ts.net:443", "https://budget.tail1234.ts.net"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://127.0.0.1:5173", "http://127.0.0.1:5173"],
  ])("accepts %s as %s", (input, expected) => {
    const result = parseOrigin(input);
    expect(result.success && result.data.PUBLIC_ORIGIN).toBe(expected);
  });

  it.each([
    ["budget.tail1234.ts.net", "is not a URL"],
    ["http://budget.tail1234.ts.net", "must be https://"],
    ["https://budget.tail1234.ts.net.", "must not end in a dot"],
    ["https://budget.tail1234.ts.net/budget", "no path"],
    ["https://budget.tail1234.ts.net/?x=1", "no path, query"],
    ["https://user@budget.tail1234.ts.net", "username or password"],
  ])("rejects %s, naming the value", (input, why) => {
    const problem = problemWith(input);
    expect(problem).toContain(why);
    expect(problem).toContain(`"${input}"`);
  });

  it("reports an empty value once, as missing", () => {
    expect(problemWith("")).toBe("PUBLIC_ORIGIN is required");
  });
});
