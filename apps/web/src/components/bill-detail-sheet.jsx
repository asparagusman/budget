import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toCents } from "@budget/engine";
import { CheckIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { BarChart, Bar, CartesianGrid, XAxis } from "recharts";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";
import { Input } from "@/components/ui/input.jsx";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group.jsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { AXIS, Chart, ChartTooltip, ChartTooltipContent, TOTAL, useChartMotion } from "@/components/chart.jsx";
import { BillHistoryEntry } from "@/components/bill-history-entry.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { DatePicker } from "@/components/date-picker.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { Money } from "@/components/money.jsx";
import { InlineError, Notice } from "@/components/notice.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { AMOUNT_MODEL_LABELS, CADENCE_LABELS, MONTH_LABELS } from "@/lib/constants.js";
import { formatIsoDate, todayIso } from "@/lib/dates.js";
import { historySpread, restatedFigures } from "@/lib/fixed-costs-draft.js";
import { useSettings } from "@/lib/settings.jsx";

/** @import { Cadence, Cents, WindowFigures } from "@budget/engine" */
/** @import { Bill } from "@/lib/fixed-costs-draft.js" */
/** @typedef {{ id: string, name: string }} Person */
/** @typedef {{ id: string, name: string, kind: "fixed" | "variable", isEssential: boolean, colour: string | null, sortOrder: number }} CostCategory */
/** @typedef {{ id: string, billId: string, effectiveFrom: string, newAmountCents: Cents, note: string | null }} StepChange */
/** @typedef {{ id: string, billId: string, dueDate: string, expectedCents: Cents | null, actualCents: Cents | null, isOverride: boolean, paidOn: string | null, note: string | null }} RecentInstance */
/** @typedef {Bill & { recentInstances: RecentInstance[] }} BillDetail */

/**
 * @param {{ open: boolean, onOpenChange: (open: boolean) => void, stepChange: StepChange | null, submitting: boolean, onSubmit: (data: { effectiveFrom: string, newAmountCents: Cents, note: string | null }) => Promise<void>, onDelete: (() => void) | null }} props
 */
function StepChangeFormDialog({ open, onOpenChange, stepChange, submitting, onSubmit, onDelete }) {
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setEffectiveFrom(stepChange?.effectiveFrom ?? todayIso());
    setAmount(stepChange ? String(stepChange.newAmountCents / 100) : "");
    setNote(stepChange?.note ?? "");
    setError(null);
  }, [open, stepChange]);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (amount.trim() === "") {
      setError("Enter the new amount.");
      return;
    }
    try {
      await onSubmit({ effectiveFrom, newAmountCents: toCents(Number(amount)), note: note.trim() || null });
      onOpenChange(false);
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{stepChange ? "Edit step change" : "Add step change"}</DialogTitle>
          <DialogDescription>A new base amount from this date forward — replaces the bill's base, not a modifier on top of it.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FieldRow label="Effective from" htmlFor="step-from">
            <DatePicker id="step-from" value={effectiveFrom} onChange={setEffectiveFrom} />
          </FieldRow>
          <FieldRow label="New amount" htmlFor="step-amount" required>
            <InputGroup>
              <InputGroupAddon>
                <InputGroupText>$</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput id="step-amount" type="number" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </InputGroup>
          </FieldRow>
          <FieldRow label="Note" htmlFor="step-note" hint="Optional.">
            <Input id="step-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </FieldRow>
          {error ? <InlineError>{error}</InlineError> : null}
          <DialogFooter className={onDelete ? "sm:justify-between!" : undefined}>
            {onDelete ? (
              <Button type="button" variant="ghost" className="text-text-muted hover:text-text" onClick={onDelete}>
                Delete
              </Button>
            ) : null}
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** @param {{ bill: BillDetail }} props */
function StepChangesPanel({ bill }) {
  const { locale } = useSettings();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(/** @type {{ stepChange: StepChange | null } | null} */ (null));

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["bill-detail", bill.id] });
    queryClient.invalidateQueries({ queryKey: ["bills"] });
    queryClient.invalidateQueries({ queryKey: ["fixed-costs-summary"] });
    // A step change moves every instance after it, and the balance curve on
    // the page behind this sheet is drawn from those instances.
    queryClient.invalidateQueries({ queryKey: ["fixed-costs-balance-curve"] });
    queryClient.invalidateQueries({ queryKey: ["bill-instances"] });
  }

  const createMutation = useMutation({
    mutationFn: async (/** @type {{ effectiveFrom: string, newAmountCents: Cents, note: string | null }} */ data) => {
      const res = await api.bills[":id"]["step-changes"].$post({ param: { id: bill.id }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: async (/** @type {{ id: string, data: { effectiveFrom: string, newAmountCents: Cents, note: string | null } }} */ { id, data }) => {
      const res = await api["bill-step-changes"][":id"].$patch({ param: { id }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["bill-step-changes"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidate,
    onError: (/** @type {Error} */ err) => toast.error(err.message),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-text">Step changes</h4>
        <Button size="sm" variant="outline" onClick={() => setForm({ stepChange: null })}>
          <PlusIcon />
          Add
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        A rent rise in November, a premium that jumps on renewal — a step change replaces the base amount from its date
        forward, and every projected instance after it moves.
      </p>
      {bill.stepChanges.length === 0 ? (
        <p className="text-sm text-text-muted">None — the base amount applies throughout.</p>
      ) : (
        <DataList>
          {bill.stepChanges.map((sc) => (
            <DataListRow
              key={sc.id}
              onClick={() => setForm({ stepChange: sc })}
              primary={<Money value={sc.newAmountCents} />}
              secondary={`from ${formatIsoDate(sc.effectiveFrom, locale)}${sc.note ? ` · ${sc.note}` : ""}`}
            />
          ))}
        </DataList>
      )}
      <StepChangeFormDialog
        open={form !== null}
        onOpenChange={(open) => !open && setForm(null)}
        stepChange={form?.stepChange ?? null}
        submitting={createMutation.isPending || updateMutation.isPending}
        onSubmit={async (data) => {
          if (form?.stepChange) {
            await updateMutation.mutateAsync({ id: form.stepChange.id, data });
          } else {
            await createMutation.mutateAsync(data);
          }
        }}
        onDelete={
          form?.stepChange
            ? () => {
                const stepChange = form.stepChange;
                if (!stepChange) return;
                confirm({
                  title: "Delete this step change?",
                  description: "The bill goes back to its previous amount from this date on, and the contribution moves with it.",
                  confirmLabel: "Delete",
                }).then((ok) => {
                  if (!ok) return;
                  deleteMutation.mutate(stepChange.id);
                  setForm(null);
                });
              }
            : null
        }
      />
    </div>
  );
}

/** @param {{ bill: BillDetail }} props */
function SeasonalFactorEditor({ bill }) {
  const queryClient = useQueryClient();
  const motion = useChartMotion();
  const [factors, setFactors] = useState(() => MONTH_LABELS.map((_, i) => String(bill.seasonalFactors?.[i + 1] ?? 1)));
  const [deriving, setDeriving] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  const factorRows = MONTH_LABELS.map((label, i) => ({
    label: label.slice(0, 3),
    factor: Number(factors[i]) || 0,
  }));

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await api.bills[":id"]["seasonal-factors"].$put({
        param: { id: bill.id },
        json: { factors: factors.map((f) => Number(f) || 0) },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      toast.success("Seasonal factors saved.");
      queryClient.invalidateQueries({ queryKey: ["bill-detail", bill.id] });
      queryClient.invalidateQueries({ queryKey: ["bills"] });
      queryClient.invalidateQueries({ queryKey: ["fixed-costs-summary"] });
      queryClient.invalidateQueries({ queryKey: ["fixed-costs-balance-curve"] });
      queryClient.invalidateQueries({ queryKey: ["bill-instances"] });
    },
    onError: (/** @type {Error} */ err) => toast.error(err.message),
  });

  // Computes each month's mean actual ÷ the overall mean (1.0 for months
  // with no data) and only fills the editor's fields — it never calls the
  // save mutation itself (phases/06-fixed-costs.md "'Derive from history'
  // ... presents them for the operator to accept or edit. It never writes
  // them directly.").
  async function deriveFromHistory() {
    setDeriving(true);
    setError(null);
    try {
      const res = await api.bills[":id"].history.$get({ param: { id: bill.id }, query: { periods: "36" } });
      if (!res.ok) throw new Error(await readApiError(res));
      const { slots } = /** @type {{ slots: { dueDate: string, actualCents: Cents | null }[] }} */ (await res.json());

      /** @type {Cents[][]} */
      const byMonth = Array.from({ length: 12 }, () => []);
      for (const slot of slots) {
        if (slot.actualCents === null) continue;
        const month = Number(slot.dueDate.slice(5, 7));
        byMonth[month - 1]?.push(slot.actualCents);
      }
      const means = byMonth.map((list) => (list.length > 0 ? list.reduce((a, b) => a + b, 0) / list.length : null));
      const withData = means.filter((m) => m !== null);
      if (withData.length === 0) {
        setError("No entered history yet — enter some actuals first.");
        return;
      }
      const overallMean = withData.reduce((a, b) => a + b, 0) / withData.length;
      setFactors(means.map((m) => (m === null ? "1" : (m / overallMean).toFixed(4))));
      toast.success("Factors derived from history — review, then save.");
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    } finally {
      setDeriving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-text">Seasonal factors</h4>
        <Button size="sm" variant="outline" onClick={deriveFromHistory} disabled={deriving}>
          {deriving ? "Deriving…" : "Derive from history"}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        A multiplier per month, applied to the base amount. Deriving from history fills these in for you to accept or
        edit — it never saves on its own.
      </p>
      {/* No table view: the twelve editable month fields directly below
          this bar chart are the same figures, in the same order. */}
      <Chart
        height={120}
        ariaLabel={`Seasonal factor per month for ${bill.name}, shown as bars. The same twelve values are editable below.`}
        config={{ factor: { label: "Factor", color: TOTAL } }}
      >
        <BarChart data={factorRows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" {...AXIS} interval={0} />
          {/* Plain multipliers, not money — the default tooltip is right
              here and `MoneyTooltip` would render "1.2" as "$1.20". */}
          <ChartTooltip content={<ChartTooltipContent hideIndicator />} />
          <Bar dataKey="factor" fill="var(--color-factor)" radius={[4, 4, 0, 0]} {...motion} />
        </BarChart>
      </Chart>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {MONTH_LABELS.map((label, i) => (
          <FieldRow key={label} label={label.slice(0, 3)} htmlFor={`bill-${bill.id}-factor-${i}`}>
            <Input
              id={`bill-${bill.id}-factor-${i}`}
              type="number"
              step="0.01"
              inputMode="decimal"
              value={factors[i]}
              onChange={(e) => setFactors((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
            />
          </FieldRow>
        ))}
      </div>
      {error ? <InlineError>{error}</InlineError> : null}
      <Button size="sm" className="self-start" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
        {saveMutation.isPending ? "Saving…" : "Save factors"}
      </Button>
    </div>
  );
}

/** Which stored instances a `rolling_average` bill is currently averaging —
 * the most recent `rollingWindow` non-null actuals, same selection rule as
 * `computeExpectedCents` (packages/engine/src/bills.js), read here from
 * `recentInstances` rather than recomputed.
 *
 * @param {{ bill: BillDetail }} props
 */
function RollingAveragePreview({ bill }) {
  const { locale } = useSettings();
  const withActuals = bill.recentInstances
    .filter((i) => i.actualCents !== null)
    .sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1));
  const windowSize = bill.rollingWindow ?? 0;
  const used = withActuals.slice(0, windowSize);
  const complete = used.length >= windowSize && windowSize > 0;
  const mean = used.length > 0 ? Math.round(used.reduce((sum, i) => sum + (i.actualCents ?? 0), 0) / used.length) : null;

  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-sm font-semibold text-text">Rolling average — window of {windowSize}</h4>
      <div className="flex flex-col gap-1 rounded-(--radius-card) bg-surface-muted p-4">
        <p className="text-xs text-text-subtle">{complete ? "Budgeted per instance" : "Would be budgeted, once the window fills"}</p>
        <p className="text-lg font-semibold text-text">{mean !== null ? <Money value={mean} /> : "—"}</p>
        <p className="text-xs text-text-muted">
          {complete ? (
            <>
              The average of the {used.length} actuals below. The typed base of <Money value={bill.baseAmountCents} /> is
              only the fallback while there is not enough history.
            </>
          ) : (
            <>
              Only {used.length} of {windowSize} actuals entered, so the projection still uses the base amount of{" "}
              <Money value={bill.baseAmountCents} />. Enter the rest under History.
            </>
          )}
        </p>
      </div>
      {used.length === 0 ? (
        <p className="text-sm text-text-muted">No actuals entered yet.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {used.map((i) => (
            <li key={i.id} className="flex items-center justify-between">
              <span className="text-text-muted">{formatIsoDate(i.dueDate, locale)}</span>
              <Money value={/** @type {Cents} */ (i.actualCents)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A stored row whose date no longer lines up with the bill's current
 * schedule — never auto-deleted (phases/06-fixed-costs.md "Orphaned
 * instances"), but the operator can explicitly discard one here, then
 * re-enter it correctly via History ("realign or delete"). Widens the window
 * well past the balance-curve/summary default so a long-ago anchor change
 * still surfaces its orphans.
 *
 * @param {{ bill: BillDetail }} props
 */
function OrphanedInstancesPanel({ bill }) {
  const { locale } = useSettings();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const orphansQuery = useQuery({
    queryKey: ["bill-instances", "orphans", bill.id],
    queryFn: async () => {
      // Narrowed on the server: this bill, orphans only. Unfiltered, this was
      // every active bill projected across the whole window — tens of
      // thousands of rows parsed on every open, to keep a handful
      // (perf-inp-plan.md, P2 #6).
      const res = await api["bill-instances"].$get({
        query: { from: "2000-01-01", to: "2100-01-01", billId: bill.id, orphansOnly: "true" },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      /** @type {{ instances: { billId: string, dueDate: string, expectedCents: Cents | null, actualCents: Cents | null, id: string | null, isOrphan: boolean }[] }} */
      const { instances } = await res.json();
      return instances;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["bill-instances"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bill-instances"] });
      queryClient.invalidateQueries({ queryKey: ["bills"] });
      queryClient.invalidateQueries({ queryKey: ["fixed-costs-summary"] });
      queryClient.invalidateQueries({ queryKey: ["fixed-costs-balance-curve"] });
      queryClient.invalidateQueries({ queryKey: ["bill-detail", bill.id] });
      toast.success("Orphaned instance deleted.");
    },
    onError: (/** @type {Error} */ err) => toast.error(err.message),
  });

  const orphans = orphansQuery.data ?? [];
  if (orphans.length === 0) return null;

  return (
    <Notice>
      <p>
        {orphans.length} stored instance{orphans.length === 1 ? "" : "s"} no longer line up with this bill's
        schedule — real history, kept, never auto-deleted. Delete one to realign, then re-enter it under History.
      </p>
      {/* Said explicitly because the alternative is a contradiction the
          operator has to work out for themselves: an orphan is still an
          actual, so it still feeds a rolling average, and without this line
          the bill's row can claim to be averaging six actuals while the
          History tab below shows six empty slots. */}
      {bill.amountModel === "rolling_average" ? (
        <p className="mt-1 text-xs">
          These are still averaged into the forecast — an orphan is a real amount this bill really cost. What they are
          not is editable under History, which only offers the dates the current schedule derives.
        </p>
      ) : null}
      <ul className="mt-2 flex flex-col divide-y divide-border">
        {orphans.map((o) => (
          <li key={o.dueDate} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="text-text">
              {formatIsoDate(o.dueDate, locale)} · <Money value={o.actualCents ?? o.expectedCents ?? 0} />
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="text-text-muted hover:text-text"
              disabled={o.id === null}
              onClick={async () => {
                if (!o.id) return;
                const ok = await confirm({
                  title: "Delete this orphaned instance?",
                  description: "It no longer matches its bill's schedule. Deleting it removes it from the contribution and the calendar.",
                  confirmLabel: "Delete",
                });
                if (ok && o.id) deleteMutation.mutate(o.id);
              }}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/**
 * One bill restated at the cadences the household actually budgets in, from
 * the amount the app really budgets rather than the typed base.
 *
 * Built from the bill's own row figures — what the server averaged over the
 * contribution window, the same `restatedFigures` the table row prints. It
 * used to restate `baseAmountCents`, which is only the fallback for a rolling
 * average and the starting point for a seasonal, escalating or stepped bill,
 * so for every one of those the sheet and the row it was opened from
 * disagreed.
 *
 * @param {{ figures: Pick<WindowFigures, "perMonthCents" | "perYearCents">, frequency: Cadence }} props
 */
function CadenceBreakdown({ figures, frequency }) {
  const restated = restatedFigures(figures);
  /** @type {{ cadence: Cadence, cents: Cents }[]} */
  const targets = [
    { cadence: "weekly", cents: restated.weeklyCents },
    { cadence: "monthly", cents: restated.monthlyCents },
    { cadence: "quarterly", cents: restated.quarterlyCents },
    { cadence: "yearly", cents: restated.yearlyCents },
  ];
  return (
    <div className="flex flex-col gap-2 rounded-(--radius-card) bg-surface-muted p-4">
      <h4 className="text-sm font-semibold text-text">Same bill, other cadences</h4>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {targets.map(({ cadence, cents }) => (
          <div key={cadence}>
            <dt className="text-xs text-text-subtle">{CADENCE_LABELS[cadence]}</dt>
            <dd className={cadence === frequency ? "font-semibold text-text" : "font-medium text-text-muted"}>
              <Money value={cents} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The imported due date, called what it is. Changing the date on the Fixed
 * Costs table confirms it on its own; this is for the placeholder that
 * happens to be right.
 *
 * @param {{ bill: BillDetail }} props
 */
function PlaceholderDateNotice({ bill }) {
  const { locale } = useSettings();
  const queryClient = useQueryClient();

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const res = await api.bills[":id"].$patch({ param: { id: bill.id }, json: { dueDateConfirmed: true } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bill-detail", bill.id] });
      queryClient.invalidateQueries({ queryKey: ["bills"] });
      // The dashboard counts placeholder dates in its warnings and setup list.
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Due date confirmed.");
    },
    onError: (/** @type {Error} */ err) => toast.error(err.message),
  });

  return (
    <Notice>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="font-medium">Due {formatIsoDate(bill.anchorDate, locale)} is a placeholder date</p>
          <p className="text-text-muted">
            The import gave every bill the same stand-in date, and the calendar and balance curve are worked out from
            it. Set the real one with Edit on the Fixed Costs table — or, if this one is right, say so.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => confirmMutation.mutate()} disabled={confirmMutation.isPending}>
          <CheckIcon />
          {confirmMutation.isPending ? "Confirming…" : "This date is right"}
        </Button>
      </div>
    </Notice>
  );
}

/**
 * Everything about one bill that a table row has no width for: the history
 * the amount model reads from, the model's own settings, and the step changes
 * that reset its base.
 *
 * Reached by clicking a bill's name on /costs/fixed — one click, not the two
 * menus it used to take, because the row itself is now editable and this
 * modal no longer has to be the way in to renaming a bill.
 *
 * `figures` is the bill's row on the table — the server's figures over the
 * contribution window — so "Same bill, other cadences" restates the amount
 * the row shows rather than the typed base.
 *
 * @param {{
 *   billId: string | null,
 *   figures: WindowFigures | null,
 *   onOpenChange: (open: boolean) => void,
 *   categories: CostCategory[],
 *   people: Person[],
 *   onArchive: (id: string) => void,
 * }} props
 */
export function BillDetailSheet({ billId, figures, onOpenChange, categories, people, onArchive }) {
  const confirm = useConfirm();
  const [tab, setTab] = useState("history");
  // Whether the History tab holds typed amounts that aren't saved. That tab
  // unmounts when another is chosen and the whole sheet unmounts on close,
  // and either one used to drop everything typed without a word.
  const [historyDirty, setHistoryDirty] = useState(false);

  // Every bill opens on History, the tab the sheet is mostly opened for.
  useEffect(() => {
    setTab("history");
    setHistoryDirty(false);
  }, [billId]);

  const detailQuery = useQuery({
    queryKey: ["bill-detail", billId],
    queryFn: async () => {
      if (billId === null) throw new Error("No bill is open.");
      const res = await api.bills[":id"].$get({ param: { id: billId } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {BillDetail} */ ((await res.json()).bill);
    },
    enabled: billId !== null,
  });

  const bill = detailQuery.data ?? null;
  const category = bill ? categories.find((c) => c.id === bill.categoryId) : null;
  const owner = bill?.ownerPersonId ? people.find((p) => p.id === bill.ownerPersonId)?.name : "Shared";
  const spread = bill ? historySpread(bill.history) : null;

  /** Resolves true when it is fine to lose the History tab's typing. */
  async function historyMayGo() {
    if (!historyDirty) return true;
    return confirm({
      title: "Discard the history you've typed?",
      description: "The amounts entered under History haven't been saved yet.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
    });
  }

  /** @param {boolean} open */
  async function handleOpenChange(open) {
    if (open || (await historyMayGo())) onOpenChange(open);
  }

  /** @param {string} next */
  async function handleTabChange(next) {
    if (tab === "history" && next !== "history" && !(await historyMayGo())) return;
    setTab(next);
  }

  return (
    <Sheet open={billId !== null} onOpenChange={handleOpenChange}>
      <SheetContent side="bottom" scrollable className="max-h-[90vh]">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {bill?.name ?? "Bill"}
            {bill && bill.amountModel !== "flat" ? (
              <Badge variant="secondary">{AMOUNT_MODEL_LABELS[bill.amountModel]}</Badge>
            ) : null}
          </SheetTitle>
          <SheetDescription>
            {category?.name ?? ""}
            {bill ? ` · ${owner} · ${CADENCE_LABELS[bill.frequency]}` : ""}
          </SheetDescription>
        </SheetHeader>
        {bill ? (
          <div className="flex flex-col gap-6 px-4 pb-6">
            {bill.notes ? <p className="text-sm text-text-muted">{bill.notes}</p> : null}

            {spread ? (
              <div className="flex flex-col gap-1 rounded-(--radius-card) bg-surface-muted p-4">
                <p className="text-xs text-text-subtle">What it has actually cost</p>
                <p className="text-sm text-text">
                  {spread.count} entered actual{spread.count === 1 ? "" : "s"} · <Money value={spread.minCents} /> –{" "}
                  <Money value={spread.maxCents} /> · mean <Money value={spread.meanCents} />
                </p>
                {bill.amountModel === "flat" ? (
                  <p className="text-xs text-text-muted">
                    This bill is set to a flat amount, so none of that spread reaches the budget. Switch its model to
                    Rolling average or Seasonal on the Fixed Costs table to have it.
                  </p>
                ) : null}
              </div>
            ) : null}

            {bill.dueDateConfirmed ? null : <PlaceholderDateNotice bill={bill} />}

            <OrphanedInstancesPanel bill={bill} />

            <Tabs value={tab} onValueChange={handleTabChange}>
              <TabsList>
                <TabsTrigger value="history">History</TabsTrigger>
                <TabsTrigger value="model">Amount model</TabsTrigger>
                <TabsTrigger value="steps">Step changes</TabsTrigger>
              </TabsList>
              <TabsContent value="history" className="pt-4">
                <BillHistoryEntry billId={bill.id} onDirtyChange={setHistoryDirty} />
              </TabsContent>
              <TabsContent value="model" className="flex flex-col gap-6 pt-4">
                {figures ? <CadenceBreakdown figures={figures} frequency={bill.frequency} /> : null}
                {bill.amountModel === "seasonal" ? <SeasonalFactorEditor bill={bill} /> : null}
                {bill.amountModel === "rolling_average" ? <RollingAveragePreview bill={bill} /> : null}
                {bill.amountModel === "escalating" ? (
                  <p className="text-sm text-text-muted">
                    Rises {bill.escalationPct ?? 0}% a year, compounding from {formatIsoDate(bill.anchorDate, "en-AU")}.
                  </p>
                ) : null}
                {bill.amountModel === "flat" ? (
                  <p className="text-sm text-text-muted">
                    The same amount every time. Change the model in the Fixed Costs table to have this bill follow its
                    own history, its season, or a yearly rise.
                  </p>
                ) : null}
              </TabsContent>
              <TabsContent value="steps" className="pt-4">
                <StepChangesPanel bill={bill} />
              </TabsContent>
            </Tabs>

            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <Button variant="ghost" className="text-text-muted hover:text-text" onClick={() => onArchive(bill.id)}>
                <Trash2Icon />
                Archive bill
              </Button>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
