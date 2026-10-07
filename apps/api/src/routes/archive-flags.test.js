import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import * as tables from "@budget/schema";
import { accounts, paySchedules, people } from "@budget/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { createAccountsRoutes } from "./accounts.js";
import { createPaySchedulesRoutes } from "./pay-schedules.js";

/** @import { Db } from "@budget/schema" */

// Archiving the primary pay schedule, or the income-landing account, used to
// trap the household: the archive set only `archivedAt`, the flag stayed on a
// row every computation ignores, and both the friendly pre-check and the
// partial unique index still counted it — so no other schedule could become
// primary and no other account could take the landing flag, and nothing on
// screen could reach the archived row to clear it.

/** @type {Db} */
let db;
/** @type {() => Promise<void>} */
let close;
/** @type {import("hono").Hono} */
let app;
/** @type {string} */
let personId;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  app = new Hono()
    .route("/pay-schedules", createPaySchedulesRoutes({ db }))
    .route("/accounts", createAccountsRoutes({ db }));
  const [person] = await db.insert(people).values({ name: "Ada" }).returning();
  personId = person?.id ?? "";
});

afterEach(async () => {
  await close();
});

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [json]
 */
async function send(method, path, json) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  /** @type {any} */
  const body = await res.json();
  return { status: res.status, body };
}

