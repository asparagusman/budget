import { billWindowFigures, projectInstances, toCents } from "@budget/engine";

/** @import { AmountModel, Cadence, Cents, DateWindow, PaySchedule, WindowFigures } from "@budget/engine" */

/**
 * @typedef {{
 *   dueDate: string,
 *   actualCents: Cents | null,
 *   expectedCents: Cents | null,
 *   isOverride: boolean,
 * }} BillHistoryRow A stored `bill_instances` row as `GET /bills` sends it.
 */

/**
 * @typedef {{
 *   id: string,
 *   categoryId: string,
 *   name: string,
 *   ownerPersonId: string | null,
 *   paidFromAccountId: string | null,
 *   baseAmountCents: Cents,
 *   frequency: Cadence,
 *   anchorDate: string,
 *   amountModel: AmountModel,
 *   escalationPct: number | null,
 *   rollingWindow: number | null,
 *   notes: string | null,
 *   sortOrder: number,
 *   seasonalFactors: Record<string, number>,
 *   stepChanges: { id: string, billId: string, effectiveFrom: string, newAmountCents: Cents, note: string | null }[],
 *   history: BillHistoryRow[],
 *   dueDateConfirmed: boolean,
 * }} Bill
 *
 * `dueDateConfirmed` is false while `anchorDate` is still the placeholder the
 * importer gave it (the workbook holds no due dates). Changing the date
 * confirms it server-side; `PATCH { dueDateConfirmed: true }` confirms a
 * placeholder that happened to be right.
 */

/**
 * @typedef {{
 *   key: string,
 *   billId: string | null,
 *   categoryId: string,
 *   name: string,
 *   ownerPersonId: string,
 *   paidFromAccountId: string,
 *   amountText: string,
 *   frequency: Cadence,
 *   anchorDate: string,
 *   amountModel: AmountModel,
 *   escalationPctText: string,
 *   rollingWindowText: string,
 *   notes: string,
 *   removed: boolean,
 * }} DraftBill
 *
 * One editable row. Every numeric field is the raw string from its input, not
 * a number: the row's derived figures recompute on each keystroke, and a
 * number makes "17." or "" unrepresentable — the field would fight the
 * operator mid-type. Same reasoning as lib/allocation-draft.js.
 *
 * `ownerPersonId`/`paidFromAccountId` are `""` for "not set" rather than
 * `null`, because that is what a `<Select>` can actually hold.
 *
 * `billId` is `null` on a row that does not exist on the server yet, which is
 * what tells Save whether to POST or PATCH. `removed` marks a row the
 * operator has struck out but not yet saved — kept in place, greyed, so the
 * decision stays visible and reversible until Save.
 */

// Keys only need to be unique within one editing session: they are React keys
// and draft-map keys, never sent anywhere. An existing bill uses its own id so
// a refetch mid-edit lines up with the row it belongs to.
let ghostSeq = 0;

/** @param {string} categoryId @param {string} defaultAccountId */
export function blankDraft(categoryId, defaultAccountId) {
  ghostSeq += 1;
  return /** @type {DraftBill} */ ({
    key: `new-bill-${ghostSeq}`,
    billId: null,
    categoryId,
    name: "",
    ownerPersonId: "",
    paidFromAccountId: defaultAccountId,
    amountText: "",
    frequency: "monthly",
    anchorDate: "",
    amountModel: "flat",
    escalationPctText: "",
    rollingWindowText: "6",
    notes: "",
    removed: false,
  });
}

/** @param {Bill} bill @returns {DraftBill} */
export function billToDraft(bill) {
  return {
    key: bill.id,
    billId: bill.id,
    categoryId: bill.categoryId,
    name: bill.name,
    ownerPersonId: bill.ownerPersonId ?? "",
    paidFromAccountId: bill.paidFromAccountId ?? "",
    amountText: String(bill.baseAmountCents / 100),
    frequency: bill.frequency,
    anchorDate: bill.anchorDate,
    amountModel: bill.amountModel,
    escalationPctText: bill.escalationPct != null ? String(bill.escalationPct) : "",
    rollingWindowText: bill.rollingWindow != null ? String(bill.rollingWindow) : "6",
    notes: bill.notes ?? "",
    removed: false,
  };
}

/**
 * The comparable form of a row, for deciding whether the screen is dirty.
 * Built from the draft's own fields rather than from the payload, so a row
 * that is currently invalid (a half-typed amount) still counts as an edit.
 *
 * @param {DraftBill} draft
 */
