import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { addDaysIso } from "@budget/engine";
import {
  AlertTriangleIcon,
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
import { BillsBalanceCurve } from "@/components/bills-balance-curve.jsx";
import { CategoryGroup } from "@/components/fixed-costs-table.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { Money } from "@/components/money.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { StatTile } from "@/components/stat-tile.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { CADENCE_LABELS } from "@/lib/constants.js";
import { todayIso } from "@/lib/dates.js";
import {
  billToDraft,
  blankDraft,
  draftError,
  draftFigures,
  draftSignature,
  draftToPayload,
  historySpread,
  isBlankGhost,
} from "@/lib/fixed-costs-draft.js";
import { useSettings } from "@/lib/settings.jsx";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard.js";

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
                      <Button size="sm" variant="ghost" className="text-negative" onClick={() => onArchive(cat.id)}>
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

  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [detailBillId, setDetailBillId] = useState(/** @type {string | null} */ (null));
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState(/** @type {DraftBill[]} */ ([]));

  const categoriesQuery = useQuery({
    queryKey: ["cost-categories", "fixed"],
    queryFn: async () => {
      const res = await api["cost-categories"].$get({ query: { kind: "fixed" } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {CostCategory[]} */ ((await res.json()).costCategories);
    },
  });

  const billsQuery = useQuery({
    queryKey: ["bills"],
    queryFn: async () => {
      const res = await api.bills.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {Bill[]} */ ((await res.json()).bills);
    },
  });

  const peopleQuery = useQuery({
    queryKey: ["people"],
    queryFn: async () => {
      const res = await api.people.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {Person[]} */ ((await res.json()).people);
    },
  });

  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: async () => {
      const res = await api.accounts.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {Account[]} */ ((await res.json()).accounts);
    },
  });

  const payScheduleQuery = useQuery({
    queryKey: ["pay-schedules"],
    queryFn: async () => {
      const res = await api["pay-schedules"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).paySchedules;
    },
  });

  const summaryQuery = useQuery({
    queryKey: ["fixed-costs-summary", contributionWindow.from, contributionWindow.to],
    queryFn: async () => {
      const res = await api["fixed-costs"].summary.$get({ query: contributionWindow });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {FixedCostsSummary} */ (await res.json());
    },
  });

  const dueSoonQuery = useQuery({
    queryKey: ["bill-instances", "due-soon", today],
    queryFn: async () => {
      const res = await api["bill-instances"].$get({ query: { from: today, to: addDaysIso(today, 14) } });
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).instances;
    },
  });

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
    queryClient.invalidateQueries({ queryKey: ["bills"] });
    queryClient.invalidateQueries({ queryKey: ["fixed-costs-summary"] });
    queryClient.invalidateQueries({ queryKey: ["bill-instances"] });
    queryClient.invalidateQueries({ queryKey: ["fixed-costs-balance-curve"] });
  }

  // ---------------------------------------------------------------- edit mode

  /** @param {string | null} focusCategoryId a category to open with a fresh ghost row */
  function beginEdit(focusCategoryId = null) {
    const seeded = bills.map(billToDraft);
    if (focusCategoryId) seeded.push(blankDraft(focusCategoryId, incomeLandingId));
    setDrafts(seeded);
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
    setDrafts((prev) => {
      const missing = categories.filter(
        (cat) => !prev.some((d) => d.categoryId === cat.id && d.billId === null && isBlankGhost(d)),
      );
      if (missing.length === 0) return prev;
      return [...prev, ...missing.map((cat) => blankDraft(cat.id, incomeLandingId))];
    });
  }, [editing, drafts, categories, incomeLandingId]);

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
    if (!editing) {
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
  }, [editing, drafts, serverFigures, billsById, contributionWindow, primarySchedule]);

  /**
   * The rows each category renders. At rest they come straight from the loaded
   * bills; while editing, from the drafts — including the ghost rows, which
   * have no bill behind them yet.
   */
  const rowsByCategory = useMemo(() => {
    const source = editing ? drafts : bills.map(billToDraft);
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
        error: editing ? draftError(draft) : null,
      });
      map.set(draft.categoryId, list);
    }
    return map;
  }, [editing, drafts, bills, billsById, figuresByKey]);

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
   * One Save for the whole table: create the ghosts that were filled in,
   * patch the rows that changed, archive the rows that were struck out.
   *
   * Sequential rather than parallel, and it stops at the first failure — at
   * household scale the round trips are cheap, and "row 4 was rejected" is
   * information the operator can act on, where a handful of simultaneous
   * rejections is not.
   */
  const saveAll = useMutation({
    mutationFn: async () => {
      /** @type {DraftBill[]} */
      const creates = [];
      /** @type {DraftBill[]} */
      const updates = [];
      /** @type {DraftBill[]} */
      const archives = [];

      for (const draft of drafts) {
        if (draft.billId === null) {
          if (!isBlankGhost(draft)) creates.push(draft);
          continue;
        }
        if (draft.removed) {
          archives.push(draft);
          continue;
        }
        const bill = billsById.get(draft.billId);
        if (bill && draftSignature(draft) !== draftSignature(billToDraft(bill))) updates.push(draft);
      }

      /** @param {DraftBill} draft @param {Response} res */
      const failing = async (draft, res) => new Error(`${draft.name || "New bill"}: ${await readApiError(res)}`);

      for (const draft of creates) {
        const res = await api.bills.$post({ json: draftToPayload(draft) });
        if (!res.ok) throw await failing(draft, res);
      }
      for (const draft of updates) {
        const res = await api.bills[":id"].$patch({
          param: { id: /** @type {string} */ (draft.billId) },
          json: draftToPayload(draft),
        });
        if (!res.ok) throw await failing(draft, res);
      }
      for (const draft of archives) {
        const res = await api.bills[":id"].$delete({ param: { id: /** @type {string} */ (draft.billId) } });
        if (!res.ok) throw await failing(draft, res);
      }

      return { created: creates.length, updated: updates.length, archived: archives.length };
    },
    onSuccess: ({ created, updated, archived }) => {
      invalidateBills();
      leaveEdit();
      const parts = [
        created > 0 ? `${created} added` : null,
        updated > 0 ? `${updated} updated` : null,
        archived > 0 ? `${archived} archived` : null,
      ].filter((p) => p !== null);
      toast.success(parts.length > 0 ? `Bills saved — ${parts.join(", ")}.` : "Nothing changed.");
    },
    // Deliberately stays in edit mode with the drafts intact: whatever the
    // server rejected is still on screen to fix.
    onError: (/** @type {Error} */ err) => toast.error(err.message),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bills, categories, navigate, incomeLandingId],
  );

  const isLoading = categoriesQuery.isLoading || billsQuery.isLoading;
  const populatedCategories = editing
    ? categories
    : categories.filter((cat) => (rowsByCategory.get(cat.id) ?? []).length > 0);

  return (
    <>
      <PageHeader
        sticky
        title="Fixed Costs"
        description={
          editing ? (
            dirty ? (
              <span className="text-text">
                {changeCount} unsaved change{changeCount === 1 ? "" : "s"}
                {invalidRows > 0 ? (
                  <span className="text-negative">
                    {" · "}
                    {invalidRows} row{invalidRows === 1 ? "" : "s"} need attention
                  </span>
                ) : null}
              </span>
            ) : (
              "Edit any cell. A bill's history, seasonal factors and step changes are behind its name."
            )
          ) : (
            "Bills that know how they actually behave — seasonal, escalating, rolling-average — not just an amount times a frequency."
          )
        }
        actions={
          editing ? (
            <>
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
              <Button onClick={() => beginEdit()} disabled={categories.length === 0}>
                <PencilIcon />
                Edit
              </Button>
            </>
          )
        }
      />

      {!isLoading && categories.length === 0 ? (
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
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile
            className="col-span-2"
            label={`Bills contribution${payCadenceLabel ? ` (${payCadenceLabel})` : " per month"}`}
            value={
              summary.contribution.perPayCents != null ? (
                <Money value={summary.contribution.perPayCents} />
              ) : (
                <Money value={summary.contribution.perMonthCents} />
              )
            }
            sparkline={
              <p className="text-xs text-text-muted">
                <Money value={summary.contribution.perMonthCents} /> / month ·{" "}
                <Money value={summary.contribution.perYearCents} /> / year
              </p>
            }
          />
          <StatTile label="Total bills" value={summary.billCount} />
          <StatTile label="Due in 14 days" value={dueSoonCount} />
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-(--radius-card) bg-negative-soft p-4">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 text-sm text-negative">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p>{w.message}</p>
            </div>
          ))}
        </div>
      ) : null}

      {!isLoading && !editing && categories.length > 0 && bills.length === 0 ? (
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
        populatedCategories.map((cat) => {
          const rows = rowsByCategory.get(cat.id) ?? [];
          return (
            <CategoryGroup
              key={cat.id}
              category={cat}
              rows={rows}
              totals={groupTotals(rows)}
              payCadenceLabel={payCadenceLabel}
              editing={editing}
              people={people}
              accounts={accounts}
              locale={locale}
              onChange={changeDraft}
              onRemove={toggleRemove}
              onOpenBill={setDetailBillId}
              onAddBill={(categoryId) => setDrafts((prev) => [...prev, blankDraft(categoryId, incomeLandingId)])}
            />
          );
        })
      )}

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
        onArchive={(id) => archiveCategory.mutate(id)}
      />

      <BillDetailSheet
        billId={detailBillId}
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
            archiveBill.mutate(id);
          }
        }}
      />
    </>
  );
}
