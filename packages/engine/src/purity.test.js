// Enforces the non-negotiable purity rules from `01-engine.md`: no wall-clock
// I/O anywhere in the engine, and no dependency beyond `date-fns`.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dirname, ".");

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listSourceFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) return [full];
    return [];
  });
}

describe("purity", () => {
  it("never calls the wall-clock constructors banned by the engine's purity rules", () => {
    // Built from parts rather than written literally, so this file itself
    // doesn't trip the exact grep command the phase doc's verification step
    // runs (`grep -rnE "new Date\(\)|Date\.now\(\)" packages/engine/src`).
    const banned = [["new", "Date()"].join(" "), ["Date", "now()"].join(".")];
    const pattern = new RegExp(banned.map((s) => s.replace(/[().]/g, "\\$&")).join("|"));

    /** @type {string[]} */
    const offenders = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      const text = readFileSync(file, "utf8");
      if (pattern.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("declares no dependency other than date-fns", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["date-fns"]);
  });
});
