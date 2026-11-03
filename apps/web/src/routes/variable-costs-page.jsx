import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { equivalent, resolveVariableBudget, toCents } from "@budget/engine";
import {
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  ShoppingBagIcon,
  SparklesIcon,
  TagIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.jsx";
import { Input } from "@/components/ui/input.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.jsx";
import { Switch } from "@/components/ui/switch.jsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.jsx";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import {
  AXIS,
  Chart,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  MoneyTooltip,
  SERIES,
  TOTAL,
  useChartMotion,
  useMoneyTick,
} from "@/components/chart.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { DatePicker } from "@/components/date-picker.jsx";
import { Delta } from "@/components/delta.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { PanelSkeleton, SectionsSkeleton, StatsSkeleton } from "@/components/loading.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { IntegerInput, MoneyInput } from "@/components/money-input.jsx";
import { Money } from "@/components/money.jsx";
import { InlineError, Notice, NoticeList } from "@/components/notice.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { PageSection } from "@/components/page-section.jsx";
import { QueryError } from "@/components/query-error.jsx";
import { Stat, StatGroup } from "@/components/stat-tile.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { cellText, centsText, changedCells, forgetSentEdits, parseCents } from "@/lib/cell-edits.js";
import { registerCommands } from "@/lib/commands.js";
import { CADENCES, CADENCE_LABELS } from "@/lib/constants.js";
import { formatIsoDate, todayIso } from "@/lib/dates.js";
import { colorFor, entityColors } from "@/lib/entity-colors.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard.js";
import { ScrollArea } from "@/components/scroll-area.jsx";
import {
  costCategoriesQueryOptions,
  paySchedulesQueryOptions,
  variableBudgetsQueryOptions,
  variableCostsCyclesQueryOptions,
  variableCostsSummaryQueryOptions,
} from "@/lib/queries.js";

/** @import { Cadence, Cents } from "@budget/engine" */
/** @import { CellEdits } from "@/lib/cell-edits.js" */
/** @typedef {{ id: string, name: string, kind: "fixed" | "variable", isEssential: boolean, colour: string | null, sortOrder: number }} CostCategory */
/** @typedef {{ id: string, categoryId: string, amountCents: Cents, cadence: Cadence, effectiveFrom: string, note: string | null }} VariableBudget */
/** @typedef {{ categoryId: string, name: string, isEssential: boolean, budgetPerMonthCents: Cents, trailingAveragePerMonthCents: Cents | null, varianceCents: Cents | null, cyclesRecorded: number }} CategorySummary */
/** @typedef {{ essentialPerMonthCents: Cents, nonEssentialPerMonthCents: Cents, byCategory: CategorySummary[], warnings: { code: string, message: string, categoryId?: string }[] }} VariableCostsSummary */
/** @typedef {{ categoryId: string, name: string, isEssential: boolean, amountCents: Cents | null }} CycleEntry */
/** @typedef {{ ordinal: number, label: string, cycleStart: string, cycleEnd: string, entries: CycleEntry[] }} Cycle */

const LOOKBACK_OPTIONS = /** @type {const} */ (["6", "12", "24", "custom"]);

// The API's cap on `periods` (MAX_SCAFFOLD_PERIODS in @budget/schema's
// zod/variable-costs.js — apps/web takes no runtime dependency on that
// package). More is a 400, so the field clamps instead.
const MAX_PERIODS = 120;

/** @param {string} cycleStart @param {string} categoryId */
const cellKey = (cycleStart, categoryId) => `${cycleStart}|${categoryId}`;

/**
 * @param {VariableBudget[]} rows
 * @param {string} categoryId
 */
function budgetsFor(rows, categoryId) {
  return rows.filter((r) => r.categoryId === categoryId);
}

/**
 * @param {{
 *   open: boolean, onOpenChange: (open: boolean) => void, categories: CostCategory[], submitting: boolean,
 *   onCreate: (data: { name: string, isEssential: boolean }) => Promise<void>,
 *   onRename: (id: string, name: string) => Promise<void>,
 *   onToggleEssential: (id: string, isEssential: boolean) => void,
 *   onArchive: (id: string) => void,
 * }} props
 */
function CategoryManagerDialog({ open, onOpenChange, categories, submitting, onCreate, onRename, onToggleEssential, onArchive }) {
  const [newName, setNewName] = useState("");
  const [newEssential, setNewEssential] = useState(true);
  const [renaming, setRenaming] = useState(/** @type {{ id: string, name: string } | null} */ (null));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Variable cost categories</DialogTitle>
          <DialogDescription>
            "Personal", "Home", "Transport", "Good Life" — whatever groups your household actually uses. Essential
            categories are deducted by the allocation; non-essential ones are a benchmark only.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            await onCreate({ name: newName.trim(), isEssential: newEssential });
            setNewName("");
            setNewEssential(true);
          }}
        >
          <Input placeholder="Add a category…" value={newName} onChange={(e) => setNewName(e.target.value)} className="min-w-40 flex-1" />
          <label className="flex items-center gap-2 text-sm text-text-muted">
            <Switch checked={newEssential} onCheckedChange={setNewEssential} />
            Essential
          </label>
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
                    <span className="flex items-center gap-2">
                      {cat.name}
                      <Badge variant={cat.isEssential ? "default" : "secondary"}>
                        {cat.isEssential ? "Essential" : "Non-essential"}
                      </Badge>
                    </span>
                  )
                }
                trailing={
                  renaming?.id === cat.id ? null : (
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1.5 text-xs text-text-muted">
                        <Switch checked={cat.isEssential} onCheckedChange={(v) => onToggleEssential(cat.id, v)} />
                        Essential
                      </label>
                      <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: cat.id, name: cat.name })}>
                        Rename
                      </Button>
                      <Button size="sm" variant="ghost" className="text-text-muted hover:text-text" onClick={() => onArchive(cat.id)}>
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
 * Dated budgets — a new row is a new plan from `effectiveFrom` forward, it
 * never rewrites an earlier row's own amount (phases/07-variable-costs.md
 * "Schema"). "Use average as budget" only fills this form's amount field;
 * saving is a separate, explicit step (same doc, "Budgets").
 *
 * @param {{
 *   categoryId: string, currentCadence: Cadence, submitting: boolean,
 *   prefillAmountCents: Cents | null, onSubmit: (data: { categoryId: string, amountCents: Cents, cadence: Cadence, effectiveFrom: string, note: string | null }) => Promise<void>,
 * }} props
 */