export function draftSignature(draft) {
  return JSON.stringify([
    draft.billId,
    draft.categoryId,
    draft.name.trim(),
    draft.ownerPersonId,
    draft.paidFromAccountId,
    draft.amountText.trim(),
    draft.frequency,
    draft.anchorDate,
    draft.amountModel,
    draft.escalationPctText.trim(),
    draft.rollingWindowText.trim(),
    draft.notes.trim(),
    draft.removed,
  ]);
}

/** @param {DraftBill[]} drafts */
export function draftsSignature(drafts) {
  return drafts.map(draftSignature).join("\n");
}

/**
 * `null` when the row has nothing worth saving yet — a ghost row the operator
 * tabbed through and left alone. A blank ghost is not an error; it is simply
 * not a bill, and Save skips it silently.
 *
 * @param {DraftBill} draft
 */
export function isBlankGhost(draft) {
  return draft.billId === null && draft.name.trim() === "" && draft.amountText.trim() === "";
}

/**
 * What stops a row from being saveable, in the operator's words. Mirrors the
 * server's own rules (`createBillSchema` plus `amountModelFieldError`) so a
 * bad row is caught at the cell rather than as a toast after a round trip.
 *
 * @param {DraftBill} draft
 * @returns {string | null}
 */
export function draftError(draft) {
  if (draft.removed || isBlankGhost(draft)) return null;
  if (draft.name.trim() === "") return "Needs a name.";
  const amount = Number(draft.amountText);
  if (draft.amountText.trim() === "" || !Number.isFinite(amount)) return "Needs an amount.";
  if (amount < 0) return "Amount cannot be negative.";
  if (draft.anchorDate === "") return "Needs a due date to anchor the series.";
  if (draft.amountModel === "escalating") {
    const pct = Number(draft.escalationPctText);
    if (draft.escalationPctText.trim() === "" || !Number.isFinite(pct)) return "Needs a yearly percentage.";
    if (pct < 0 || pct > 100) return "Percentage must be between 0 and 100.";
  }
  if (draft.amountModel === "rolling_average") {
    const window = Number(draft.rollingWindowText);
    if (!Number.isInteger(window) || window < 1) return "Needs a whole window of at least 1.";
  }
  return null;
}

/**
 * Draft -> the JSON body `POST /bills` and `PATCH /bills/:id` both take.
 * `escalationPct`/`rollingWindow` are nulled out for the models that do not
 * use them, so switching a bill from escalating to flat clears the stale
 * percentage instead of leaving it to resurface later.
 *
 * @param {DraftBill} draft
 */
export function draftToPayload(draft) {
  return {
    categoryId: draft.categoryId,
    name: draft.name.trim(),
    ownerPersonId: draft.ownerPersonId || null,
    paidFromAccountId: draft.paidFromAccountId || null,
    baseAmountCents: toCents(Number(draft.amountText)),
    frequency: draft.frequency,
    anchorDate: draft.anchorDate,
    amountModel: draft.amountModel,
    escalationPct: draft.amountModel === "escalating" ? Number(draft.escalationPctText) : null,
    rollingWindow: draft.amountModel === "rolling_average" ? Number(draft.rollingWindowText) : null,
    notes: draft.notes.trim() || null,
  };
}

/** @typedef {ReturnType<typeof draftToPayload>} BillPayload */

/**
 * What one Save has to do, in the order it does it: create the ghosts that
 * were filled in, patch the rows that changed, archive the rows that were
 * struck out. A row whose bill is not in `billsById` (created moments ago,
 * before the refetch landed) has nothing to compare against and is left
 * alone — it was just written, so there is nothing to patch.
 *
 * @param {DraftBill[]} drafts
 * @param {Map<string, Bill>} billsById
 */
export function planBillSave(drafts, billsById) {
  /** @type {DraftBill[]} */
  const creates = [];
  /** @type {(DraftBill & { billId: string })[]} */
  const updates = [];
  /** @type {(DraftBill & { billId: string })[]} */
  const archives = [];

  for (const draft of drafts) {
    const { billId } = draft;
    if (billId === null) {
      if (!isBlankGhost(draft)) creates.push(draft);
      continue;
    }
    if (draft.removed) {
      archives.push({ ...draft, billId });
      continue;
    }
    const bill = billsById.get(billId);
    if (bill && draftSignature(draft) !== draftSignature(billToDraft(bill))) updates.push({ ...draft, billId });
  }
  return { creates, updates, archives };
}

