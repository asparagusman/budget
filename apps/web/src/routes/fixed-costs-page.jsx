import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { addDaysIso, annualise, projectInstances, toCents } from "@budget/engine";
import {
  AlertTriangleIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PencilIcon,
  PlusIcon,
  ReceiptIcon,
  TagIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.jsx";
import { Textarea } from "@/components/ui/textarea.jsx";
import { Chart } from "@/components/chart.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { Money } from "@/components/money.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { StatTile } from "@/components/stat-tile.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { AMOUNT_MODEL_LABELS, AMOUNT_MODELS, CADENCES, CADENCE_LABELS, MONTH_LABELS } from "@/lib/constants.js";
import { formatIsoDate, todayIso } from "@/lib/dates.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";

/** @import { AmountModel, Cadence, Cents } from "@budget/engine" */
/** @typedef {{ id: string, name: string }} Person */
/** @typedef {{ id: string, name: string, type: string, isIncomeLanding: boolean }} Account */
/** @typedef {{ id: string, name: string, kind: "fixed" | "variable", isEssential: boolean, colour: string | null, sortOrder: number }} CostCategory */
/** @typedef {{ id: string, billId: string, effectiveFrom: string, newAmountCents: Cents, note: string | null }} StepChange */
/** @typedef {{
 *   id: string, categoryId: string, name: string, ownerPersonId: string | null, paidFromAccountId: string | null,
 *   baseAmountCents: Cents, frequency: Cadence, anchorDate: string, amountModel: AmountModel,
 *   escalationPct: number | null, rollingWindow: number | null, notes: string | null, sortOrder: number,
 *   seasonalFactors: Record<string, number>, stepChanges: StepChange[]
 * }} Bill */
/** @typedef {{ id: string, billId: string, dueDate: string, expectedCents: Cents | null, actualCents: Cents | null, isOverride: boolean, paidOn: string | null, note: string | null }} RecentInstance */
/** @typedef {Bill & { recentInstances: RecentInstance[] }} BillDetail */
/** @typedef {{ categoryId: string, name: string, perYearCents: Cents, perMonthCents: Cents, perPayCents: Cents | null, billCount: number }} CategorySummary */
/** @typedef {{ window: { from: string, to: string }, contribution: { perPayCents: Cents | null, perMonthCents: Cents, perYearCents: Cents }, byCategory: CategorySummary[], billCount: number, warnings: { code: string, message: string, billId?: string }[] }} FixedCostsSummary */
/** @typedef {{ categoryId: string, name: string, ownerPersonId: string | null, paidFromAccountId: string | null, baseAmountCents: Cents, frequency: Cadence, anchorDate: string, amountModel: AmountModel, escalationPct: number | null, rollingWindow: number | null, notes: string | null }} BillFormData */

/** @param {number} months */
function windowFromToday(months) {
  const from = todayIso();
  return { from, to: addDaysIso(from, Math.round(months * 30.4375)) };
}

/**
 * Bill row -> the engine's pure `Bill` shape, for the list-row display math
 * that runs client-side (see the module comment below on why).
 *
 * @param {Bill} bill
 */
function toEngineBillClient(bill) {
  return {
    id: bill.id,
    baseAmountCents: bill.baseAmountCents,
    frequency: bill.frequency,
    anchorDate: bill.anchorDate,
    amountModel: bill.amountModel,
    escalationPct: bill.escalationPct ?? undefined,
    rollingWindow: bill.rollingWindow ?? undefined,
    seasonalFactors: bill.seasonalFactors,
    stepChanges: bill.stepChanges.map((s) => ({ effectiveFrom: s.effectiveFrom, newAmountCents: s.newAmountCents })),
  };
}

/**
 * The list row's "amount + cadence" and "next due date" columns, computed
 * client-side via @budget/engine's pure `projectInstances` — the same
 * "compute locally from data already on the page" pattern as settings-
 * page.jsx's pay-schedule preview, rather than a server round trip for a
 * non-headline display figure. Run with no history, so a `rolling_average`
 * bill shows its step-adjusted base here; the history-aware figure is what
 * the bill's own detail view (which loads real history) shows.
 *
 * @param {Bill} bill
 * @param {string} today
 */
function nextDueAndAmount(bill, today) {
  try {
    const engineBill = toEngineBillClient(bill);
    const [next] = projectInstances(engineBill, { from: today, to: addDaysIso(today, 400) }, []);
    return next ? { nextDueDate: next.dueDate, currentAmountCents: next.expectedCents } : { nextDueDate: null, currentAmountCents: bill.baseAmountCents };
  } catch {
    return { nextDueDate: null, currentAmountCents: bill.baseAmountCents };
  }
}

/** @param {Person[]} people @param {string | null} personId */
function personName(people, personId) {
  if (personId === null) return "Shared";
  return people.find((p) => p.id === personId)?.name ?? "Unknown person";
}

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
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: cat.id, name: cat.name })}>
                        Rename
                      </Button>
                      <Button size="sm" variant="ghost" className="text-negative" onClick={() => onArchive(cat.id)}>
                        Archive
                      </Button>
                    </div>
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
 * @param {{
 *   open: boolean, onOpenChange: (open: boolean) => void, bill: Bill | null, categories: CostCategory[],
 *   people: Person[], accounts: Account[], submitting: boolean, onSubmit: (data: BillFormData) => Promise<void>,
 * }} props
 */
