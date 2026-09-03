import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

// The app's only password hash. Small suite on purpose — the interesting
// properties are "a stored value the operator can read tells them nothing"
// and "a stored value nobody can parse fails closed".

const PASSWORD = "correct-horse-battery-staple-42";

describe("hashPassword", () => {
  it("produces a self-describing record with its own cost and salt", async () => {
    const stored = await hashPassword(PASSWORD);
    const [scheme, n, r, p, salt, hash] = stored.split("$");
    expect(scheme).toBe("scrypt");
    // The parameters travel with the hash, so raising them later does not
    // invalidate what is already stored.
    expect(Number(n)).toBeGreaterThanOrEqual(65_536);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    expect(salt?.length).toBeGreaterThan(10);
    expect(hash?.length).toBeGreaterThan(40);
    expect(stored).not.toContain(PASSWORD);
  });

  it("salts per call, so two identical passwords do not look identical", async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });
});

describe("verifyPassword", () => {
  it("accepts the password and nothing near it", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword(`${PASSWORD} `, stored)).toBe(false);
    expect(await verifyPassword(PASSWORD.toUpperCase(), stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("normalises unicode, so the same text typed two ways still verifies", async () => {
    // é as one code point, and as e + combining acute: the same password to
    // the person who wrote it down, and different bytes on the wire.
    const stored = await hashPassword("café-recovery-phrase-1");
    expect(await verifyPassword("café-recovery-phrase-1", stored)).toBe(true);
  });

  it("fails closed on a stored value it cannot parse", async () => {
    // A hand-edited or corrupted column must fail the sign-in, not throw and
    // tell the caller that something interesting is in there.
    for (const stored of [null, "", "not-a-hash", "scrypt$1$2$3", "bcrypt$1$8$1$aaaa$bbbb", "scrypt$x$8$1$aaaa$bbbb", "scrypt$65536$8$1$aaaa$"]) {
      expect(await verifyPassword(PASSWORD, stored), `stored: ${stored}`).toBe(false);
    }
  });
});