/**
 * @typedef {{
 *   create: (payload: BillPayload) => Promise<Bill>,
 *   update: (id: string, payload: BillPayload) => Promise<Bill>,
 *   archive: (id: string) => Promise<void>,
 * }} BillSaveCalls
 * The three requests, injected so the sequence can be tested without a
 * server. Each throws an `Error` carrying the API's own message.
 */

/**
 * @typedef {{
 *   created: (sent: DraftBill, bill: Bill) => void,
 *   updated: (sent: DraftBill, bill: Bill) => void,
 *   archived: (sent: DraftBill) => void,
 * }} BillSaveProgress
 * Called the moment each request succeeds — not once at the end — so the
 * drafts on screen record every step that landed even if a later one fails.
 */

/**
 * A Save that stopped partway. `done` counts the requests that landed before
 * `draft` was rejected; they are already on the server, and the drafts were
 * told so through `BillSaveProgress` as each one succeeded.
 */
export class BillSaveError extends Error {
  /** @param {DraftBill} draft @param {string} reason @param {number} done */
  constructor(draft, reason, done) {
    const name = draft.name.trim() || "the new bill";
    const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
    super(
      done > 0
        ? `Couldn't save "${name}": ${sentence} The ${done} change${done === 1 ? "" : "s"} before it ${done === 1 ? "was" : "were"} saved.`
        : `Couldn't save "${name}": ${sentence}`,
    );
    this.name = "BillSaveError";
    this.draftKey = draft.key;
  }
}

/**
 * One Save for the whole table, one request at a time, stopping at the first
 * rejection.
 *
 * Sequential rather than parallel: at household scale the round trips are
 * cheap, and "Electricity was rejected" is something the operator can act on
 * where several simultaneous rejections are not.
 *
 * The part that matters is what a failure leaves behind. This used to throw
 * on the first rejection without recording what had already landed, so the
 * retry POSTed every earlier ghost again — duplicate bills — and re-sent
 * every earlier DELETE, which 404s forever on a bill that is already
 * archived. Now each success is reported as it happens, and the caller
 * folds it into the drafts (`applySavedBill`, `dropDraft`), so a retry only
 * ever sends what has not landed yet.
 *
 * @param {DraftBill[]} drafts
 * @param {Map<string, Bill>} billsById
 * @param {BillSaveCalls} calls
 * @param {BillSaveProgress} progress
 */
export async function saveBillDrafts(drafts, billsById, calls, progress) {
  const { creates, updates, archives } = planBillSave(drafts, billsById);
  let done = 0;

  /**
   * @template T
   * @param {DraftBill} draft
   * @param {() => Promise<T>} run
   */
  async function step(draft, run) {
    try {
      const result = await run();
      done += 1;
      return result;
    } catch (err) {
      throw new BillSaveError(draft, err instanceof Error ? err.message : String(err), done);
    }
  }

  for (const draft of creates) {
    const bill = await step(draft, () => calls.create(draftToPayload(draft)));
    progress.created(draft, bill);
  }
  for (const draft of updates) {
    const bill = await step(draft, () => calls.update(draft.billId, draftToPayload(draft)));
    progress.updated(draft, bill);
  }
  for (const draft of archives) {
    await step(draft, () => calls.archive(draft.billId));
    progress.archived(draft);
  }

  return { created: creates.length, updated: updates.length, archived: archives.length };
}

/**
 * Folds a saved bill back into its draft. If the row is exactly as it was
 * sent, it becomes the server's own copy (so "17.50" typed and "17.5" stored
 * don't count as an edit afterwards); if the operator kept typing while the
 * request was in flight, those keystrokes are kept and only the id is taken.
 * Either way the row now has a `billId`, which is what stops a retry from
 * creating it a second time.
 *
 * The draft keeps its own `key`, so React keeps the row it is typing in.
 *
 * @param {DraftBill[]} drafts
 * @param {DraftBill} sent
 * @param {Bill} bill
 */
export function applySavedBill(drafts, sent, bill) {
  return drafts.map((d) => {
    if (d.key !== sent.key) return d;
    return draftSignature(d) === draftSignature(sent) ? { ...billToDraft(bill), key: d.key } : { ...d, billId: bill.id };
  });
}

/**
 * Drops a row whose archive landed — there is nothing left on the server for
 * it to be, and leaving it struck out would send the DELETE again.
 *
 * @param {DraftBill[]} drafts
 * @param {string} key
 */
