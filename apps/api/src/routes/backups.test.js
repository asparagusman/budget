import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { auditLog, people } from "@budget/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listBackups } from "../lib/backup.js";
import { isRecoveryAllowed } from "../middleware/auth.js";
import { createTestDb } from "../test/db.js";
import { HOUSEHOLD_IDS as ID, seedHousehold } from "../test/household.js";
import { createBackupsRoutes } from "./backups.js";

/** @import { Db } from "@budget/schema" */

/** @type {Db} */
let db;
/** @type {() => Promise<void>} */
let close;
/** @type {import("hono").Hono} */
let app;
/** @type {string} */
let dir;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedHousehold(db);
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "budget-backups-route-"));
  app = new Hono().route("/backups", createBackupsRoutes({ db, backups: { dir, appVersion: "test" } }));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * @param {string} method
 * @param {string} path
 * @param {FormData} [body]
 */
function send(method, path, body) {
  return app.request(path, { method, body });
}

/** @param {Response} res @returns {Promise<any>} */
const json = (res) => res.json();

async function takeOne() {
  const res = await send("POST", "/backups");
  return (await json(res)).backup;
}

describe("GET /backups", () => {
  it("lists newest first, with the status the dashboard and the status line read", async () => {
    const empty = await json(await send("GET", "/backups"));
    expect(empty.backups).toEqual([]);
    expect(empty.status).toMatchObject({ newestAutomaticAt: null, lastAttempt: null, overdue: true });

    await takeOne();
    const body = await json(await send("GET", "/backups"));
    expect(body.backups).toHaveLength(1);
    expect(body.backups[0]).toMatchObject({ kind: "manual" });
    expect(body.backups[0].sizeBytes).toBeGreaterThan(0);
    expect(body.status.lastAttempt).toMatchObject({ ok: true, kind: "manual" });
  });
});

describe("POST /backups", () => {
  it("takes a manual backup and says so in the audit log", async () => {
    const res = await send("POST", "/backups");
    expect(res.status).toBe(201);
    const { backup } = await json(res);
    expect(backup.id).toMatch(/^manual-\d{8}T\d{9}Z\.json\.gz$/);
    expect((await listBackups(dir)).map((b) => b.id)).toEqual([backup.id]);
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "backup.create"))).length).toBeGreaterThan(0);
  });
});

describe("GET /backups/:id/download", () => {
  it("serves the file itself, as an attachment", async () => {
    const backup = await takeOne();
    const res = await send("GET", `/backups/${backup.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(backup.id);
    const file = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8"));
    expect(file.header.kind).toBe("manual");
    expect(file.tables.people).toHaveLength(2);
  });

  it.each(["..%2F..%2Fetc%2Fpasswd", "weekly-20200101T000000000Z.json.gz", "notes.txt", "%2e%2e"])(
    "answers 404 for %s, never a path",
    async (id) => {
      expect((await send("GET", `/backups/${id}/download`)).status).toBe(404);
      expect((await send("POST", `/backups/${id}/restore`)).status).toBe(404);
      expect((await send("DELETE", `/backups/${id}`)).status).toBe(404);
    },
  );
});

describe("POST /backups/:id/restore", () => {
  it("replaces the data, takes a safety backup, and names what it restored", async () => {
    const backup = await takeOne();
    await db.update(people).set({ name: "Changed" }).where(eq(people.id, ID.ada));

    const res = await send("POST", `/backups/${backup.id}/restore`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.restored).toEqual({ kind: "manual", takenAt: backup.takenAt });
    expect(body.safetyBackup.kind).toBe("before-restore");

    const [ada] = await db.select().from(people).where(eq(people.id, ID.ada));
    expect(ada?.name).toBe("Ada");
  });
});

describe("POST /backups/restore", () => {
  /** A backup padded past 8KB: smaller multipart bodies don't survive a Request built in memory under vitest. */
  async function uploadable() {
    const backup = await takeOne();
    const download = await send("GET", `/backups/${backup.id}/download`);
    const file = JSON.parse(gunzipSync(Buffer.from(await download.arrayBuffer())).toString("utf8"));
    file.header.appVersion = randomBytes(16_384).toString("hex");
    return new File([new Uint8Array(gzipSync(JSON.stringify(file)))], "my-backup.json.gz", { type: "application/gzip" });
  }

  it("restores from an uploaded file", async () => {
    const file = await uploadable();
    await db.update(people).set({ name: "Changed" }).where(eq(people.id, ID.ada));

    const body = new FormData();
    body.set("file", file, "my-backup.json.gz");
    const res = await send("POST", "/backups/restore", body);
    expect(res.status).toBe(200);
    expect((await json(res)).restored.kind).toBe("manual");

    const [ada] = await db.select().from(people).where(eq(people.id, ID.ada));
    expect(ada?.name).toBe("Ada");
  });

  it("says so when the file isn't a backup", async () => {
    const body = new FormData();
    body.set("file", new File([new Uint8Array(randomBytes(16_384))], "photo.jpg"), "photo.jpg");
    const res = await send("POST", "/backups/restore", body);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toEqual({
      code: "invalid_backup",
      message: "That file isn't a backup from this app.",
    });
  });
});

describe("DELETE /backups/:id", () => {
  it("removes the file", async () => {
    const backup = await takeOne();
    expect((await send("DELETE", `/backups/${backup.id}`)).status).toBe(204);
    expect(await listBackups(dir)).toEqual([]);
    expect((await send("DELETE", `/backups/${backup.id}`)).status).toBe(404);
  });
});

describe("who may reach it", () => {
  // A recovery-password session may only get a device approved. Backups carry
  // every figure the household has, and a restore rewrites them.
  it.each([
    ["GET", "/backups"],
    ["POST", "/backups"],
    ["GET", "/backups/manual-20261102T030000000Z.json.gz/download"],
    ["POST", "/backups/restore"],
    ["POST", "/backups/manual-20261102T030000000Z.json.gz/restore"],
    ["DELETE", "/backups/manual-20261102T030000000Z.json.gz"],
  ])("blocks a recovery session from %s %s", (method, path) => {
    expect(isRecoveryAllowed(path, method)).toBe(false);
  });
});
