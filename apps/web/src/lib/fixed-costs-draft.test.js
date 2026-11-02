import { describe, expect, it } from "vitest";
import {
  BillSaveError,
  applySavedBill,
  billToDraft,
  blankDraft,
  dropDraft,
  planBillSave,
  restatedFigures,
  saveBillDrafts,
} from "./fixed-costs-draft.js";

/** @import { Bill, BillPayload, BillSaveCalls, DraftBill } from "./fixed-costs-draft.js" */

// A Save that fails partway used to leave no trace of the requests that had
// landed, so the retry created the earlier bills a second time and re-sent
// archives that 404 forever. These tests drive the sequence the way the page
// does — fold every reported success into the drafts, refetch, retry — and
// count what reaches the "server".

/** @param {Partial<Bill> & { id: string, name: string }} fields @returns {Bill} */
function bill(fields) {
  return {
    categoryId: "cat-utilities",
    ownerPersonId: null,
    paidFromAccountId: null,
    baseAmountCents: 10_000,
    frequency: "monthly",
    anchorDate: "2026-01-15",
    amountModel: "flat",
    escalationPct: null,
    rollingWindow: null,
    notes: null,
    sortOrder: 0,
    seasonalFactors: {},
    stepChanges: [],
    history: [],
    dueDateConfirmed: true,
    ...fields,
  };
}

/** @param {string} name @param {string} amountText */
function ghost(name, amountText) {
  return { ...blankDraft("cat-utilities", ""), name, amountText, anchorDate: "2026-02-01" };
}

/**
 * An in-memory server that rejects whatever `failOn` names, once each, and
 * records every request it receives.
 *
 * @param {Bill[]} initial
 */
function fakeServer(initial) {
  /** @type {Map<string, Bill>} */
  const bills = new Map(initial.map((b) => [b.id, b]));
  /** @type {string[]} */
  const log = [];
  /** @type {Set<string>} */
  const failOn = new Set();
  let seq = 0;

  /** @param {string} id @param {BillPayload} payload */
  const stored = (id, payload) => bill({ ...payload, id, sortOrder: 0 });

  /** @type {BillSaveCalls} */
  const calls = {
    async create(payload) {
      log.push(`create ${payload.name}`);
      if (failOn.delete(payload.name)) throw new Error("Cost category not found.");
      seq += 1;
      const created = stored(`bill-${seq}`, payload);
      bills.set(created.id, created);
      return created;
    },
    async update(id, payload) {
      log.push(`update ${payload.name}`);
      if (failOn.delete(payload.name)) throw new Error("Rejected.");
      const updated = stored(id, payload);
      bills.set(id, updated);
      return updated;
    },
    async archive(id) {
      const current = bills.get(id);
      log.push(`archive ${current?.name ?? id}`);
      // What the real DELETE does to a bill that is already archived.
      if (!current) throw new Error("Bill not found.");
      if (failOn.delete(current.name)) throw new Error("Rejected.");
      bills.delete(id);
    },
  };

  return { bills, log, failOn, calls };
}

/**
 * One Save as the page runs it: successes folded into the drafts as they are
 * reported, the drafts kept whatever happens.
 *
 * @param {{ drafts: DraftBill[] }} state
 * @param {Map<string, Bill>} billsById what the page's `bills` query holds
 * @param {BillSaveCalls} calls
 */
async function save(state, billsById, calls) {
  return saveBillDrafts(state.drafts, billsById, calls, {
    created: (sent, saved) => {
      state.drafts = applySavedBill(state.drafts, sent, saved);
    },
    updated: (sent, saved) => {
      state.drafts = applySavedBill(state.drafts, sent, saved);
    },
    archived: (sent) => {
      state.drafts = dropDraft(state.drafts, sent.key);
    },
  });
}

describe("planBillSave", () => {
  it("sorts the drafts into creates, updates and archives, and skips blank ghosts and unchanged rows", () => {
    const power = bill({ id: "power", name: "Power" });
    const water = bill({ id: "water", name: "Water" });
    const rates = bill({ id: "rates", name: "Rates" });
    const billsById = new Map([power, water, rates].map((b) => [b.id, b]));

    const drafts = [
      billToDraft(power),
      { ...billToDraft(water), amountText: "120" },
      { ...billToDraft(rates), removed: true },
      ghost("Gas", "80"),
      blankDraft("cat-utilities", ""),
    ];

    const plan = planBillSave(drafts, billsById);
    expect(plan.creates.map((d) => d.name)).toEqual(["Gas"]);
    expect(plan.updates.map((d) => d.name)).toEqual(["Water"]);
    expect(plan.archives.map((d) => d.name)).toEqual(["Rates"]);
  });

  it("leaves alone a row whose bill was created moments ago and has not been refetched yet", () => {
    const drafts = [{ ...ghost("Gas", "80"), billId: "bill-9" }];
    const plan = planBillSave(drafts, new Map());
    expect(plan).toEqual({ creates: [], updates: [], archives: [] });
  });
});