describe("archiving the primary pay schedule", () => {
  /** @param {boolean} isPrimary */
  const createSchedule = (isPrimary) =>
    send("POST", "/pay-schedules", { personId, anchorDate: "2026-01-02", cadence: "fortnightly", isPrimary });

  it("gives up the flag, so another schedule can be made primary", async () => {
    const first = await createSchedule(true);
    expect(first.status).toBe(201);

    expect((await send("DELETE", `/pay-schedules/${first.body.paySchedule.id}`)).status).toBe(200);
    const archived = await db.query.paySchedules.findFirst({ where: eq(paySchedules.id, first.body.paySchedule.id) });
    expect(archived?.archivedAt).not.toBeNull();
    expect(archived?.isPrimary).toBe(false);

    // Both ways in: created as primary, and promoted to primary afterwards.
    const second = await createSchedule(true);
    expect(second.status).toBe(201);
    expect(second.body.paySchedule.isPrimary).toBe(true);

    expect((await send("DELETE", `/pay-schedules/${second.body.paySchedule.id}`)).status).toBe(200);
    const third = await createSchedule(false);
    const promoted = await send("PATCH", `/pay-schedules/${third.body.paySchedule.id}`, { isPrimary: true });
    expect(promoted.status).toBe(200);
    expect(promoted.body.paySchedule.isPrimary).toBe(true);
  });

  it("is not counted by the pre-check even when an archived row still holds the flag", async () => {
    // A row archived before the fix, the way migration 0013 found them —
    // written directly, since the API can no longer produce one.
    await db.insert(paySchedules).values({
      personId,
      anchorDate: "2025-01-03",
      cadence: "fortnightly",
      isPrimary: true,
      archivedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const created = await createSchedule(true);
    expect(created.status).toBe(201);
  });

  it("still allows only one live primary", async () => {
    await createSchedule(true);
    const second = await createSchedule(true);
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe("primary_conflict");

    // And the database says so too, not only the friendly pre-check.
    await expect(
      db.insert(paySchedules).values({ personId, anchorDate: "2026-02-02", cadence: "monthly", isPrimary: true }),
    ).rejects.toThrow();
  });

  it("refuses to make an archived schedule primary", async () => {
    const created = await createSchedule(false);
    await send("DELETE", `/pay-schedules/${created.body.paySchedule.id}`);
    const res = await send("PATCH", `/pay-schedules/${created.body.paySchedule.id}`, { isPrimary: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("archived");
  });
});

describe("migrating a database archived before the fix", () => {
  it("clears the flags those archives left behind, and frees the slot for a live row", async () => {
    // Every other test here starts from an empty database, which can never
    // hold what migration 0013 exists for: a row archived while it was still
    // primary. So this one migrates to just before it, writes that row the
    // way the old API left it, and then applies the rest.
    const source = fileURLToPath(new URL("../../../../packages/schema/migrations", import.meta.url));
    const folder = mkdtempSync(join(tmpdir(), "budget-migrations-"));
    const client = new PGlite();
    try {
      cpSync(source, folder, { recursive: true });
      const journalPath = join(folder, "meta", "_journal.json");
      /** @type {{ entries: { tag: string }[] }} */
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const cut = journal.entries.findIndex((e) => e.tag === "0013_clear_flags_on_archived_rows");
      expect(cut).toBeGreaterThan(0);
      writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut) }));

      const legacy = drizzle(client, { schema: tables });
      await migrate(legacy, { migrationsFolder: folder });
      // Raw SQL, not the Drizzle tables: those describe the schema AFTER the
      // migrations still to come.
      await client.exec(`
        INSERT INTO people (id, name) VALUES ('20000000-0000-4000-8000-000000000001', 'Ada');
        INSERT INTO pay_schedules (person_id, anchor_date, cadence, is_primary, archived_at)
          VALUES ('20000000-0000-4000-8000-000000000001', '2025-01-03', 'fortnightly', true, now());
        INSERT INTO pay_schedules (person_id, anchor_date, cadence, is_primary)
          VALUES ('20000000-0000-4000-8000-000000000001', '2026-01-02', 'fortnightly', false);
        INSERT INTO accounts (name, type, is_income_landing, archived_at) VALUES ('Old everyday', 'transaction', true, now());
        INSERT INTO accounts (name, type, is_income_landing) VALUES ('Everyday', 'transaction', false);
      `);
      // The trap itself, as the old index enforced it.
      await expect(
        client.exec("UPDATE pay_schedules SET is_primary = true WHERE archived_at IS NULL"),
      ).rejects.toThrow();

      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(legacy, { migrationsFolder: folder });

      const archivedSchedules = await client.query("SELECT is_primary FROM pay_schedules WHERE archived_at IS NOT NULL");
      expect(archivedSchedules.rows).toEqual([{ is_primary: false }]);
      const archivedAccounts = await client.query("SELECT is_income_landing FROM accounts WHERE archived_at IS NOT NULL");
      expect(archivedAccounts.rows).toEqual([{ is_income_landing: false }]);

      await client.exec("UPDATE pay_schedules SET is_primary = true WHERE archived_at IS NULL");
      await client.exec("UPDATE accounts SET is_income_landing = true WHERE archived_at IS NULL");
    } finally {
      await client.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("archiving the income-landing account", () => {
  /** @param {string} name @param {boolean} isIncomeLanding */
  const createAccount = (name, isIncomeLanding) => send("POST", "/accounts", { name, type: "transaction", isIncomeLanding });

  it("gives up the flag, so another account can take it", async () => {
    const first = await createAccount("Everyday", true);
    expect(first.status).toBe(201);

    expect((await send("DELETE", `/accounts/${first.body.account.id}`)).status).toBe(200);
    const archived = await db.query.accounts.findFirst({ where: eq(accounts.id, first.body.account.id) });
    expect(archived?.isIncomeLanding).toBe(false);

    const second = await createAccount("New everyday", true);
    expect(second.status).toBe(201);

    expect((await send("DELETE", `/accounts/${second.body.account.id}`)).status).toBe(200);
    const third = await createAccount("Third", false);
    const promoted = await send("PATCH", `/accounts/${third.body.account.id}`, { isIncomeLanding: true });
    expect(promoted.status).toBe(200);
    expect(promoted.body.account.isIncomeLanding).toBe(true);
  });

  it("is not counted by the pre-check or the index when an archived row still holds the flag", async () => {
    await db.insert(accounts).values({
      name: "Old everyday",
      type: "transaction",
      isIncomeLanding: true,
      archivedAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect((await createAccount("Everyday", true)).status).toBe(201);
    await expect(
      db.insert(accounts).values({ name: "A second live one", type: "transaction", isIncomeLanding: true }),
    ).rejects.toThrow();
  });

  it("refuses to make an archived account the landing one", async () => {
    const created = await createAccount("Old", false);
    await send("DELETE", `/accounts/${created.body.account.id}`);
    const res = await send("PATCH", `/accounts/${created.body.account.id}`, { isIncomeLanding: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("archived");
  });
});