export function dropDraft(drafts, key) {
  return drafts.filter((d) => d.key !== key);
}

/**
 * Weekly and quarterly are restatements of the annual figure, not of one
 * occurrence — that is the whole point. Deriving them from `perYearCents`
 * keeps them consistent with the subtotal for a bill whose occurrences are
 * not all the same size, where `oneInstance * occurrencesPerYear` is simply
 * a different number.
 *
 * Shared by the table row and the bill sheet's "Same bill, other cadences",
 * which used to restate the typed base instead and so disagreed with the row
 * for every bill that isn't flat.
 *
 * @param {Pick<WindowFigures, "perMonthCents" | "perYearCents">} figures
 */
export function restatedFigures(figures) {
  return {
    weeklyCents: Math.round(figures.perYearCents / 52),
    monthlyCents: figures.perMonthCents,
    quarterlyCents: Math.round(figures.perYearCents / 4),
    yearlyCents: figures.perYearCents,
  };
}

/**
 * Stored history rows -> the engine's `BillInstance[]`.
 *
 * This is what makes a live preview honest. Project a `rolling_average` bill
 * with no history and it falls back to the base amount, which is exactly the
 * figure the screen used to print while the budget was built from the average
 * of the entered actuals. `GET /bills` sends these rows for that reason.
 *
 * @param {string} billId
 * @param {BillHistoryRow[]} rows
 */
export function toEngineHistory(billId, rows) {
  return rows.map((r) => ({
    billId,
    dueDate: r.dueDate,
    expectedCents: r.expectedCents ?? 0,
    actualCents: r.actualCents,
    isOverride: r.isOverride,
  }));
}

/**
 * The row's figures as they would be if the draft were saved — the same
 * `billWindowFigures` the server runs for `/fixed-costs/summary`, over the
 * same window and the same history, so the preview a keystroke produces and
 * the figure that comes back after Save are the same computation rather than
 * two that ought to agree.
 *
 * `null` for a row that cannot be projected yet (no amount, no anchor date):
 * there is no honest number to show, and a zero would read as one.
 *
 * @param {DraftBill} draft
 * @param {{ seasonalFactors?: Record<string, number>, stepChanges?: { effectiveFrom: string, newAmountCents: Cents }[], history?: BillHistoryRow[] }} stored
 * @param {DateWindow} window
 * @param {PaySchedule} paySchedule
 * @returns {WindowFigures | null}
 */
export function draftFigures(draft, stored, window, paySchedule) {
  if (draftError(draft) !== null || draft.removed || isBlankGhost(draft)) return null;
  const id = draft.billId ?? draft.key;
  const factorEntries = Object.entries(stored.seasonalFactors ?? {});

  try {
    const instances = projectInstances(
      {
        id,
        baseAmountCents: toCents(Number(draft.amountText)),
        frequency: draft.frequency,
        anchorDate: draft.anchorDate,
        amountModel: draft.amountModel,
        escalationPct: draft.amountModel === "escalating" ? Number(draft.escalationPctText) : undefined,
        rollingWindow: draft.amountModel === "rolling_average" ? Number(draft.rollingWindowText) : undefined,
        seasonalFactors:
          factorEntries.length > 0
            ? Object.fromEntries(factorEntries.map(([month, factor]) => [Number(month), factor]))
            : undefined,
        stepChanges: stored.stepChanges,
      },
      window,
      toEngineHistory(id, stored.history ?? []),
    );
    return billWindowFigures(instances, window, paySchedule);
  } catch {
    // A cadence/anchor combination the projector cannot walk is an invalid
    // row, not a crashed page.
    return null;
  }
}

/**
 * The spread of what this bill has actually cost, from the actuals the
 * operator entered — the real answer to "does this bill vary?", which
 * `WindowFigures.variesInWindow` cannot give: a rolling average collapses a
 * wide history into one steady forecast, so the forecast does not vary even
 * though the bill plainly does.
 *
 * @param {BillHistoryRow[]} rows
 */
export function historySpread(rows) {
  const actuals = rows.map((r) => r.actualCents).filter((c) => c !== null);
  if (actuals.length === 0) return null;
  const total = actuals.reduce((a, b) => a + b, 0);
  return {
    count: actuals.length,
    minCents: Math.min(...actuals),
    maxCents: Math.max(...actuals),
    meanCents: Math.round(total / actuals.length),
  };
}
