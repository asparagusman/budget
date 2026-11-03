import { describe, expect, it } from "vitest";
import { envSchema } from "./env.js";

// PUBLIC_ORIGIN is the address the household types, and CORS and the invite
// CLI's links are built from it. Getting it slightly wrong doesn't fail at
// startup on its own, so these are the near-misses that actually happen.

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
    ["http://budget.local", "http://budget.local"],
    // Harmless spellings of the same origin, normalised to what the browser
    // sends — so CORS and the invite CLI's links match it exactly.
    ["http://budget.local/", "http://budget.local"],
    ["http://Budget.Local:80", "http://budget.local"],
    ["https://budget.example.com", "https://budget.example.com"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://127.0.0.1:5173", "http://127.0.0.1:5173"],
  ])("accepts %s as %s", (input, expected) => {
    const result = parseOrigin(input);
    expect(result.success && result.data.PUBLIC_ORIGIN).toBe(expected);
  });

  it.each([
    ["budget.local", "is not a URL"],
    ["ftp://budget.local", "must start with http:// or https://"],
    ["http://budget.local.", "must not end in a dot"],
    ["http://budget.local/budget", "no path"],
    ["http://budget.local/?x=1", "no path, query"],
    ["http://user@budget.local", "username or password"],
  ])("rejects %s, naming the value", (input, why) => {
    const problem = problemWith(input);
    expect(problem).toContain(why);
    expect(problem).toContain(`"${input}"`);
  });

  it("reports an empty value once, as missing", () => {
    expect(problemWith("")).toBe("PUBLIC_ORIGIN is required");
  });
});