function NewBudgetForm({ categoryId, currentCadence, submitting, prefillAmountCents, onSubmit }) {
  const [amountCents, setAmountCents] = useState(/** @type {Cents | null} */ (null));
  const [cadence, setCadence] = useState(currentCadence);
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [note, setNote] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (amountCents === null) {
      setError("Enter an amount.");
      return;
    }
    try {
      await onSubmit({ categoryId, amountCents, cadence, effectiveFrom, note: note.trim() || null });
      setAmountCents(null);
      setNote("");
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-(--radius-card) bg-surface-muted p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-text">New budget</h4>
        {prefillAmountCents !== null ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAmountCents(Math.round(equivalent(prefillAmountCents, "monthly", cadence)))}
          >
            <SparklesIcon />
            Use average as budget
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Amount" htmlFor="variable-budget-amount" required>
          <MoneyInput id="variable-budget-amount" value={amountCents} onChange={setAmountCents} />
        </FieldRow>
        <FieldRow label="Cadence" htmlFor="variable-budget-cadence">
          <Select value={cadence} onValueChange={(v) => setCadence(/** @type {Cadence} */ (v))}>
            <SelectTrigger id="variable-budget-cadence" className="w-full">
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
      <FieldRow label="Effective from" htmlFor="variable-budget-from" hint="A new plan from this date forward — it never rewrites an earlier budget's amount.">
        <DatePicker id="variable-budget-from" value={effectiveFrom} onChange={setEffectiveFrom} />
      </FieldRow>
      <FieldRow label="Note" htmlFor="variable-budget-note" hint="Optional.">
        <Input id="variable-budget-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </FieldRow>
      {error ? <InlineError>{error}</InlineError> : null}
      <Button type="submit" size="sm" className="self-start" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

/**
 * One budget row, open for correction.
 *
 * The dated-row model says a new budget is a NEW row from a date forward, and
 * this is the other case: a row that was entered wrong. The screen used to
 * offer only "add another row" and "delete this one" for that, so fixing a
 * typo meant calling `PATCH /variable-budgets/:id` by hand (todo.md
 * `[P07-6]`) — or adding a correcting row, which leaves the mistake in the
 * history as though the household had really budgeted it.
 *
 * Mounted only while the row is being edited, and keyed by the row's id, so
 * its fields always start from what THAT row holds rather than from whatever
 * was last typed into a different one.
 *
 * @param {{
 *   budget: VariableBudget, submitting: boolean, onCancel: () => void,
 *   onSave: (patch: { amountCents: Cents, cadence: Cadence, effectiveFrom: string, note: string | null }) => Promise<void>,
 * }} props
 */
function BudgetRowEditor({ budget, submitting, onCancel, onSave }) {
  const [amountCents, setAmountCents] = useState(/** @type {Cents | null} */ (budget.amountCents));
  const [cadence, setCadence] = useState(budget.cadence);
  const [effectiveFrom, setEffectiveFrom] = useState(budget.effectiveFrom);
  const [note, setNote] = useState(budget.note ?? "");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (amountCents === null) {
      setError("Enter an amount.");
      return;
    }
    try {
      await onSave({ amountCents, cadence, effectiveFrom, note: note.trim() || null });
    } catch (err) {
      // Kept on the row rather than in a toast: the message that matters
      // here is "this category already has a budget from that date", and it
      // is about the field the operator is looking at.
      setError(/** @type {Error} */ (err).message);
    }
  }

  return (
    <li>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 bg-surface-muted px-4 py-3">
        <div className="grid grid-cols-2 gap-3">
          <FieldRow label="Amount" htmlFor={`budget-edit-amount-${budget.id}`} required>
            <MoneyInput id={`budget-edit-amount-${budget.id}`} autoFocus value={amountCents} onChange={setAmountCents} />
          </FieldRow>
          <FieldRow label="Cadence" htmlFor={`budget-edit-cadence-${budget.id}`}>
            <Select value={cadence} onValueChange={(v) => setCadence(/** @type {Cadence} */ (v))}>
              <SelectTrigger id={`budget-edit-cadence-${budget.id}`} className="w-full">
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
        <FieldRow
          label="Effective from"
          htmlFor={`budget-edit-from-${budget.id}`}
          hint="Correcting the date this row took effect — it does not add a new one."
        >
          <DatePicker
            id={`budget-edit-from-${budget.id}`}
            value={effectiveFrom}
            onChange={setEffectiveFrom}
          />
        </FieldRow>
        <FieldRow label="Note" htmlFor={`budget-edit-note-${budget.id}`} hint="Optional.">
          <Input id={`budget-edit-note-${budget.id}`} value={note} onChange={(e) => setNote(e.target.value)} />
        </FieldRow>
        {error ? <InlineError>{error}</InlineError> : null}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={submitting}>
            {submitting ? "Saving…" : "Save correction"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </form>
    </li>
  );
}

/**
 * @param {{
 *   category: CostCategory | null, onOpenChange: (open: boolean) => void, ownBudgets: VariableBudget[],
 *   categorySummary: CategorySummary | undefined, primary: { anchorDate: string, cadence: Cadence } | null,
 *   submitting: boolean,
 *   onCreateBudget: (data: { categoryId: string, amountCents: Cents, cadence: Cadence, effectiveFrom: string, note: string | null }) => Promise<void>,
 *   onUpdateBudget: (id: string, patch: { amountCents: Cents, cadence: Cadence, effectiveFrom: string, note: string | null }) => Promise<void>,
 *   onDeleteBudget: (id: string) => void,
 * }} props
 */
function CategoryBudgetSheet({
  category,
  onOpenChange,
  ownBudgets,
  categorySummary,
  primary,
  submitting,
  onCreateBudget,
  onUpdateBudget,
  onDeleteBudget,
}) {
  const today = todayIso();
  const current = category ? resolveVariableBudget(ownBudgets, today) : null;
  const history = [...ownBudgets].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  const [editingBudgetId, setEditingBudgetId] = useState(/** @type {string | null} */ (null));

  return (
    <Sheet open={category !== null} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" scrollable className="max-h-[85vh]">
        <SheetHeader>
          <SheetTitle>{category?.name ?? "Category"}</SheetTitle>
          <SheetDescription>
            {category?.isEssential ? "Essential — deducted by the allocation." : "Non-essential — a benchmark only, never deducted."}
          </SheetDescription>
        </SheetHeader>
        {category ? (
          <div className="flex flex-col gap-6 px-4 pb-6">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <p className="text-xs text-text-subtle">Current budget</p>
                <p className="font-medium text-text">
                  {current ? (
                    <>
                      <Money value={current.amountCents} /> / {CADENCE_LABELS[current.cadence].toLowerCase()}
                    </>
                  ) : (
                    "Not set"
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-text-subtle">Per month</p>
                <p className="font-medium text-text">
                  {current ? <Money value={equivalent(current.amountCents, current.cadence, "monthly")} /> : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-text-subtle">Trailing average</p>
                <p className="font-medium text-text">
                  {categorySummary?.trailingAveragePerMonthCents != null ? (
                    <Money value={categorySummary.trailingAveragePerMonthCents} />
                  ) : (
                    "—"
                  )}
                  <span className="text-text-subtle"> /mo</span>
                </p>
              </div>
              <div>
                <p className="text-xs text-text-subtle">Variance</p>
                <p className="font-medium text-text">
                  {categorySummary?.varianceCents != null ? <Delta value={categorySummary.varianceCents} kind="cents" variance /> : "—"}
                </p>
              </div>
            </div>

            <NewBudgetForm
              categoryId={category.id}
              currentCadence={current?.cadence ?? "monthly"}
              submitting={submitting}
              prefillAmountCents={categorySummary?.trailingAveragePerMonthCents ?? null}
              onSubmit={onCreateBudget}
            />

            <div className="flex flex-col gap-3">
              <h4 className="text-sm font-semibold text-text">Budget history</h4>
              {history.length === 0 ? (
                <p className="text-sm text-text-muted">No budget set yet.</p>
              ) : (
                <DataList>
                  {history.map((b) =>
                    editingBudgetId === b.id ? (
                      <BudgetRowEditor
                        key={b.id}
                        budget={b}
                        submitting={submitting}
                        onCancel={() => setEditingBudgetId(null)}
                        onSave={async (patch) => {
                          await onUpdateBudget(b.id, patch);
                          setEditingBudgetId(null);
                        }}
                      />
                    ) : (
                      <DataListRow
                        key={b.id}
                        primary={
                          <>
                            <Money value={b.amountCents} /> / {CADENCE_LABELS[b.cadence].toLowerCase()}
                          </>
                        }
                        secondary={`from ${formatIsoDate(b.effectiveFrom, "en-AU")}${b.note ? ` · ${b.note}` : ""}`}
                        trailing={
                          <div className="flex gap-1">
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label="Correct this budget row"
                              onClick={() => setEditingBudgetId(b.id)}
                            >
                              <PencilIcon />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              className="text-text-muted hover:text-text"
                              aria-label="Delete this budget row"
                              onClick={() => onDeleteBudget(b.id)}
                            >
                              <Trash2Icon />
                            </Button>
                          </div>
                        }
                      />
                    ),
                  )}
                </DataList>
              )}
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * @param {{
 *   title: string, categories: CostCategory[], budgets: VariableBudget[], summaryByCategory: Map<string, CategorySummary>,
 *   primary: { anchorDate: string, cadence: Cadence } | null, today: string, onOpenCategory: (id: string) => void,
 * }} props
 */
function BudgetGroupDesktop({ title, categories, budgets, summaryByCategory, primary, today, onOpenCategory }) {
  if (categories.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-text-muted">{title}</h3>
      <ScrollArea axis="x" className="rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-text-muted">
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Budget</th>
              {primary ? <th className="px-4 py-3 font-medium">Per pay ({CADENCE_LABELS[primary.cadence]})</th> : null}
              <th className="px-4 py-3 font-medium">Per month</th>
              <th className="px-4 py-3 font-medium">Trailing avg</th>
              <th className="px-4 py-3 font-medium">Variance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {categories.map((cat) => {
              const current = resolveVariableBudget(budgetsFor(budgets, cat.id), today);
              const summary = summaryByCategory.get(cat.id);
              return (
                <tr key={cat.id} className="cursor-pointer hover:bg-surface-muted" onClick={() => onOpenCategory(cat.id)}>
                  <td className="px-4 py-3 text-text">{cat.name}</td>
                  <td className="px-4 py-3 text-text">
                    {current ? (
                      <>
                        <Money value={current.amountCents} /> <span className="text-text-subtle">/{CADENCE_LABELS[current.cadence].toLowerCase()}</span>
                      </>
                    ) : (
                      <span className="text-text-subtle">Not set</span>
                    )}
                  </td>
                  {primary ? (
                    <td className="px-4 py-3 text-text-muted">
                      {current ? <Money value={equivalent(current.amountCents, current.cadence, primary.cadence)} /> : "—"}
                    </td>
                  ) : null}
                  <td className="px-4 py-3 text-text-muted">
                    {current ? <Money value={equivalent(current.amountCents, current.cadence, "monthly")} /> : "—"}
                  </td>
                  <td className="px-4 py-3 text-text-muted">
                    {summary?.trailingAveragePerMonthCents != null ? <Money value={summary.trailingAveragePerMonthCents} /> : "—"}
                  </td>
                  <td className="px-4 py-3">
                    {summary?.varianceCents != null ? <Delta value={summary.varianceCents} kind="cents" variance /> : <span className="text-text-subtle">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

/**
 * @param {{
 *   title: string, categories: CostCategory[], budgets: VariableBudget[], summaryByCategory: Map<string, CategorySummary>,
 *   today: string, onOpenCategory: (id: string) => void,
 * }} props
 */
function BudgetGroupMobile({ title, categories, budgets, summaryByCategory, today, onOpenCategory }) {
  if (categories.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-text-muted">{title}</h3>
      <DataList>
        {categories.map((cat) => {
          const current = resolveVariableBudget(budgetsFor(budgets, cat.id), today);
          const summary = summaryByCategory.get(cat.id);
          return (
            <DataListRow
              key={cat.id}
              onClick={() => onOpenCategory(cat.id)}
              primary={cat.name}
              secondary={
                current
                  ? `${CADENCE_LABELS[current.cadence]}${summary?.trailingAveragePerMonthCents != null ? " · avg entered" : ""}`
                  : "No budget set"
              }
              trailing={current ? <Money value={equivalent(current.amountCents, current.cadence, "monthly")} /> : <span className="text-text-subtle">—</span>}
            />
          );
        })}
      </DataList>
    </div>
  );
}

/**
 * The desktop grid: cycles as rows, categories as columns, one input per
 * cell, row and column totals live (phases/07-variable-costs.md "Actuals
 * entry"). `Enter` moves down within a column; `Tab` moves across by native
 * DOM order — neither ever reorders a row or steals focus while typing.
 *
 * @param {{
 *   cycles: Cycle[], gridCategories: CostCategory[], values: Record<string, string>[],
 *   onChange: (cycleIndex: number, categoryId: string, value: string) => void,
 *   inputRefs: import("react").RefObject<Map<string, HTMLInputElement>>,
 * }} props
 */
function ActualsGridDesktop({ cycles, gridCategories, values, onChange, inputRefs }) {
  /** @param {number} cycleIndex */
  function rowTotal(cycleIndex) {
    const row = values[cycleIndex] ?? {};
    return gridCategories.reduce((sum, cat) => {
      const raw = row[cat.id]?.trim() ?? "";
      return sum + (raw === "" ? 0 : toCents(Number(raw)));
    }, 0);
  }

  /** @param {string} categoryId */
  function columnTotal(categoryId) {
    return values.reduce((sum, row) => {
      const raw = row[categoryId]?.trim() ?? "";
      return sum + (raw === "" ? 0 : toCents(Number(raw)));
    }, 0);
  }

  /** @param {import("react").KeyboardEvent<HTMLInputElement>} e @param {number} cycleIndex @param {string} categoryId */
  function handleKeyDown(e, cycleIndex, categoryId) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const next = inputRefs.current.get(`${cycleIndex + 1}:${categoryId}`);
    next?.focus();
    next?.select();
  }

  return (
    <ScrollArea axis="x" className="rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-muted">
            <th className="sticky left-0 bg-surface px-4 py-2 font-medium">Cycle</th>
            {gridCategories.map((cat) => (
              <th key={cat.id} className="px-3 py-2 font-medium whitespace-nowrap">
                <span className="flex items-center gap-1.5">
                  {cat.name}
                  <span className={cat.isEssential ? "size-1.5 rounded-full bg-(--chart-total)" :"size-1.5 rounded-full bg-text-subtle"} aria-hidden="true" />
                </span>
              </th>
            ))}
            <th className="px-3 py-2 font-medium">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {cycles.map((cycle, cycleIndex) => (
            <tr key={cycle.cycleStart}>
              <td className="sticky left-0 bg-surface px-4 py-2">
                <p className="font-medium text-text">{cycle.label}</p>
                <p className="text-xs text-text-muted">{formatIsoDate(cycle.cycleStart, "en-AU")}</p>
              </td>
              {gridCategories.map((cat) => (
                <td key={cat.id} className="px-2 py-2">
                  <MoneyInput
                    density="cell"
                    className="h-9 w-28"
                    // The column heading and the row heading are both
                    // visible, but neither is associated with the cell —
                    // a screen reader in a 7x4 grid of bare number fields
                    // hears "edit, blank" and nothing else.
                    aria-label={`${cat.name}, cycle starting ${formatIsoDate(cycle.cycleStart, "en-AU")}`}
                    ref={(el) => {
                      if (el) inputRefs.current.set(`${cycleIndex}:${cat.id}`, el);
                      else inputRefs.current.delete(`${cycleIndex}:${cat.id}`);
                    }}
                    value={parseCents(values[cycleIndex]?.[cat.id] ?? "")}
                    onChange={(cents) => onChange(cycleIndex, cat.id, centsText(cents))}
                    onKeyDown={(e) => handleKeyDown(e, cycleIndex, cat.id)}
                  />
                </td>
              ))}
              <td className="px-3 py-2 font-medium text-text">
                <Money value={rowTotal(cycleIndex)} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border text-xs text-text-muted">
            <td className="sticky left-0 bg-surface px-4 py-2 font-medium">Column total</td>
            {gridCategories.map((cat) => (
              <td key={cat.id} className="px-3 py-2 font-medium text-text">
                <Money value={columnTotal(cat.id)} />
              </td>
            ))}
            <td className="px-3 py-2 font-medium text-text">
              <Money value={gridCategories.reduce((sum, cat) => sum + columnTotal(cat.id), 0)} />
            </td>
          </tr>
        </tfoot>
      </table>
    </ScrollArea>
  );
}

/**
 * Mobile: one cycle at a time, a card per category, numeric keypad, a
 * button to the next cycle (phases/07-variable-costs.md "Actuals entry").
 *
 * @param {{
 *   cycles: Cycle[], gridCategories: CostCategory[], values: Record<string, string>[],
 *   cycleIndex: number, onCycleIndexChange: (index: number) => void,
 *   onChange: (cycleIndex: number, categoryId: string, value: string) => void,
 * }} props
 */
function ActualsGridMobile({ cycles, gridCategories, values, cycleIndex, onCycleIndexChange, onChange }) {
  const cycle = cycles[cycleIndex];
  const mobileRefs = useRef(/** @type {(HTMLInputElement | null)[]} */ ([]));

  if (!cycle) return null;

  const total = gridCategories.reduce((sum, cat) => {
    const raw = values[cycleIndex]?.[cat.id]?.trim() ?? "";
    return sum + (raw === "" ? 0 : toCents(Number(raw)));
  }, 0);

  /** @param {import("react").KeyboardEvent<HTMLInputElement>} e @param {number} i */
  function handleKeyDown(e, i) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    mobileRefs.current[i + 1]?.focus();
    mobileRefs.current[i + 1]?.select();
  }

  // One card: the cycle being entered is the card's header and its total the
  // footer. As three separate pieces — a stepper card, an inputs card and a
  // total floating under both — nothing said the total belonged to the inputs
  // or the inputs to that cycle.
  return (
    <div className="flex flex-col divide-y divide-border overflow-hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
      <div className="flex items-center justify-between gap-2 px-2 py-2">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Previous cycle"
          disabled={cycleIndex >= cycles.length - 1}
          onClick={() => onCycleIndexChange(cycleIndex + 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <div className="text-center">
          <p className="text-sm font-medium text-text">{cycle.label}</p>
          <p className="text-xs text-text-muted">
            {formatIsoDate(cycle.cycleStart, "en-AU")} – {formatIsoDate(cycle.cycleEnd, "en-AU")}
          </p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Next cycle"
          disabled={cycleIndex <= 0}
          onClick={() => onCycleIndexChange(cycleIndex - 1)}
        >
          <ChevronRightIcon />
        </Button>
      </div>
        {gridCategories.map((cat, i) => (
          <div key={cat.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="flex items-center gap-2 text-sm text-text">
              {cat.name}
              <Badge variant={cat.isEssential ? "default" : "secondary"}>{cat.isEssential ? "Essential" : "Target"}</Badge>
            </span>
            <MoneyInput
              aria-label={`${cat.name} spend this cycle`}
              ref={(el) => {
                mobileRefs.current[i] = el;
              }}
              className="h-11 w-32 shrink-0"
              inputClassName="text-base"
              value={parseCents(values[cycleIndex]?.[cat.id] ?? "")}
              onChange={(cents) => onChange(cycleIndex, cat.id, centsText(cents))}
              onKeyDown={(e) => handleKeyDown(e, i)}
            />
          </div>
        ))}
      <p className="flex items-baseline justify-between gap-3 bg-surface-muted/60 px-4 py-3 text-sm">
        <span className="text-text-muted">Cycle total</span>
        <span className="font-semibold text-text tabular-nums">
          <Money value={total} />
        </span>
      </p>
    </div>
  );
}

/**
 * A stored actual whose cycle no longer lines up with the primary schedule
 * — never auto-deleted (phases/07-variable-costs.md "Schema"), but the
 * operator can explicitly discard one here.
 */
function OrphanedCyclesPanel() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const orphansQuery = useQuery({
    queryKey: ["variable-actuals", "orphans"],
    queryFn: async () => {
      const res = await api["variable-actuals"].$get({ query: { from: "2000-01-01", to: "2100-01-01" } });
      if (!res.ok) throw new Error(await readApiError(res));
      const { variableActuals: rows } = await res.json();
      return rows.filter((r) => r.isOrphanCycle);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["variable-actuals"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["variable-actuals"] });
      // An orphan still counts towards its category's trailing average (it
      // is real spending), so deleting one moves the averages and variances
      // shown above — and the cycle grid, if the orphan's cycle is in view.
      queryClient.invalidateQueries({ queryKey: ["variable-costs-summary"] });
      queryClient.invalidateQueries({ queryKey: ["variable-costs-cycles"] });
      toast.success("Orphaned cycle deleted.");
    },
    onError: (err) => toast.error(err.message),
  });

  const orphans = orphansQuery.data ?? [];
  if (orphans.length === 0) return null;

  return (
    <Notice>
      <p>
        {orphans.length} entered cycle{orphans.length === 1 ? "" : "s"} no longer line up with the primary pay schedule —
        real history, kept, never auto-deleted. Delete one to realign, then re-enter it above.
      </p>
      <ul className="mt-2 flex flex-col divide-y divide-border">
        {orphans.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="text-text">
              {formatIsoDate(o.cycleStart, "en-AU")} · <Money value={o.amountCents} />
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="text-text-muted hover:text-text"
              onClick={async () => {
                const ok = await confirm({
                  title: "Delete this orphaned actual?",
                  description: "Its cycle no longer matches any pay period. Deleting it removes it from every trailing average.",
                  confirmLabel: "Delete",
                });
                if (ok) deleteMutation.mutate(o.id);
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
 * Tracks spending that changes every cycle: groceries, transport, personal,
 * eating out. Essential categories are deducted by the allocation;
 * non-essential ones are a benchmark that's compared against the prize pool
 * and never deducted — the one trap this whole screen exists to make
 * visible (phases/07-variable-costs.md "Objective").
 */
export function VariableCostsPage() {
  const { currency, locale } = useSettings();
  const moneyTick = useMoneyTick();
  const motion = useChartMotion();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const today = useMemo(todayIso, []);
  const inputRefs = useRef(/** @type {Map<string, HTMLInputElement>} */ (new Map()));

  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [budgetSheetCategoryId, setBudgetSheetCategoryId] = useState(/** @type {string | null} */ (null));
  const [lookback, setLookback] = useState(/** @type {(typeof LOOKBACK_OPTIONS)[number]} */ ("6"));
  const [customPeriods, setCustomPeriods] = useState(/** @type {number | null} */ (18));
  // Only what has been typed into the actuals grid, by cycle and category —
  // see lib/cell-edits.js for why it is not a copy of the server's figures.
  const [edits, setEdits] = useState(/** @type {CellEdits} */ ({}));
  const [mobileCycleIndex, setMobileCycleIndex] = useState(0);

  // A blank custom field asks for one cycle until a figure is typed — this is
  // a view setting, not something that is saved.
  const periods = lookback === "custom" ? Math.min(MAX_PERIODS, Math.max(1, customPeriods ?? 1)) : Number(lookback);

  const categoriesQuery = useQuery(costCategoriesQueryOptions("variable"));

  const budgetsQuery = useQuery(variableBudgetsQueryOptions());

  // `on` is the browser's own calendar day. The server's "today" is UTC
  // unless TZ is set, and from midnight until mid-morning in Australia that
  // is still yesterday — near a payday, a different cycle.
  const summaryQuery = useQuery(variableCostsSummaryQueryOptions(today));

  const payScheduleQuery = useQuery(paySchedulesQueryOptions());

  const primary = (payScheduleQuery.data ?? []).find((s) => s.isPrimary) ?? null;

  const cyclesQuery = useQuery({
    ...variableCostsCyclesQueryOptions(periods, today),
    enabled: primary !== null,
    // A lookback change keeps the grid on screen until the new cycles land,
    // instead of blanking it under the operator's hands.
    placeholderData: (previous) => previous,
  });

  const categories = categoriesQuery.data ?? [];
  const budgets = budgetsQuery.data ?? [];
  const summary = summaryQuery.data ?? null;
  const cycles = useMemo(() => cyclesQuery.data?.cycles ?? [], [cyclesQuery.data]);
  const summaryByCategory = useMemo(() => new Map((summary?.byCategory ?? []).map((c) => [c.categoryId, c])), [summary]);
  // All three memoised on `categories` itself. `gridCategories` used to be
  // memoised on the two filtered arrays — rebuilt every render, so the memo
  // never held, and everything keyed on it (the trend chart's rows, the
  // registered commands) was rebuilt on every keystroke in the grid,
  // restarting the chart's animation each time (perf-inp-plan.md, P1.5).
  const essentialCategories = useMemo(() => categories.filter((c) => c.isEssential), [categories]);
  const nonEssentialCategories = useMemo(() => categories.filter((c) => !c.isEssential), [categories]);
  const gridCategories = useMemo(() => [...essentialCategories, ...nonEssentialCategories], [essentialCategories, nonEssentialCategories]);
  const categoryColors = useMemo(() => entityColors(categories.map((c) => c.id)), [categories]);

  // Cycles come back newest-first; both charts read left-to-right in time.
  const oldestFirst = useMemo(() => [...cycles].reverse(), [cycles]);

  // Every series on a Recharts chart draws from ONE row array, so each
  // category becomes a column keyed `cat<id>` — the id, not the name, since
  // two categories may share a name and a data key has to be unique. The
  // name is the config label, which is what the tooltip and legend show.
  const categoryChart = useMemo(() => {
    /** @type {import("@/components/ui/chart.jsx").ChartConfig} */
    const config = {};
    /** @type {string[]} */
    const keys = [];
    /** @type {{ key: string, dollars: number }[]} */
    const budgetLines = [];

    gridCategories.forEach((cat) => {
      const key = `cat${cat.id}`;
      keys.push(key);
      config[key] = { label: cat.name, color: colorFor(categoryColors, cat.id) };
      const current = resolveVariableBudget(budgetsFor(budgets, cat.id), today);
      if (current && primary) {
        budgetLines.push({
          key,
          dollars: equivalent(current.amountCents, current.cadence, primary.cadence) / 100,
        });
      }
    });

    const rows = oldestFirst.map((cycle) => {
      /** @type {Record<string, number | string | null>} */
      const row = { label: formatIsoDate(cycle.cycleStart, locale) };
      gridCategories.forEach((cat) => {
        const amountCents = cycle.entries.find((e) => e.categoryId === cat.id)?.amountCents ?? null;
        row[`cat${cat.id}`] = amountCents !== null ? amountCents / 100 : null;
      });
      return row;
    });

    return { config, keys, budgets: budgetLines, rows };
  }, [gridCategories, categoryColors, oldestFirst, budgets, today, primary, locale]);

  const splitRows = useMemo(
    () =>
      oldestFirst.map((cycle) => {
        const sumOf = (/** @type {boolean} */ essential) =>
          cycle.entries
            .filter((e) => e.isEssential === essential)
            .reduce((sum, e) => sum + (e.amountCents ?? 0), 0) / 100;
        return {
          label: formatIsoDate(cycle.cycleStart, locale),
          essential: sumOf(true),
          nonEssential: sumOf(false),
        };
      }),
    [oldestFirst, locale],
  );

  // The grid's cells: the server's figures with the typing laid over them.
  // Rebuilt from the cycles on every refetch, which is safe now that the
  // typing lives apart from them — toggling Essential, adding or archiving
  // a category mid-entry used to refetch the cycles and wipe every cell.
  const actualCells = useMemo(
    () =>
      cycles.flatMap((cycle) =>
        cycle.entries.map((entry) => ({
          key: cellKey(cycle.cycleStart, entry.categoryId),
          storedCents: entry.amountCents,
          cycleStart: cycle.cycleStart,
          categoryId: entry.categoryId,
        })),
      ),
    [cycles],
  );
  const values = useMemo(
    () =>
      cycles.map((cycle) =>
        Object.fromEntries(
          cycle.entries.map((entry) => [
            entry.categoryId,
            cellText(edits, cellKey(cycle.cycleStart, entry.categoryId), entry.amountCents),
          ]),
        ),
      ),
    [cycles, edits],
  );
  // One diff for both what Save sends and whether leaving should ask.
  const actualChanges = useMemo(() => changedCells(edits, actualCells), [edits, actualCells]);
  const actualsDirty = actualChanges.length > 0;

  /** @param {number} cycleIndex @param {string} categoryId @param {string} text */
  function typeActual(cycleIndex, categoryId, text) {
    const cycle = cycles[cycleIndex];
    if (!cycle) return;
    setEdits((prev) => ({ ...prev, [cellKey(cycle.cycleStart, categoryId)]: text }));
  }

  // Back to the current cycle only when the lookback changes — not on every
  // refetch, which used to jump a phone back to "this cycle" mid-entry.
  useEffect(() => setMobileCycleIndex(0), [periods]);

  function invalidateCosts() {
    queryClient.invalidateQueries({ queryKey: ["variable-costs-summary"] });
    queryClient.invalidateQueries({ queryKey: ["variable-costs-cycles"] });
    queryClient.invalidateQueries({ queryKey: ["variable-actuals"] });
  }

  const createCategory = useMutation({
    mutationFn: async (/** @type {{ name: string, isEssential: boolean }} */ data) => {
      const res = await api["cost-categories"].$post({ json: { name: data.name, kind: "variable", isEssential: data.isEssential } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cost-categories", "variable"] });
      invalidateCosts();
    },
    onError: (err) => toast.error(err.message),
  });

  const renameCategory = useMutation({
    mutationFn: async (/** @type {{ id: string, name: string }} */ { id, name }) => {
      const res = await api["cost-categories"][":id"].$patch({ param: { id }, json: { name } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cost-categories", "variable"] }),
    onError: (err) => toast.error(err.message),
  });

  const toggleEssential = useMutation({
    mutationFn: async (/** @type {{ id: string, isEssential: boolean }} */ { id, isEssential }) => {
      const res = await api["cost-categories"][":id"].$patch({ param: { id }, json: { isEssential } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cost-categories", "variable"] });
      invalidateCosts();
    },
    onError: (err) => toast.error(err.message),
  });

  const archiveCategory = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["cost-categories"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cost-categories", "variable"] });
      invalidateCosts();
    },
    onError: (err) => toast.error(err.message),
  });

  const createBudget = useMutation({
    mutationFn: async (/** @type {{ categoryId: string, amountCents: Cents, cadence: Cadence, effectiveFrom: string, note: string | null }} */ data) => {
      const res = await api["variable-budgets"].$post({ json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["variable-budgets"] });
      invalidateCosts();
      toast.success("Budget saved.");
    },
  });

  // Correcting a row that was entered wrong, which is a different act from
  // changing the budget going forward — that is a new dated row, and it is
  // what `createBudget` above does (phases/07-variable-costs.md "Schema").
  const updateBudget = useMutation({
    mutationFn: async (
      /** @type {{ id: string, patch: { amountCents: Cents, cadence: Cadence, effectiveFrom: string, note: string | null } }} */ {
        id,
        patch,
      },
    ) => {
      const res = await api["variable-budgets"][":id"].$patch({ param: { id }, json: patch });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["variable-budgets"] });
      invalidateCosts();
      toast.success("Budget corrected.");
    },
  });

  const deleteBudget = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["variable-budgets"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["variable-budgets"] });
      invalidateCosts();
    },
    onError: (err) => toast.error(err.message),
  });

  const saveActuals = useMutation({
    mutationFn: async (/** @type {CellEdits} */ sent) => {
      // Only cells that actually changed from what loaded — an untouched
      // blank cell has nothing to remember (phases/07-variable-costs.md
      // "Schema"), and submitting one anyway would try to insert a row this
      // table's NOT NULL amount column can't hold.
      const entries = changedCells(sent, actualCells).map((change) => ({
        categoryId: change.categoryId,
        cycleStart: change.cycleStart,
        amountCents: change.nextCents,
      }));
      if (entries.length === 0) return { variableActuals: [] };
      const res = await api["variable-actuals"].$put({ json: { entries } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: async (result, sent) => {
      queryClient.invalidateQueries({ queryKey: ["variable-costs-summary"] });
      queryClient.invalidateQueries({ queryKey: ["variable-actuals"] });
      // Waited for, so the saved figures are in the grid before the typing
      // over them is let go — otherwise the old figures flash back first.
      await queryClient.invalidateQueries({ queryKey: ["variable-costs-cycles"] });
      setEdits((current) => forgetSentEdits(current, sent));
      toast.success(result.variableActuals.length > 0 ? "Cycle spending saved." : "Nothing changed.");
    },
    onError: (err) => toast.error(err.message),
  });

  useUnsavedGuard(actualsDirty && !saveActuals.isPending, {
    title: "Leave with unsaved spending?",
    description: "The amounts typed into the actual spending grid haven't been saved yet, and leaving discards them.",
  });

  const actualsSectionRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const budgetsSectionRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  useEffect(
    () =>
      registerCommands([
        {
          id: "variable-costs:enter-cycle-spending",
          group: "Actions",
          label: "Enter cycle spending",
          icon: CalendarClockIcon,
          run: () => {
            actualsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
            requestAnimationFrame(() => inputRefs.current.get("0:" + (gridCategories[0]?.id ?? ""))?.focus());
          },
        },
        {
          id: "variable-costs:edit-budgets",
          group: "Actions",
          label: "Edit variable budgets",
          icon: TagIcon,
          run: () => budgetsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
        },
      ]),
    [gridCategories],
  );

  // Header figures: the summary is authoritative per-month; "per cycle" is
  // a display-only conversion via the engine's own `equivalent()`, never
  // hand-rolled cadence math (phases/README.md "Money").
  const essentialHeadlineCents = summary ? (primary ? equivalent(summary.essentialPerMonthCents, "monthly", primary.cadence) : summary.essentialPerMonthCents) : 0;
  const nonEssentialHeadlineCents = summary ? (primary ? equivalent(summary.nonEssentialPerMonthCents, "monthly", primary.cadence) : summary.nonEssentialPerMonthCents) : 0;
  const payCadenceLabel = primary ? CADENCE_LABELS[primary.cadence] : null;

  const withTrailingData = (summary?.byCategory ?? []).filter((c) => c.trailingAveragePerMonthCents != null);
  const totalTrailingPerMonthCents = withTrailingData.reduce((s, c) => s + /** @type {Cents} */ (c.trailingAveragePerMonthCents), 0);
  const totalBudgetForTrailingCents = withTrailingData.reduce((s, c) => s + c.budgetPerMonthCents, 0);
  const trailingVsBudgetPct = totalBudgetForTrailingCents !== 0 ? ((totalTrailingPerMonthCents - totalBudgetForTrailingCents) / totalBudgetForTrailingCents) * 100 : 0;
  // Approximation: the most complete category's count, since the summary
  // reports cycles recorded per category, not one global distinct-cycle
  // count across every category.
  const cyclesRecorded = (summary?.byCategory ?? []).reduce((max, c) => Math.max(max, c.cyclesRecorded), 0);

  const warnings = summary?.warnings ?? [];
  const isLoading = categoriesQuery.isLoading || budgetsQuery.isLoading || summaryQuery.isLoading;

  return (
    <>
      <PageHeader
        title="Variable Costs"
        description="Essential spending is deducted by the allocation. 'Good Life' and anything else non-essential is a benchmark only — it's never deducted, or it would double-count money the prize pool already funds."
        actions={
          <>
            <Button variant="outline" onClick={() => setCategoryManagerOpen(true)}>
              <TagIcon />
              Categories
            </Button>
          </>
        }
      />

      {/* A failed load is said as one, never as "No categories yet" — that
          reads as an invitation to re-create categories that exist. */}
      {categoriesQuery.error || budgetsQuery.error || summaryQuery.error ? (
        <QueryError
          error={categoriesQuery.error ?? budgetsQuery.error ?? summaryQuery.error}
          what="your variable costs"
          onRetry={() => Promise.all([categoriesQuery.refetch(), budgetsQuery.refetch(), summaryQuery.refetch()])}
        />
      ) : !isLoading && categories.length === 0 ? (
        <EmptyState
          icon={ShoppingBagIcon}
          title="No categories yet"
          description="Add a category — Personal, Home, Transport, Good Life — before setting a budget."
          action={
            <Button onClick={() => setCategoryManagerOpen(true)}>
              <PlusIcon />
              Add category
            </Button>
          }
        />
      ) : null}

      {summary ? (
        <StatGroup aria-label="Variable costs summary">
          <Stat
            lead
            label={`Essential${payCadenceLabel ? ` (${payCadenceLabel})` : " per month"}`}
            value={<Money value={essentialHeadlineCents} />}
            hint="The figure the allocation deducts."
          />
          <Stat
            label={
              <span className="inline-flex items-center gap-1.5">
                Non-essential{payCadenceLabel ? ` (${payCadenceLabel})` : " per month"}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <InfoIcon className="size-3.5 shrink-0 text-text-subtle" aria-label="What is this?" />
                  </TooltipTrigger>
                  <TooltipContent>a benchmark compared against your prize pool — never deducted from income.</TooltipContent>
                </Tooltip>
              </span>
            }
            value={<span className="text-text-muted"><Money value={nonEssentialHeadlineCents} /></span>}
            hint="A target, not a deduction."
          />
          <Stat
            label="Trailing average vs budget"
            value={withTrailingData.length > 0 ? <Money value={totalTrailingPerMonthCents} /> : <span className="text-text-subtle">—</span>}
            delta={withTrailingData.length > 0 ? <Delta value={trailingVsBudgetPct} kind="pct" variance /> : undefined}
            hint={
              withTrailingData.length > 0 ? (
                <>
                  vs <Money value={totalBudgetForTrailingCents} />/mo budgeted
                </>
              ) : (
                "No history entered yet."
              )
            }
          />
          <Stat label="Cycles recorded" value={cyclesRecorded} />
        </StatGroup>
      ) : isLoading ? (
        <StatsSkeleton
          lead
          labels={["Essential", "Non-essential", "Trailing average vs budget", "Cycles recorded"]}
          label="Loading the variable costs summary"
        />
      ) : null}

      {warnings.length > 0 ? (
        <NoticeList items={warnings.map((w, i) => ({ key: String(i), content: <p>{w.message}</p> }))} />
      ) : null}

      {categories.length > 0 ? (
        <div ref={budgetsSectionRef} className="flex flex-col gap-5 md:gap-6">
          <div className="hidden md:flex md:flex-col md:gap-6">
            <BudgetGroupDesktop
              title="Essentials"
              categories={essentialCategories}
              budgets={budgets}
              summaryByCategory={summaryByCategory}
              primary={primary}
              today={today}
              onOpenCategory={setBudgetSheetCategoryId}
            />
            <BudgetGroupDesktop
              title="Non-essentials"
              categories={nonEssentialCategories}
              budgets={budgets}
              summaryByCategory={summaryByCategory}
              primary={primary}
              today={today}
              onOpenCategory={setBudgetSheetCategoryId}
            />
          </div>
          <div className="flex flex-col gap-5 md:hidden">
            <BudgetGroupMobile
              title="Essentials"
              categories={essentialCategories}
              budgets={budgets}
              summaryByCategory={summaryByCategory}
              today={today}
              onOpenCategory={setBudgetSheetCategoryId}
            />
            <BudgetGroupMobile
              title="Non-essentials"
              categories={nonEssentialCategories}
              budgets={budgets}
              summaryByCategory={summaryByCategory}
              today={today}
              onOpenCategory={setBudgetSheetCategoryId}
            />
          </div>
        </div>
      ) : isLoading ? (
        // Essentials, then non-essentials.
        <SectionsSkeleton sections={[4, 3]} label="Loading budgets" />
      ) : null}

      {payScheduleQuery.isLoading ? (
        <PanelSkeleton height={360} label="Loading cycles" />
      ) : payScheduleQuery.error ? (
        <QueryError
          error={payScheduleQuery.error}
          what="your pay schedules"
          onRetry={() => payScheduleQuery.refetch()}
        />
      ) : !primary ? (
        <EmptyState
          icon={CalendarClockIcon}
          title="Set a primary pay schedule"
          description="Cycle spending is entered per pay cycle, and the cycles come from the primary pay schedule. Pay schedules live on the Income page."
          action={
            <Button asChild>
              <Link to="/income" hash="pay-schedules">
                Set up pay schedules
              </Link>
            </Button>
          }
        />
      ) : (
        <div ref={actualsSectionRef}>
          <PageSection
            title="Actual spending"
            actions={
              <>
                <div className="flex items-center gap-2">
                  <label htmlFor="variable-lookback" className="text-sm text-text-muted">
                    Lookback
                  </label>
                  <Select value={lookback} onValueChange={(v) => setLookback(/** @type {(typeof LOOKBACK_OPTIONS)[number]} */ (v))}>
                    <SelectTrigger id="variable-lookback" className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="6">6 cycles</SelectItem>
                      <SelectItem value="12">12 cycles</SelectItem>
                      <SelectItem value="24">24 cycles</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                  {lookback === "custom" ? (
                    <IntegerInput
                      id="variable-custom"
                      aria-label={`Cycles, up to ${MAX_PERIODS}`}
                      title={`Up to ${MAX_PERIODS} cycles`}
                      className="w-20"
                      min={1}
                      max={MAX_PERIODS}
                      value={customPeriods}
                      onChange={setCustomPeriods}
                    />
                  ) : null}
                </div>
                <Button onClick={() => saveActuals.mutate(edits)} disabled={saveActuals.isPending}>
                  <SaveIcon />
                  {saveActuals.isPending
                    ? "Saving…"
                    : actualsDirty
                      ? `Save ${actualChanges.length} change${actualChanges.length === 1 ? "" : "s"}`
                      : "Save"}
                </Button>
              </>
            }
          >
            {cyclesQuery.isLoading ? (
              <PanelSkeleton height={360} label="Loading cycles" />
            ) : cyclesQuery.error ? (
              <QueryError error={cyclesQuery.error} what="the spending grid" onRetry={() => cyclesQuery.refetch()} />
            ) : cycles.length === 0 || gridCategories.length === 0 ? (
              <EmptyState title="Nothing to enter yet" description="Add a variable cost category first." />
            ) : (
              <>
                <div className="hidden md:block">
                  <ActualsGridDesktop cycles={cycles} gridCategories={gridCategories} values={values} inputRefs={inputRefs} onChange={typeActual} />
                </div>
                <div className="md:hidden">
                  <ActualsGridMobile
                    cycles={cycles}
                    gridCategories={gridCategories}
                    values={values}
                    cycleIndex={Math.min(mobileCycleIndex, cycles.length - 1)}
                    onCycleIndexChange={setMobileCycleIndex}
                    onChange={typeActual}
                  />
                </div>
              </>
            )}

            <OrphanedCyclesPanel />
          </PageSection>
        </div>
      )}

      {cycles.length > 0 && gridCategories.length > 0 ? (
        <PageSection title="Trends">
          <div className="rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5">
            <h3 className="mb-3 text-sm font-semibold text-text">Actual per cycle, budget as a dashed reference</h3>
            {/* The grid above holds the same actuals, but only for the
                cycles currently in view and, on mobile, one cycle at a time
                — so this trend chart carries figures the grid does not. */}
            <Chart
              height={280}
              ariaLabel={`Actual spend per cycle for ${gridCategories.length} categories across ${cycles.length} cycles, each with its budget as a faint reference line.`}
              dataTable={() => ({
                caption: "Actual spend per category, per cycle",
                columns: ["Cycle", ...gridCategories.map((cat) => cat.name)],
                rows: [...cycles].reverse().map((cycle) => [
                  formatIsoDate(cycle.cycleStart, locale),
                  ...gridCategories.map((cat) => {
                    const amountCents = cycle.entries.find((e) => e.categoryId === cat.id)?.amountCents ?? null;
                    return amountCents === null ? "—" : formatMoney(amountCents, { currency, locale });
                  }),
                ]),
              })}
              config={categoryChart.config}
            >
              <LineChart data={categoryChart.rows} margin={{ top: 8, right: 32, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...AXIS} minTickGap={24} />
                <YAxis {...AXIS} width={56} tickFormatter={moneyTick} />
                <ChartTooltip content={<MoneyTooltip />} />
                <ChartLegend content={<ChartLegendContent />} />
                {/* Each category's budget as a thin, faint rule in its own
                    colour — not dashed, since dashed means projected.
                    A reference line, not a flat extra series: it is a
                    threshold rather than a measurement, and it stays out of
                    the tooltip and the legend where it would read as one. */}
                {categoryChart.budgets.map((budget) => (
                  <ReferenceLine
                    key={budget.key}
                    y={budget.dollars}
                    stroke={`var(--color-${budget.key})`}
                    strokeWidth={1}
                    strokeOpacity={0.5}
                    ifOverflow="extendDomain"
                  />
                ))}
                {categoryChart.keys.map((key) => (
                  <Line
                    key={key}
                    dataKey={key}
                    type="monotone"
                    stroke={`var(--color-${key})`}
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    {...motion}
                  />
                ))}
              </LineChart>
            </Chart>
          </div>
          <div className="rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5">
            <h3 className="mb-3 text-sm font-semibold text-text">Total variable spend, essential vs non-essential</h3>
            <Chart
              height={240}
              ariaLabel={`Total variable spend per cycle across ${cycles.length} cycles, split into essential and non-essential.`}
              dataTable={() => ({
                caption: "Total variable spend per cycle, essential and non-essential",
                columns: ["Cycle", "Essential", "Non-essential"],
                rows: [...cycles].reverse().map((cycle) => {
                  const sumOf = (/** @type {boolean} */ essential) =>
                    cycle.entries
                      .filter((e) => e.isEssential === essential)
                      .reduce((sum, e) => sum + (e.amountCents ?? 0), 0);
                  return [
                    formatIsoDate(cycle.cycleStart, locale),
                    formatMoney(sumOf(true), { currency, locale }),
                    formatMoney(sumOf(false), { currency, locale }),
                  ];
                }),
              })}
              config={{
                essential: { label: "Essential", color: TOTAL },
                nonEssential: { label: "Non-essential", color: SERIES[1] },
              }}
            >
              <AreaChart data={splitRows} margin={{ top: 8, right: 32, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...AXIS} minTickGap={24} />
                <YAxis {...AXIS} width={56} tickFormatter={moneyTick} />
                <ChartTooltip content={<MoneyTooltip />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Area
                  dataKey="essential"
                  type="monotone"
                  stackId="total"
                  stroke="var(--color-essential)"
                  fill="var(--color-essential)"
                  fillOpacity={0.3}
                  strokeWidth={2}
                  dot={false}
                  {...motion}
                />
                <Area
                  dataKey="nonEssential"
                  type="monotone"
                  stackId="total"
                  stroke="var(--color-nonEssential)"
                  fill="var(--color-nonEssential)"
                  fillOpacity={0.3}
                  strokeWidth={2}
                  dot={false}
                  {...motion}
                />
              </AreaChart>
            </Chart>
          </div>
          <div className="rounded-(--radius-card) bg-surface-muted p-4">
            <p className="text-sm text-text-muted">
              Projected next cycle, from the trailing average —{" "}
              <Money
                value={
                  primary
                    ? gridCategories.reduce((sum, cat) => {
                        const perMonth = summaryByCategory.get(cat.id)?.trailingAveragePerMonthCents;
                        return sum + (perMonth != null ? equivalent(perMonth, "monthly", primary.cadence) : 0);
                      }, 0)
                    : 0
                }
                className="font-medium text-text"
              />
              . This is a projection only — it writes nothing and never updates a budget.
            </p>
          </div>
        </PageSection>
      ) : null}

      <CategoryManagerDialog
        open={categoryManagerOpen}
        onOpenChange={setCategoryManagerOpen}
        categories={categories}
        submitting={createCategory.isPending}
        onCreate={async (data) => {
          await createCategory.mutateAsync(data);
        }}
        onRename={async (id, name) => {
          await renameCategory.mutateAsync({ id, name });
        }}
        onToggleEssential={(id, isEssential) => toggleEssential.mutate({ id, isEssential })}
        onArchive={async (id) => {
          const ok = await confirm({
            title: `Archive ${categories.find((c) => c.id === id)?.name ?? "this category"}?`,
            description: "It leaves the budget and actuals grids. Everything recorded against it is kept.",
            confirmLabel: "Archive",
          });
          if (ok) archiveCategory.mutate(id);
        }}
      />

      <CategoryBudgetSheet
        category={categories.find((c) => c.id === budgetSheetCategoryId) ?? null}
        onOpenChange={(open) => !open && setBudgetSheetCategoryId(null)}
        ownBudgets={budgetSheetCategoryId ? budgetsFor(budgets, budgetSheetCategoryId) : []}
        categorySummary={budgetSheetCategoryId ? summaryByCategory.get(budgetSheetCategoryId) : undefined}
        primary={primary}
        submitting={createBudget.isPending || updateBudget.isPending}
        onCreateBudget={async (data) => {
          await createBudget.mutateAsync(data);
        }}
        onUpdateBudget={async (id, patch) => {
          await updateBudget.mutateAsync({ id, patch });
        }}
        onDeleteBudget={async (id) => {
          const ok = await confirm({
            title: "Delete this budget row?",
            description: "The category falls back to whichever dated row was in force before it.",
            confirmLabel: "Delete",
          });
          if (ok) deleteBudget.mutate(id);
        }}
      />
    </>
  );
}
