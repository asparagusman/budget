import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { addDaysIso } from "@budget/engine";
import {
  CalendarClockIcon,
  PencilIcon,
  PlusIcon,
  ReceiptIcon,
  SaveIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.jsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.jsx";
import { Input } from "@/components/ui/input.jsx";
import { BillDetailSheet } from "@/components/bill-detail-sheet.jsx";
import { SectionsSkeleton, StatsSkeleton } from "@/components/loading.jsx";
import { BillsAgenda } from "@/components/bills-agenda.jsx";
import { BillsBalanceCurve } from "@/components/bills-balance-curve.jsx";
import { CategoryGroup } from "@/components/fixed-costs-table.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { Money } from "@/components/money.jsx";
import { Notice, NoticeList } from "@/components/notice.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { QueryError } from "@/components/query-error.jsx";
import { Stat, StatGroup } from "@/components/stat-tile.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { api } from "@/lib/api.js";
import {
  accountsQueryOptions,
  billsDueSoonQueryOptions,
  billsQueryOptions,
  costCategoriesQueryOptions,
  paySchedulesQueryOptions,
  peopleQueryOptions,
} from "@/lib/queries.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { CADENCE_LABELS } from "@/lib/constants.js";
import { todayIso } from "@/lib/dates.js";
import {
  applySavedBill,
  billToDraft,
  blankDraft,
  draftError,
  draftFigures,
  draftSignature,
  dropDraft,
  historySpread,
  isBlankGhost,
  saveBillDrafts,
} from "@/lib/fixed-costs-draft.js";
import { useSettings } from "@/lib/settings.jsx";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard.js";
import { cn } from "@/lib/utils.js";

/** @import { Cents, PaySchedule, WindowFigures } from "@budget/engine" */
/** @import { Bill, DraftBill } from "@/lib/fixed-costs-draft.js" */
/** @typedef {{ id: string, name: string }} Person */
/** @typedef {{ id: string, name: string, type: string, isIncomeLanding: boolean }} Account */
/** @typedef {{ id: string, name: string, kind: "fixed" | "variable", isEssential: boolean, colour: string | null, sortOrder: number }} CostCategory */
/** @typedef {WindowFigures & { billId: string, categoryId: string, perPayCents: Cents | null }} ServerBillFigures */
/** @typedef {{ categoryId: string, name: string, perYearCents: Cents, perMonthCents: Cents, perPayCents: Cents | null, billCount: number }} CategorySummary */
/** @typedef {{ window: { from: string, to: string }, contribution: { perPayCents: Cents | null, perMonthCents: Cents, perYearCents: Cents }, byBill: ServerBillFigures[], byCategory: CategorySummary[], billCount: number, warnings: { code: string, message: string, billId?: string }[] }} FixedCostsSummary */

/**
 * Four years to the day — 1461 days is exactly 4 × 365.25, so annualising a
 * window total introduces no rounding of its own and a $90 monthly bill reads
 * as $1080.00 rather than $1080.74.
 *
 * It is also the window `apps/api/src/lib/allocation.js` averages the
 * fixed-cost total over. Those were different lengths before, which meant an
 * escalating or seasonal bill quietly contributed one figure here and another
 * to the allocation that deducts it.
 */
const CONTRIBUTION_WINDOW_DAYS = 1461;

/** The balance curve's own horizon — see `<BillsBalanceCurve>` for why it is
 * deliberately shorter than the contribution window. */
const CURVE_WINDOW_DAYS = 365;

/** Six weeks: three fortnightly paydays, and every monthly bill at least once. */
const AGENDA_WINDOW_DAYS = 42;

/**
 * @param {{
 *   open: boolean, onOpenChange: (open: boolean) => void, categories: CostCategory[], submitting: boolean,
 *   onCreate: (name: string) => Promise<void>, onRename: (id: string, name: string) => Promise<void>, onArchive: (id: string) => void,
 * }} props
 */
function CategoryManagerDialog({ open, onOpenChange, categories, submitting, onCreate, onRename, onArchive }) {
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(/** @type {{ id: string, name: string } | null} */ (null));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fixed cost categories</DialogTitle>
          <DialogDescription>"Entertainment", "Utilities", "Rent", "Car" — whatever groups your household actually uses.</DialogDescription>
        </DialogHeader>
        <form
          className="flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            await onCreate(newName.trim());
            setNewName("");
          }}
        >
          <Input placeholder="Add a category…" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button type="submit" disabled={submitting || !newName.trim()}>
            Add
          </Button>
        </form>
        {categories.length === 0 ? (
          <p className="text-sm text-text-muted">No categories yet — add the first one above.</p>
        ) : (
          <DataList>
            {categories.map((cat) => (
              <DataListRow
                key={cat.id}
                primary={
                  renaming?.id === cat.id ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await onRename(cat.id, renaming.name);
                        setRenaming(null);
                      }}
                    >
                      <Input
                        autoFocus
                        className="h-7"
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: cat.id, name: e.target.value })}
                      />
                      <Button type="submit" size="sm">
                        Save
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    cat.name
                  )
                }
                trailing={
                  renaming?.id === cat.id ? null : (
                    <span className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: cat.id, name: cat.name })}>
                        Rename
                      </Button>
                      <Button size="sm" variant="ghost" className="text-text-muted hover:text-text" onClick={() => onArchive(cat.id)}>
                        Archive
                      </Button>
                    </span>
                  )
                }
              />
            ))}
          </DataList>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Bills that know how they actually behave — seasonal, escalating, rolling-
 * average — instead of a flat spreadsheet row, plus the balance curve that
 * comes from projecting them. The average stays the answer; the simulation is
 * insight only (phases/06-fixed-costs.md "Objective").
 *
 * The table edits in place. Reaching a bill's amount used to mean opening its
 * detail sheet and then its form — two menus deep to change one figure — so
 * the list itself is now the editor, with one ghost row per category standing
 * in for the old "Add bill" button. Only the data a row has no width for
 * (entered history, twelve seasonal factors, step changes) still lives behind
 * a modal.
 */