function BillFormDialog({ open, onOpenChange, bill, categories, people, accounts, submitting, onSubmit }) {
  const incomeLandingId = accounts.find((a) => a.isIncomeLanding)?.id ?? "";
  const [categoryId, setCategoryId] = useState("");
  const [name, setName] = useState("");
  const [ownerPersonId, setOwnerPersonId] = useState(/** @type {string} */ (""));
  const [paidFromAccountId, setPaidFromAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState(/** @type {Cadence} */ ("monthly"));
  const [anchorDate, setAnchorDate] = useState(todayIso());
  const [amountModel, setAmountModel] = useState(/** @type {AmountModel} */ ("flat"));
  const [escalationPct, setEscalationPct] = useState("");
  const [rollingWindow, setRollingWindow] = useState("3");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setCategoryId(bill?.categoryId ?? categories[0]?.id ?? "");
    setName(bill?.name ?? "");
    setOwnerPersonId(bill?.ownerPersonId ?? "");
    setPaidFromAccountId(bill?.paidFromAccountId ?? incomeLandingId);
    setAmount(bill ? String(bill.baseAmountCents / 100) : "");
    setFrequency(bill?.frequency ?? "monthly");
    setAnchorDate(bill?.anchorDate ?? todayIso());
    setAmountModel(bill?.amountModel ?? "flat");
    setEscalationPct(bill?.escalationPct != null ? String(bill.escalationPct) : "");
    setRollingWindow(bill?.rollingWindow != null ? String(bill.rollingWindow) : "3");
    setNotes(bill?.notes ?? "");
    setError(null);
    // Deliberately excludes `incomeLandingId`/`categories`: re-running this
    // whenever the accounts/categories lists refetch would blow away
    // whatever the operator has already picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bill]);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!categoryId) {
      setError("Choose a category.");
      return;
    }
    if (!name.trim()) {
      setError("Enter a name.");
      return;
    }
    if (amount.trim() === "") {
      setError("Enter an amount.");
      return;
    }
    if (amountModel === "escalating" && escalationPct.trim() === "") {
      setError("Escalating bills need an escalation percentage.");
      return;
    }
    if (amountModel === "rolling_average" && rollingWindow.trim() === "") {
      setError("Rolling-average bills need a window size.");
      return;
    }
    try {
      await onSubmit({
        categoryId,
        name: name.trim(),
        ownerPersonId: ownerPersonId || null,
        paidFromAccountId: paidFromAccountId || null,
        baseAmountCents: toCents(Number(amount)),
        frequency,
        anchorDate,
        amountModel,
        escalationPct: amountModel === "escalating" ? Number(escalationPct) : null,
        rollingWindow: amountModel === "rolling_average" ? Number(rollingWindow) : null,
        notes: notes.trim() || null,
      });
      onOpenChange(false);
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bill ? "Edit bill" : "Add bill"}</DialogTitle>
          <DialogDescription>A recurring cost that behaves like the real bill, not a flat spreadsheet row.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
          <FieldRow label="Category" htmlFor="bill-category" required>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger id="bill-category" className="w-full">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Name" htmlFor="bill-name" required>
            <Input id="bill-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </FieldRow>
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Owner" htmlFor="bill-owner" hint="Optional.">
              <Select value={ownerPersonId || "shared"} onValueChange={(v) => setOwnerPersonId(v === "shared" ? "" : v)}>
                <SelectTrigger id="bill-owner" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shared">Shared</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
            <FieldRow label="Paid from" htmlFor="bill-account">
              <Select value={paidFromAccountId || "none"} onValueChange={(v) => setPaidFromAccountId(v === "none" ? "" : v)}>
                <SelectTrigger id="bill-account" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not set</SelectItem>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Amount" htmlFor="bill-amount" required>
              <InputGroup>
                <InputGroupAddon>
                  <InputGroupText>$</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput id="bill-amount" type="number" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </InputGroup>
            </FieldRow>
            <FieldRow label="Cadence" htmlFor="bill-frequency">
              <Select value={frequency} onValueChange={(v) => setFrequency(/** @type {Cadence} */ (v))}>
                <SelectTrigger id="bill-frequency" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CADENCES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {CADENCE_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          </div>
          <FieldRow label="Anchor date" htmlFor="bill-anchor" hint="A known due date — the series is derived from it.">
            <Input id="bill-anchor" type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} />
          </FieldRow>
          <FieldRow label="Amount model" htmlFor="bill-model" hint="How this bill's amount actually behaves.">
            <Select value={amountModel} onValueChange={(v) => setAmountModel(/** @type {AmountModel} */ (v))}>
              <SelectTrigger id="bill-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AMOUNT_MODELS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {AMOUNT_MODEL_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          {amountModel === "escalating" ? (
            <FieldRow label="Escalation" htmlFor="bill-escalation" required hint="Percent per year, compounding from the anchor date.">
              <InputGroup>
                <InputGroupInput id="bill-escalation" type="number" step="0.1" inputMode="decimal" value={escalationPct} onChange={(e) => setEscalationPct(e.target.value)} />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>% p.a.</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </FieldRow>
          ) : null}
          {amountModel === "rolling_average" ? (
            <FieldRow label="Window" htmlFor="bill-window" required hint="How many past actuals to average.">
              <Input id="bill-window" type="number" step="1" min="1" inputMode="numeric" value={rollingWindow} onChange={(e) => setRollingWindow(e.target.value)} />
            </FieldRow>
          ) : null}
          {amountModel === "seasonal" ? (
            <p className="text-xs text-text-muted">Set the 12 monthly factors from the bill's own detail view after saving.</p>
          ) : null}
          <FieldRow label="Notes" htmlFor="bill-notes" hint="Optional.">
            <Textarea id="bill-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </FieldRow>
          {error ? <p className="text-sm text-negative">{error}</p> : null}
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
            <Input id="step-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
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
          {error ? <p className="text-sm text-negative">{error}</p> : null}
          <DialogFooter className={onDelete ? "sm:justify-between!" : undefined}>
            {onDelete ? (
              <Button type="button" variant="ghost" className="text-negative" onClick={onDelete}>
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
  const queryClient = useQueryClient();
  const [form, setForm] = useState(/** @type {{ stepChange: StepChange | null } | null} */ (null));

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["bill-detail", bill.id] });
    queryClient.invalidateQueries({ queryKey: ["bills"] });
    queryClient.invalidateQueries({ queryKey: ["fixed-costs-summary"] });
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
    onError: (err) => toast.error(err.message),
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
                if (form.stepChange) deleteMutation.mutate(form.stepChange.id);
                setForm(null);
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
  const [factors, setFactors] = useState(() => MONTH_LABELS.map((_, i) => String(bill.seasonalFactors?.[i + 1] ?? 1)));
  const [deriving, setDeriving] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

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
    },
    onError: (err) => toast.error(err.message),
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
    <div className="flex flex-col gap-3 rounded-(--radius-card) bg-surface-muted p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-text">Seasonal factors</h4>
        <Button size="sm" variant="outline" onClick={deriveFromHistory} disabled={deriving}>
          {deriving ? "Deriving…" : "Derive from history"}
        </Button>
      </div>
      {/* No table view: the twelve editable month fields directly below
          this bar chart are the same figures, in the same order. */}
      <Chart
        height={120}
        ariaLabel={`Seasonal factor per month for ${bill.name}, shown as bars. The same twelve values are editable below.`}
        option={(tokens) => ({
          xAxis: { type: "category", data: MONTH_LABELS.map((m) => m.slice(0, 3)) },
          yAxis: { type: "value" },
          series: [{ type: "bar", data: factors.map((f) => Number(f) || 0), itemStyle: { color: tokens.series[0], borderRadius: [4, 4, 0, 0] } }],
        })}
      />
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
      {error ? <p className="text-sm text-negative">{error}</p> : null}
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

  return (
    <div className="flex flex-col gap-2 rounded-(--radius-card) bg-surface-muted p-4">
      <h4 className="text-sm font-semibold text-text">Rolling average — window of {windowSize}</h4>
      {used.length < windowSize ? (
        <p className="text-xs text-text-muted">
          Only {used.length} of {windowSize} needed actuals entered — falling back to the step-adjusted base until there's enough history.
        </p>
      ) : null}
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
 * re-enter it correctly via "Enter bill history" ("realign or delete").
 * Widens the window well past the balance-curve/summary default so a
 * long-ago anchor change still surfaces its orphans.
 *
 * @param {{ bill: BillDetail }} props
 */
function OrphanedInstancesPanel({ bill }) {
  const { locale } = useSettings();
  const queryClient = useQueryClient();

  const orphansQuery = useQuery({
    queryKey: ["bill-instances", "orphans", bill.id],
    queryFn: async () => {
      const res = await api["bill-instances"].$get({ query: { from: "2000-01-01", to: "2100-01-01" } });
      if (!res.ok) throw new Error(await readApiError(res));
      /** @type {{ instances: { billId: string, dueDate: string, expectedCents: Cents | null, actualCents: Cents | null, id: string | null, isOrphan: boolean }[] }} */
      const { instances } = await res.json();
      return instances.filter((i) => i.billId === bill.id && i.isOrphan);
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
      toast.success("Orphaned instance deleted.");
    },
    onError: (err) => toast.error(err.message),
  });

  const orphans = orphansQuery.data ?? [];
  if (orphans.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 rounded-(--radius-card) bg-negative-soft p-4">
      <div className="flex items-start gap-2 text-sm text-negative">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          {orphans.length} stored instance{orphans.length === 1 ? "" : "s"} no longer line up with this bill's schedule — real history,
          kept, never auto-deleted. Delete one to realign, then re-enter it via "Enter bill history".
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-border">
        {orphans.map((o) => (
          <li key={o.dueDate} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="text-text">
              {formatIsoDate(o.dueDate, locale)} · <Money value={o.actualCents ?? o.expectedCents ?? 0} />
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="text-negative"
              disabled={o.id === null}
              onClick={() => o.id && deleteMutation.mutate(o.id)}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * @param {{
 *   billId: string | null, onOpenChange: (open: boolean) => void, categories: CostCategory[], people: Person[],
 *   onEdit: (bill: Bill) => void, onArchive: (id: string) => void, onEnterHistory: (billId: string) => void,
 * }} props
 */
function BillDetailSheet({ billId, onOpenChange, categories, people, onEdit, onArchive, onEnterHistory }) {
  const detailQuery = useQuery({
    queryKey: ["bill-detail", billId],
    queryFn: async () => {
      const res = await api.bills[":id"].$get({ param: { id: /** @type {string} */ (billId) } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {BillDetail} */ ((await res.json()).bill);
    },
    enabled: billId !== null,
  });

  const bill = detailQuery.data ?? null;
  const category = bill ? categories.find((c) => c.id === bill.categoryId) : null;

  return (
    <Sheet open={billId !== null} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{bill?.name ?? "Bill"}</SheetTitle>
          <SheetDescription>{category?.name ?? ""}</SheetDescription>
        </SheetHeader>
        {bill ? (
          <div className="flex flex-col gap-6 px-4 pb-6">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <div>
                <p className="text-xs text-text-subtle">Amount</p>
                <p className="font-medium text-text">
                  <Money value={bill.baseAmountCents} /> · {CADENCE_LABELS[bill.frequency]}
                </p>
              </div>
              <div>
                <p className="text-xs text-text-subtle">Owner</p>
                <p className="font-medium text-text">{personName(people, bill.ownerPersonId)}</p>
              </div>
              <div>
                <p className="text-xs text-text-subtle">Model</p>
                <p className="font-medium text-text">{AMOUNT_MODEL_LABELS[bill.amountModel]}</p>
              </div>
            </div>
            {bill.notes ? <p className="text-sm text-text-muted">{bill.notes}</p> : null}

            <OrphanedInstancesPanel bill={bill} />

            {bill.amountModel === "seasonal" ? <SeasonalFactorEditor bill={bill} /> : null}
            {bill.amountModel === "rolling_average" ? <RollingAveragePreview bill={bill} /> : null}

            <StepChangesPanel bill={bill} />

            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <Button onClick={() => onEnterHistory(bill.id)}>
                <CalendarClockIcon />
                Enter bill history
              </Button>
              <Button variant="outline" onClick={() => onEdit(bill)}>
                <PencilIcon />
                Edit bill
              </Button>
              <Button variant="ghost" className="text-negative" onClick={() => onArchive(bill.id)}>
                <Trash2Icon />
                Archive
              </Button>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * @param {{
 *   category: CostCategory, bills: Bill[], summary: CategorySummary | undefined, people: Person[],
 *   payCadenceLabel: string | null, today: string, onOpenBill: (id: string) => void,
 * }} props
 */
function CategoryGroupDesktop({ category, bills, summary, people, payCadenceLabel, today, onOpenBill }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-semibold text-text-muted">{category.name}</h3>
        {summary ? (
          <div className="flex items-center gap-4 text-xs text-text-muted">
            <span>
              {summary.billCount} bill{summary.billCount === 1 ? "" : "s"}
            </span>
            {summary.perPayCents != null ? (
              <span>
                Per pay{payCadenceLabel ? ` (${payCadenceLabel})` : ""}: <Money value={summary.perPayCents} className="font-medium text-text" />
              </span>
            ) : null}
            <span>
              Per month: <Money value={summary.perMonthCents} className="font-medium text-text" />
            </span>
            <span>
              Per year: <Money value={summary.perYearCents} className="font-medium text-text" />
            </span>
          </div>
        ) : null}
      </div>
      <div className="overflow-x-auto rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-text-muted">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Owner</th>
              <th className="px-4 py-3 font-medium">Amount</th>
              <th className="px-4 py-3 font-medium">Next due</th>
              <th className="px-4 py-3 font-medium">Annual</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {bills.map((bill) => {
              const { nextDueDate, currentAmountCents } = nextDueAndAmount(bill, today);
              return (
                <tr key={bill.id}>
                  <td className="px-4 py-3 text-text">
                    <button type="button" className="text-left hover:underline" onClick={() => onOpenBill(bill.id)}>
                      {bill.name}
                    </button>
                    {bill.amountModel !== "flat" ? (
                      <Badge variant="secondary" className="ml-2">
                        {AMOUNT_MODEL_LABELS[bill.amountModel]}
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-text-muted">{personName(people, bill.ownerPersonId)}</td>
                  <td className="px-4 py-3 text-text">
                    <Money value={currentAmountCents} /> <span className="text-text-subtle">/{CADENCE_LABELS[bill.frequency].toLowerCase()}</span>
                  </td>
                  <td className="px-4 py-3 text-text-muted">{nextDueDate ? formatIsoDate(nextDueDate, "en-AU") : "—"}</td>
                  <td className="px-4 py-3 text-text-muted">
                    <Money value={annualise(currentAmountCents, bill.frequency)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * @param {{ category: CostCategory, bills: Bill[], summary: CategorySummary | undefined, today: string, onOpenBill: (id: string) => void }} props
 */
function CategoryGroupMobile({ category, bills, summary, today, onOpenBill }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        data-touch-target
        aria-expanded={open}
        className="flex items-center justify-between gap-2 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-1 text-sm font-semibold text-text-muted">
          {open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
          {category.name}
        </span>
        {summary ? (
          <span className="text-xs text-text-muted">
            <Money value={summary.perMonthCents} className="font-medium text-text" />
            /mo
          </span>
        ) : null}
      </button>
      {open ? (
        <DataList>
          {bills.map((bill) => {
            const { nextDueDate, currentAmountCents } = nextDueAndAmount(bill, today);
            return (
              <DataListRow
                key={bill.id}
                onClick={() => onOpenBill(bill.id)}
                primary={
                  <span className="flex items-center gap-2">
                    {bill.name}
                    {bill.amountModel !== "flat" ? <Badge variant="secondary">{AMOUNT_MODEL_LABELS[bill.amountModel]}</Badge> : null}
                  </span>
                }
                secondary={`${CADENCE_LABELS[bill.frequency]}${nextDueDate ? ` · next ${formatIsoDate(nextDueDate, "en-AU")}` : ""}`}
                trailing={<Money value={currentAmountCents} />}
              />
            );
          })}
        </DataList>
      ) : null}
    </div>
  );
}

/** @param {{ date: string, balanceCents: Cents, event: "payday" | "bill" }[]} points */
function balanceCurveOption(points) {
  return (/** @type {import("@/components/chart.jsx").ChartTokens} */ tokens) => ({
    xAxis: { type: "category", data: points.map((p) => p.date) },
    yAxis: { type: "value" },
    series: [
      {
        type: "line",
        name: "Balance",
        data: points.map((p) => p.balanceCents / 100),
        smooth: true,
        showSymbol: false,
        lineStyle: { color: tokens.series[0], width: 2 },
        areaStyle: { color: tokens.accentSoft },
      },
      {
        type: "scatter",
        name: "Bill due",
        data: points.map((p) => (p.event === "bill" ? p.balanceCents / 100 : null)),
        symbolSize: 8,
        itemStyle: { color: tokens.series[3] },
      },
    ],
  });
}

/**
 * Insight only, visibly separate from the contribution figure and unable to
 * alter it (phases/06-fixed-costs.md "What this phase must not do") —
 * collapsed by default, and its query only runs once expanded.
 *
 * @param {{ window: { from: string, to: string } }} props
 */
function BalanceCurvePanel({ window }) {
  const { currency, locale } = useSettings();
  const [open, setOpen] = useState(false);
  const [openingDollars, setOpeningDollars] = useState("0");

  const curveQuery = useQuery({
    queryKey: ["fixed-costs-balance-curve", window.from, window.to, openingDollars],
    queryFn: async () => {
      const res = await api["fixed-costs"]["balance-curve"].$get({
        query: { from: window.from, to: window.to, opening: String(toCents(Number(openingDollars) || 0)) },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {{ points: { date: string, balanceCents: Cents, event: "payday" | "bill" }[], requiredOpeningBalanceCents: Cents }} */ (
        await res.json()
      );
    },
    enabled: open,
  });

  const points = curveQuery.data?.points ?? [];
  const lowest = points.reduce(
    /** @param {typeof points[number] | null} min */ (min, p) => (min === null || p.balanceCents < min.balanceCents ? p : min),
    null,
  );

  return (
    <div className="rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
      <button type="button" className="flex w-full items-center justify-between gap-2 p-5 text-left" onClick={() => setOpen((o) => !o)}>
        <div>
          <h3 className="font-semibold text-text">Balance curve</h3>
          <p className="text-xs text-text-muted">Insight only — never changes the contribution above.</p>
        </div>
        {open ? <ChevronDownIcon className="size-5 text-text-muted" /> : <ChevronRightIcon className="size-5 text-text-muted" />}
      </button>
      {open ? (
        <div className="flex flex-col gap-4 border-t border-border p-5">
          <FieldRow label="Starting balance" htmlFor="curve-opening" className="max-w-40">
            <InputGroup>
              <InputGroupAddon>
                <InputGroupText>$</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput id="curve-opening" type="number" step="0.01" inputMode="decimal" value={openingDollars} onChange={(e) => setOpeningDollars(e.target.value)} />
            </InputGroup>
          </FieldRow>
          <Chart
            loading={curveQuery.isLoading}
            empty={points.length === 0}
            emptyTitle="No projection yet"
            height={260}
            ariaLabel={
              lowest
                ? `Projected bills-account balance across ${points.length} events, dipping lowest on ${formatIsoDate(lowest.date, locale)} at ${formatMoney(lowest.balanceCents, { currency, locale })}.`
                : "Projected bills-account balance over time."
            }
            dataTable={{
              caption: "Projected balance after each payday and bill",
              columns: ["Date", "Event", "Balance"],
              rows: points.map((point) => [
                formatIsoDate(point.date, locale),
                point.event === "bill" ? "Bill due" : "Payday",
                formatMoney(point.balanceCents, { currency, locale }),
              ]),
            }}
            option={balanceCurveOption(points)}
          />
          {curveQuery.data && lowest ? (
            <p className="text-sm text-text-muted">
              At this contribution the account dips lowest on {formatIsoDate(lowest.date, locale)}, reaching{" "}
              <Money value={lowest.balanceCents} className="font-medium text-text" />. An opening balance of{" "}
              <Money value={curveQuery.data.requiredOpeningBalanceCents} className="font-medium text-text" /> keeps it above your buffer.
            </p>
          ) : null}
          {curveQuery.error ? <p className="text-sm text-negative">{/** @type {Error} */ (curveQuery.error).message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Bills that know how they actually behave — seasonal, escalating, rolling-
 * average — instead of a flat spreadsheet row, plus the calendar and balance
 * curve that come from projecting them. The average stays the answer; the
 * simulation is insight only (phases/06-fixed-costs.md "Objective").
 */
export function FixedCostsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const window = useMemo(() => windowFromToday(12), []);
  const today = useMemo(todayIso, []);

  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [billForm, setBillForm] = useState(/** @type {{ bill: Bill | null } | null} */ (null));
  const [detailBillId, setDetailBillId] = useState(/** @type {string | null} */ (null));

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
    queryKey: ["fixed-costs-summary", window.from, window.to],
    queryFn: async () => {
      const res = await api["fixed-costs"].summary.$get({ query: window });
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

  function invalidateBills() {
    queryClient.invalidateQueries({ queryKey: ["bills"] });
    queryClient.invalidateQueries({ queryKey: ["fixed-costs-summary"] });
    queryClient.invalidateQueries({ queryKey: ["bill-instances"] });
  }

  const createCategory = useMutation({
    mutationFn: async (/** @type {string} */ name) => {
      const res = await api["cost-categories"].$post({ json: { name, kind: "fixed" } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cost-categories", "fixed"] }),
    onError: (err) => toast.error(err.message),
  });

  const renameCategory = useMutation({
    mutationFn: async (/** @type {{ id: string, name: string }} */ { id, name }) => {
      const res = await api["cost-categories"][":id"].$patch({ param: { id }, json: { name } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cost-categories", "fixed"] }),
    onError: (err) => toast.error(err.message),
  });

  const archiveCategory = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["cost-categories"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cost-categories", "fixed"] }),
    onError: (err) => toast.error(err.message),
  });

  const createBill = useMutation({
    mutationFn: async (/** @type {BillFormData} */ data) => {
      const res = await api.bills.$post({ json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateBills();
      toast.success("Bill added.");
    },
  });

  const updateBill = useMutation({
    mutationFn: async (/** @type {{ id: string, data: BillFormData }} */ { id, data }) => {
      const res = await api.bills[":id"].$patch({ param: { id }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateBills();
      toast.success("Bill updated.");
    },
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
      setDetailBillId(null);
    },
    onError: (err) => toast.error(err.message),
  });

  useEffect(
    () =>
      registerCommands([
        {
          id: "fixed-costs:add-bill",
          group: "Actions",
          label: "Add bill",
          icon: PlusIcon,
          run: () => {
            setBillForm({ bill: null });
          },
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
            if (bills[0]) navigate({ to: "/costs/fixed/$billId/history", params: { billId: bills[0].id } });
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
    [bills, navigate],
  );

  const isLoading = categoriesQuery.isLoading || billsQuery.isLoading;

  return (
    <>
      <PageHeader
        title="Fixed Costs"
        description="Bills that know how they actually behave — seasonal, escalating, rolling-average — not just an amount times a frequency."
        actions={
          <>
            <Button variant="outline" onClick={() => setCategoryManagerOpen(true)}>
              <TagIcon />
              Categories
            </Button>
            <Button onClick={() => setBillForm({ bill: null })} disabled={categories.length === 0}>
              <PlusIcon />
              Add bill
            </Button>
          </>
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
            value={summary.contribution.perPayCents != null ? <Money value={summary.contribution.perPayCents} /> : <Money value={summary.contribution.perMonthCents} />}
            sparkline={
              <p className="text-xs text-text-muted">
                <Money value={summary.contribution.perMonthCents} /> / month · <Money value={summary.contribution.perYearCents} /> / year
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

      {!isLoading && categories.length > 0 && bills.length === 0 ? (
        <EmptyState
          icon={ReceiptIcon}
          title="No bills yet"
          description="Add every recurring cost the household actually pays — electricity, rent, insurance, subscriptions."
          action={
            <Button onClick={() => setBillForm({ bill: null })}>
              <PlusIcon />
              Add bill
            </Button>
          }
        />
      ) : (
        categories
          .filter((cat) => bills.some((b) => b.categoryId === cat.id))
          .map((cat) => {
            const categoryBills = bills.filter((b) => b.categoryId === cat.id);
            const categorySummary = summary?.byCategory.find((c) => c.categoryId === cat.id);
            return (
              <div key={cat.id}>
                <div className="hidden md:block">
                  <CategoryGroupDesktop category={cat} bills={categoryBills} summary={categorySummary} people={people} payCadenceLabel={payCadenceLabel} today={today} onOpenBill={setDetailBillId} />
                </div>
                <div className="md:hidden">
                  <CategoryGroupMobile category={cat} bills={categoryBills} summary={categorySummary} today={today} onOpenBill={setDetailBillId} />
                </div>
              </div>
            );
          })
      )}

      <BalanceCurvePanel window={window} />

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

      <BillFormDialog
        open={billForm !== null}
        onOpenChange={(open) => !open && setBillForm(null)}
        bill={billForm?.bill ?? null}
        categories={categories}
        people={people}
        accounts={accounts}
        submitting={createBill.isPending || updateBill.isPending}
        onSubmit={async (data) => {
          if (billForm?.bill) {
            await updateBill.mutateAsync({ id: billForm.bill.id, data });
          } else {
            await createBill.mutateAsync(data);
          }
        }}
      />

      <BillDetailSheet
        billId={detailBillId}
        onOpenChange={(open) => !open && setDetailBillId(null)}
        categories={categories}
        people={people}
        onEdit={(bill) => {
          setDetailBillId(null);
          setBillForm({ bill });
        }}
        onArchive={(id) => archiveBill.mutate(id)}
        onEnterHistory={(billId) => navigate({ to: "/costs/fixed/$billId/history", params: { billId } })}
      />
    </>
  );
}