describe("saveBillDrafts", () => {
  it("never creates a bill twice when a retry follows a partial failure", async () => {
    const server = fakeServer([]);
    const state = { drafts: [ghost("Gas", "80"), ghost("Internet", "90"), ghost("Phone", "45")] };
    server.failOn.add("Internet");

    await expect(save(state, new Map(server.bills), server.calls)).rejects.toThrow(BillSaveError);
    expect(server.log).toEqual(["create Gas", "create Internet"]);

    // Retry both before the refetch lands and after it.
    await save(state, new Map(), server.calls);
    expect(server.log).toEqual(["create Gas", "create Internet", "create Internet", "create Phone"]);
    await save(state, new Map(server.bills), server.calls);

    expect([...server.bills.values()].map((b) => b.name).sort()).toEqual(["Gas", "Internet", "Phone"]);
    expect(server.log.filter((entry) => entry === "create Gas")).toHaveLength(1);
  });

  it("does not re-send an archive that already landed", async () => {
    const water = bill({ id: "water", name: "Water" });
    const rates = bill({ id: "rates", name: "Rates" });
    const server = fakeServer([water, rates]);
    const state = {
      drafts: [
        { ...billToDraft(water), removed: true },
        { ...billToDraft(rates), removed: true },
      ],
    };
    server.failOn.add("Rates");

    await expect(save(state, new Map(server.bills), server.calls)).rejects.toThrow(/Rates/);
    // The archived row is gone from the table, so it cannot be sent again.
    expect(state.drafts.map((d) => d.name)).toEqual(["Rates"]);

    await save(state, new Map(server.bills), server.calls);
    expect(server.log).toEqual(["archive Water", "archive Rates", "archive Rates"]);
    expect(server.bills.size).toBe(0);
  });

  it("names the failing row and says how much landed before it", async () => {
    const server = fakeServer([]);
    server.failOn.add("Internet");
    const state = { drafts: [ghost("Gas", "80"), ghost("Internet", "90")] };

    const error = await save(state, new Map(), server.calls).catch((/** @type {unknown} */ err) => err);
    expect(error).toBeInstanceOf(BillSaveError);
    expect(/** @type {BillSaveError} */ (error).message).toBe(
      'Couldn\'t save "Internet": Cost category not found. The 1 change before it was saved.',
    );
    expect(/** @type {BillSaveError} */ (error).draftKey).toBe(state.drafts[1]?.key);
  });

  it("reports the counts of a save that went through", async () => {
    const power = bill({ id: "power", name: "Power" });
    const server = fakeServer([power]);
    const state = { drafts: [{ ...billToDraft(power), name: "Electricity" }, ghost("Gas", "80")] };

    await expect(save(state, new Map(server.bills), server.calls)).resolves.toEqual({
      created: 1,
      updated: 1,
      archived: 0,
    });
  });
});

describe("applySavedBill", () => {
  it("swaps an untouched row for the server's copy, keeping the row's key", () => {
    const sent = ghost("Gas", "80.50");
    const saved = bill({ id: "bill-1", name: "Gas", baseAmountCents: 8050, anchorDate: "2026-02-01" });
    const [row] = applySavedBill([sent], sent, saved);
    expect(row).toEqual({ ...billToDraft(saved), key: sent.key });
  });

  it("keeps keystrokes typed while the request was in flight, taking only the id", () => {
    const sent = ghost("Gas", "80");
    const typedSince = { ...sent, amountText: "85" };
    const saved = bill({ id: "bill-1", name: "Gas", baseAmountCents: 8000 });
    const [row] = applySavedBill([typedSince], sent, saved);
    expect(row).toEqual({ ...typedSince, billId: "bill-1" });
  });
});

describe("restatedFigures", () => {
  it("restates from the annual figure, matching the table row", () => {
    expect(restatedFigures({ perMonthCents: 9_000, perYearCents: 108_000 })).toEqual({
      weeklyCents: 2_077,
      monthlyCents: 9_000,
      quarterlyCents: 27_000,
      yearlyCents: 108_000,
    });
  });
});