export function FixedCostsPage() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { locale } = useSettings();
  const today = useMemo(todayIso, []);
  const contributionWindow = useMemo(
    () => ({ from: today, to: addDaysIso(today, CONTRIBUTION_WINDOW_DAYS) }),
    [today],
  );
  const curveWindow = useMemo(() => ({ from: today, to: addDaysIso(today, CURVE_WINDOW_DAYS) }), [today]);
  const agendaWindow = useMemo(() => ({ from: today, to: addDaysIso(today, AGENDA_WINDOW_DAYS) }), [today]);

  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [detailBillId, setDetailBillId] = useState(/** @type {string | null} */ (null));
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState(/** @type {DraftBill[]} */ ([]));
  // The mode the TABLE is drawn in, which trails `editing` on purpose. Every
  // bill becomes a small form when the table goes into edit mode — a name
  // field, a money field, a date picker, three or four dropdowns — and
  // building all of them is the slow part of pressing Edit. Waiting for it
  // before showing anything left the button looking dead for most of a
  // second. Deferred, the click commits the header (Save / Cancel) at once
  // and the table is rebuilt in the background, interruptibly, with the
  // current one dimmed meanwhile (`switching`). The same in reverse on
  // Cancel and Save.
  const tableEditing = useDeferredValue(editing);
  const switching = editing !== tableEditing;

  const categoriesQuery = useQuery(costCategoriesQueryOptions("fixed"));

  const billsQuery = useQuery(billsQueryOptions());

  const peopleQuery = useQuery(peopleQueryOptions());

  const accountsQuery = useQuery(accountsQueryOptions());

  const payScheduleQuery = useQuery(paySchedulesQueryOptions());

  const summaryQuery = useQuery({
    queryKey: ["fixed-costs-summary", contributionWindow.from, contributionWindow.to],
    queryFn: async () => {
      const res = await api["fixed-costs"].summary.$get({ query: contributionWindow });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {FixedCostsSummary} */ (await res.json());
    },
  });

  const dueSoonQuery = useQuery(billsDueSoonQueryOptions(today));

  const categories = categoriesQuery.data ?? [];
  const bills = billsQuery.data ?? [];
  const people = peopleQuery.data ?? [];
  const accounts = accountsQuery.data ?? [];
  const summary = summaryQuery.data ?? null;
  const primarySchedule = (payScheduleQuery.data ?? []).find((s) => s.isPrimary) ?? null;
  const payCadenceLabel = primarySchedule ? CADENCE_LABELS[primarySchedule.cadence] : null;
  const dueSoonCount = dueSoonQuery.data?.length ?? 0;
  const warnings = summary?.warnings ?? [];
  const incomeLandingId = accounts.find((a) => a.isIncomeLanding)?.id ?? "";

  const billsById = useMemo(() => new Map(bills.map((b) => [b.id, b])), [bills]);

  function invalidateBills() {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: ["bills"] }),
      queryClient.invalidateQueries({ queryKey: ["fixed-costs-summary"] }),
      queryClient.invalidateQueries({ queryKey: ["bill-instances"] }),
      queryClient.invalidateQueries({ queryKey: ["fixed-costs-balance-curve"] }),
    ]);
  }

  // ---------------------------------------------------------------- edit mode

  /**
   * Seeds the drafts from the saved bills — but only when not already
   * editing. The palette's "Add bill" and "Edit bills" reach this mid-edit
   * too, and re-seeding there threw away every unsaved change on the table.
   * Already editing, "add" just appends a fresh row.
   *
   * @param {string | null} focusCategoryId a category to open with a fresh ghost row
   */
  function beginEdit(focusCategoryId = null) {
    if (editing) {
      if (focusCategoryId) setDrafts((prev) => [...prev, blankDraft(focusCategoryId, incomeLandingId)]);
      return;
    }
    const seeded = bills.map(billToDraft);
    if (focusCategoryId) seeded.push(blankDraft(focusCategoryId, incomeLandingId));
    // The ghost rows go in now rather than from the effect below: left to the
    // effect, entering edit mode built the whole table twice, once without
    // them and once with.
    setDrafts(withGhosts(seeded));
    setEditing(true);
  }

  function leaveEdit() {
    setDrafts([]);
    setEditing(false);
  }

  // Always exactly one blank ghost per category, replenished as soon as the
  // operator starts typing into the last one — the spreadsheet behaviour the
  // old "Add bill" dialog replaced with a modal.
  useEffect(() => {
    if (!editing) return;
    setDrafts(withGhosts);
  }, [editing, drafts, categories, incomeLandingId]);

  /**
   * `drafts` plus a blank ghost for every category that has none — the same
   * array back when nothing is missing, so the effect above settles.
   *
   * @param {DraftBill[]} prev
   */
  function withGhosts(prev) {
    const missing = categories.filter(
      (cat) => !prev.some((d) => d.categoryId === cat.id && d.billId === null && isBlankGhost(d)),
    );
    if (missing.length === 0) return prev;
    return [...prev, ...missing.map((cat) => blankDraft(cat.id, incomeLandingId))];
  }

  /** @param {string} key @param {Partial<DraftBill>} patch */
  function changeDraft(key, patch) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  /** @param {string} key */
  function toggleRemove(key) {
    setDrafts((prev) =>
      prev.flatMap((d) => {
        if (d.key !== key) return [d];
        // A ghost has nothing on the server to archive, so removing it just
        // drops the row.
        if (d.billId === null) return [];
        return [{ ...d, removed: !d.removed }];
      }),
    );
  }

  const dirty = useMemo(() => {
    if (!editing) return false;
    return drafts.some((d) => {
      if (d.billId === null) return !isBlankGhost(d);
      if (d.removed) return true;
      const bill = billsById.get(d.billId);
      return bill ? draftSignature(d) !== draftSignature(billToDraft(bill)) : false;
    });
  }, [editing, drafts, billsById]);

  const changeCount = useMemo(() => {
    if (!editing) return 0;
    return drafts.filter((d) => {
      if (d.billId === null) return !isBlankGhost(d);
      if (d.removed) return true;
      const bill = billsById.get(d.billId);
      return bill ? draftSignature(d) !== draftSignature(billToDraft(bill)) : false;
    }).length;
  }, [editing, drafts, billsById]);

  // ------------------------------------------------------------------- figures

  const serverFigures = useMemo(
    () => new Map((summary?.byBill ?? []).map((f) => [f.billId, f])),
    [summary],
  );

  /**
   * At rest the rows print the server's own per-bill figures; while editing
   * they print `draftFigures`, which is the same `billWindowFigures` over the
   * same window and the same entered history. Two modes, one computation — so
   * saving an edit does not move a number that was already correct.
   *
   * @type {Map<string, WindowFigures | null>}
   */
  const figuresByKey = useMemo(() => {
    /** @type {Map<string, WindowFigures | null>} */
    const map = new Map();
    if (!tableEditing) {
      for (const [billId, figures] of serverFigures) map.set(billId, figures);
      return map;
    }
    // `billsContribution` only reads the schedule for its per-pay figure, so a
    // placeholder is safe when no primary schedule is set — the same
    // convention `computeContribution` uses on the server, and `perPayCents`
    // is discarded below in that case.
    /** @type {PaySchedule} */
    const schedule = primarySchedule
      ? { anchorDate: primarySchedule.anchorDate, cadence: primarySchedule.cadence }
      : { anchorDate: contributionWindow.from, cadence: "monthly" };
    for (const draft of drafts) {
      const bill = draft.billId ? billsById.get(draft.billId) : null;
      map.set(
        draft.key,
        draftFigures(
          draft,
          { seasonalFactors: bill?.seasonalFactors, stepChanges: bill?.stepChanges, history: bill?.history },
          contributionWindow,
          schedule,
        ),
      );
    }
    return map;
  }, [tableEditing, drafts, serverFigures, billsById, contributionWindow, primarySchedule]);

  /**
   * The rows each category renders. At rest they come straight from the loaded
   * bills; while editing, from the drafts — including the ghost rows, which
   * have no bill behind them yet.
   */
  const rowsByCategory = useMemo(() => {
    const source = tableEditing ? drafts : bills.map(billToDraft);
    /** @type {Map<string, import("@/components/fixed-costs-table.jsx").BillRow[]>} */
    const map = new Map();
    for (const draft of source) {
      const bill = draft.billId ? (billsById.get(draft.billId) ?? null) : null;
      const list = map.get(draft.categoryId) ?? [];
      list.push({
        draft,
        bill,
        figures: figuresByKey.get(draft.key) ?? null,
        spread: bill ? historySpread(bill.history) : null,
        error: tableEditing ? draftError(draft) : null,
      });
      map.set(draft.categoryId, list);
    }
    return map;
  }, [tableEditing, drafts, bills, billsById, figuresByKey]);

  /**
   * A category's subtotal is the sum of the rows printed under it — never a
   * separately-pooled computation, so the two cannot disagree
   * (phases/06-fixed-costs.md "Category subtotals are derived"). While editing
   * that means it tracks the unsaved rows, which is the point: a change to one
   * bill moves its category before it is committed.
   *
   * @param {import("@/components/fixed-costs-table.jsx").BillRow[]} rows
   */
  function groupTotals(rows) {
    let perPayCents = 0;
    let perMonthCents = 0;
    let perYearCents = 0;
    for (const row of rows) {
      if (!row.figures || row.draft.removed) continue;
      perPayCents += row.figures.perPayCents;
      perMonthCents += row.figures.perMonthCents;
      perYearCents += row.figures.perYearCents;
    }
    return { perPayCents: primarySchedule ? perPayCents : null, perMonthCents, perYearCents };
  }

  const invalidRows = useMemo(
    () => [...rowsByCategory.values()].flat().filter((row) => row.error !== null).length,
    [rowsByCategory],
  );

  // ------------------------------------------------------------------ mutations

  const createCategory = useMutation({
    mutationFn: async (/** @type {string} */ name) => {
      const res = await api["cost-categories"].$post({ json: { name, kind: "fixed" } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cost-categories", "fixed"] }),
    onError: (/** @type {Error} */ err) => toast.error(err.message),
  });

  const renameCategory = useMutation({
    mutationFn: async (/** @type {{ id: string, name: string }} */ { id, name }) => {
      const res = await api["cost-categories"][":id"].$patch({ param: { id }, json: { name } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cost-categories", "fixed"] }),
    onError: (/** @type {Error} */ err) => toast.error(err.message),
  });

  const archiveCategory = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["cost-categories"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cost-categories", "fixed"] });
      invalidateBills();
    },
    onError: (/** @type {Error} */ err) => toast.error(err.message),
  });

  const archiveBill = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api.bills[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateBills();
      toast.success("Bill archived.");
    },
    onError: (/** @type {Error} */ err) => toast.error(err.message),
  });

  /**
   * One Save for the whole table — the sequence itself, and why a partial
   * failure must record what already landed, is `saveBillDrafts`. Here each
   * reported success is folded straight into the drafts on screen: a created
   * row takes its new id, an archived row leaves the table. So a retry after
   * "Internet was rejected" sends Internet and what came after it, never the
   * rows that already made it.
   */
  const saveAll = useMutation({
    mutationFn: () =>
      saveBillDrafts(
        drafts,
        billsById,
        {
          create: async (payload) => {
            const res = await api.bills.$post({ json: payload });
            if (!res.ok) throw new Error(await readApiError(res));
            return /** @type {Bill} */ ((await res.json()).bill);
          },
          update: async (id, payload) => {
            const res = await api.bills[":id"].$patch({ param: { id }, json: payload });
            if (!res.ok) throw new Error(await readApiError(res));
            return /** @type {Bill} */ ((await res.json()).bill);
          },
          archive: async (id) => {
            const res = await api.bills[":id"].$delete({ param: { id } });
            if (!res.ok) throw new Error(await readApiError(res));
          },
        },
        {
          created: (sent, bill) => setDrafts((prev) => applySavedBill(prev, sent, bill)),
          updated: (sent, bill) => setDrafts((prev) => applySavedBill(prev, sent, bill)),
          archived: (sent) => setDrafts((prev) => dropDraft(prev, sent.key)),
        },
      ),
    onSuccess: ({ created, updated, archived }) => {
      leaveEdit();
      const parts = [
        created > 0 ? `${created} added` : null,
        updated > 0 ? `${updated} updated` : null,
        archived > 0 ? `${archived} archived` : null,
      ].filter((p) => p !== null);
      toast.success(parts.length > 0 ? `Bills saved — ${parts.join(", ")}.` : "Nothing changed.");
    },
    // Deliberately stays in edit mode with the drafts intact: whatever the
    // server rejected is still on screen to fix, and the error names it.
    onError: (/** @type {Error} */ err) => toast.error(err.message),
    // Settled, not success: after a partial failure the rows that did land
    // are real bills now, and the table has to show them as such.
    onSettled: () => invalidateBills(),
  });

  async function handleSave() {
    const archiving = drafts.filter((d) => d.billId !== null && d.removed);
    if (archiving.length > 0) {
      const ok = await confirm({
        title: `Archive ${archiving.length} bill${archiving.length === 1 ? "" : "s"}?`,
        description:
          "They leave the contribution, the calendar and the balance curve. Their entered history is kept, and nothing else on this table is affected.",
        confirmLabel: "Save and archive",
      });
      if (!ok) return;
    }
    saveAll.mutate();
  }

  async function handleCancel() {
    if (dirty) {
      const ok = await confirm({
        title: "Discard these edits?",
        description: `${changeCount} unsaved change${changeCount === 1 ? "" : "s"} on this table would be lost.`,
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
      });
      if (!ok) return;
    }
    leaveEdit();
  }

  useUnsavedGuard(dirty && !saveAll.isPending, {
    title: "Leave with unsaved bills?",
    description: "The edits on the Fixed Costs table haven't been saved yet, and leaving discards them.",
  });

  useEffect(
    () =>
      registerCommands([
        {
          id: "fixed-costs:edit",
          group: "Actions",
          label: "Edit bills",
          keywords: "inline table amount model cadence",
          icon: PencilIcon,
          run: () => beginEdit(),
        },
        {
          id: "fixed-costs:add-bill",
          group: "Actions",
          label: "Add bill",
          icon: PlusIcon,
          run: () => beginEdit(categories[0]?.id ?? null),
        },
        {
          id: "fixed-costs:manage-categories",
          group: "Actions",
          label: "Manage fixed cost categories",
          icon: TagIcon,
          run: () => setCategoryManagerOpen(true),
        },
        {
          id: "fixed-costs:enter-history",
          group: "Actions",
          label: "Enter bill history",
          icon: CalendarClockIcon,
          run: () => {
            if (bills[0]) setDetailBillId(bills[0].id);
          },
        },
        {
          id: "fixed-costs:open-calendar",
          group: "Navigation",
          label: "Open calendar",
          icon: CalendarClockIcon,
          run: () => navigate({ to: "/calendar" }),
        },
      ]),
    // `editing` is here so the commands' `beginEdit` sees the current mode —
    // registered against a stale `false`, "Add bill" re-seeded mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bills, categories, navigate, incomeLandingId, editing],
  );

  const isLoading = categoriesQuery.isLoading || billsQuery.isLoading;
  // Either failing would otherwise read as "No categories yet" / "No bills
  // yet" — an invitation to re-enter bills that exist.
  const loadError = categoriesQuery.error ?? billsQuery.error ?? null;
  const populatedCategories = tableEditing
    ? categories
    : categories.filter((cat) => (rowsByCategory.get(cat.id) ?? []).length > 0);

  return (
    <>
      {/* Pinned on a phone only while editing, when Save and Cancel have to
          stay in reach down a long table. Reading, it's two buttons parked
          over the top of a phone's screen for no reason. (Desktop always pins
          it.) */}
      <PageHeader
        stickyOnMobile={editing}
        title="Fixed Costs"
        description={
          editing
            ? "Edit any cell. A bill's history, seasonal factors and step changes are behind its name."
            : "Bills that know how they actually behave — seasonal, escalating, rolling-average — not just an amount times a frequency."
        }
        actions={
          editing ? (
            <>
              {/* Live status, so it stays in view rather than behind the (i).
                  The change count is already on the Save button. */}
              {invalidRows > 0 ? (
                <span className="text-sm text-warning-strong">
                  {invalidRows} row{invalidRows === 1 ? "" : "s"} need attention
                </span>
              ) : null}
              <Button variant="ghost" onClick={handleCancel} disabled={saveAll.isPending}>
                <XIcon />
                {dirty ? "Cancel" : "Done"}
              </Button>
              {dirty ? (
                <Button onClick={handleSave} disabled={saveAll.isPending || invalidRows > 0}>
                  <SaveIcon />
                  {saveAll.isPending ? "Saving…" : `Save ${changeCount} change${changeCount === 1 ? "" : "s"}`}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setCategoryManagerOpen(true)}>
                <TagIcon />
                Categories
              </Button>
              <Button onClick={() => beginEdit()} disabled={categories.length === 0 || loadError !== null}>
                <PencilIcon />
                Edit
              </Button>
            </>
          )
        }
      />

      {/* Kept on the page as well as toasted: a failed save leaves the table
          in edit mode with one row to fix, and the toast that named it is
          gone in a few seconds. */}
      {editing && saveAll.error && !saveAll.isPending ? (
        <Notice kind="error">{saveAll.error.message}</Notice>
      ) : null}

      {loadError ? (
        <QueryError
          error={loadError}
          what="your bills"
          onRetry={() => Promise.all([categoriesQuery.refetch(), billsQuery.refetch()])}
        />
      ) : !isLoading && categories.length === 0 ? (
        <EmptyState
          icon={TagIcon}
          title="No categories yet"
          description="Add a category — Entertainment, Utilities, Rent, Car — before adding your first bill."
          action={
            <Button onClick={() => setCategoryManagerOpen(true)}>
              <PlusIcon />
              Add category
            </Button>
          }
        />
      ) : null}

      {summary ? (
        <StatGroup aria-label="Fixed costs summary">
          <Stat
            lead
            label={`Bills contribution${payCadenceLabel ? ` (${payCadenceLabel})` : " per month"}`}
            value={
              summary.contribution.perPayCents != null ? (
                <Money value={summary.contribution.perPayCents} />
              ) : (
                <Money value={summary.contribution.perMonthCents} />
              )
            }
            hint={
              <>
                <Money value={summary.contribution.perMonthCents} /> / month ·{" "}
                <Money value={summary.contribution.perYearCents} /> / year
              </>
            }
          />
          <Stat label="Total bills" value={summary.billCount} />
          <Stat label="Due in 14 days" value={dueSoonCount} />
        </StatGroup>
      ) : summaryQuery.isPending && !loadError ? (
        // Pending, not loading: the summary waits on the pay schedule for its
        // window, and while it waits it isn't fetching yet either.
        <StatsSkeleton lead labels={["Bills contribution", "Total bills", "Due in 14 days"]} label="Loading the bills summary" />
      ) : null}

      {/* The rows print the summary's per-bill figures at rest, so without
          it every amount on the table would read as $0. */}
      {summaryQuery.error && !loadError ? (
        <QueryError
          compact
          error={summaryQuery.error}
          what="the bills' yearly and per-pay figures"
          onRetry={() => summaryQuery.refetch()}
        />
      ) : null}

      {warnings.length > 0 ? (
        <NoticeList items={warnings.map((w, i) => ({ key: String(i), content: <p>{w.message}</p> }))} />
      ) : null}

      {loadError ? null : isLoading ? (
        <SectionsSkeleton label="Loading bills" />
      ) : !editing && categories.length > 0 && bills.length === 0 ? (
        <EmptyState
          icon={ReceiptIcon}
          title="No bills yet"
          description="Add every recurring cost the household actually pays — electricity, rent, insurance, subscriptions."
          action={
            <Button onClick={() => beginEdit(categories[0]?.id ?? null)}>
              <PlusIcon />
              Add bill
            </Button>
          }
        />
      ) : (
        // One block: the categories are parts of a single list of bills, so
        // they sit closer to each other than the page's blocks do.
        //
        // Dimmed and inert while the table catches up with the mode (see
        // `tableEditing`): it's still the old table, and a click on it would
        // land on a row that is about to be replaced.
        <div
          aria-busy={switching}
          className={cn("flex flex-col gap-5 transition-opacity md:gap-6", switching && "pointer-events-none opacity-60")}
        >
          {switching ? (
            <span className="sr-only" aria-live="polite">
              {editing ? "Opening the editor" : "Closing the editor"}
            </span>
          ) : null}
          {populatedCategories.map((cat) => {
            const rows = rowsByCategory.get(cat.id) ?? [];
            return (
              <CategoryGroup
                key={cat.id}
                category={cat}
                rows={rows}
                totals={groupTotals(rows)}
                payCadenceLabel={payCadenceLabel}
                editing={tableEditing}
                people={people}
                accounts={accounts}
                locale={locale}
                onChange={changeDraft}
                onRemove={toggleRemove}
                onOpenBill={setDetailBillId}
                onAddBill={(categoryId) => setDrafts((prev) => [...prev, blankDraft(categoryId, incomeLandingId)])}
              />
            );
          })}
        </div>
      )}

      {/* The calendar's Agenda over the next six weeks — the same list and
          the same expected balance, read from today rather than by month. */}
      <section
        aria-labelledby="fixed-costs-upcoming"
        className="overflow-hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card)"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 id="fixed-costs-upcoming" className="text-sm font-semibold text-text">
            Next six weeks
          </h2>
          <Link to="/calendar" className="text-xs font-medium text-text-muted underline-offset-2 hover:underline">
            Open calendar
          </Link>
        </div>
        <BillsAgenda
          window={agendaWindow}
          emptyTitle="Nothing in the next six weeks"
          emptyDescription="No paydays or bills fall in the next six weeks."
        />
      </section>

      <BillsBalanceCurve window={curveWindow} />

      <CategoryManagerDialog
        open={categoryManagerOpen}
        onOpenChange={setCategoryManagerOpen}
        categories={categories}
        submitting={createCategory.isPending}
        onCreate={async (name) => {
          await createCategory.mutateAsync(name);
        }}
        onRename={async (id, name) => {
          await renameCategory.mutateAsync({ id, name });
        }}
        onArchive={async (id) => {
          const name = categories.find((c) => c.id === id)?.name ?? "this category";
          // The server refuses to archive a category that still holds bills;
          // saying so here beats a confirmation whose "yes" then fails.
          const holding = bills.filter((b) => b.categoryId === id).length;
          if (holding > 0) {
            toast.error(
              `${name} still holds ${holding} bill${holding === 1 ? "" : "s"} — move or archive ${holding === 1 ? "it" : "them"} first.`,
            );
            return;
          }
          const ok = await confirm({
            title: `Archive ${name}?`,
            description: "It leaves the Fixed Costs table and can no longer be chosen for a bill.",
            confirmLabel: "Archive",
          });
          if (ok) archiveCategory.mutate(id);
        }}
      />

      <BillDetailSheet
        billId={detailBillId}
        figures={detailBillId ? (serverFigures.get(detailBillId) ?? null) : null}
        onOpenChange={(open) => !open && setDetailBillId(null)}
        categories={categories}
        people={people}
        onArchive={async (id) => {
          const ok = await confirm({
            title: `Archive ${bills.find((b) => b.id === id)?.name ?? "this bill"}?`,
            description:
              "It leaves the contribution, the calendar and the balance curve. Its instances and history are kept.",
            confirmLabel: "Archive",
          });
          if (ok) {
            setDetailBillId(null);
            // Mid-edit, its row would otherwise stay on the table pointing at
            // a bill that no longer exists, and Save would trip over it.
            setDrafts((prev) => prev.filter((d) => d.billId !== id));
            archiveBill.mutate(id);
          }
        }}
      />
    </>
  );
}
