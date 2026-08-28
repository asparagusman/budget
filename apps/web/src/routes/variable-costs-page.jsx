import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { equivalent, resolveVariableBudget, toCents } from "@budget/engine";
import {
  AlertTriangleIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InfoIcon,
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
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.jsx";
import { Switch } from "@/components/ui/switch.jsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.jsx";
import { Chart } from "@/components/chart.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { Delta } from "@/components/delta.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { Money } from "@/components/money.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { StatTile } from "@/components/stat-tile.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { CADENCES, CADENCE_LABELS } from "@/lib/constants.js";
import { formatIsoDate, todayIso } from "@/lib/dates.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";

/** @import { Cadence, Cents } from "@budget/engine" */
/** @typedef {{ id: string, name: string, kind: "fixed" | "variable", isEssential: boolean, colour: string | null, sortOrder: number }} CostCategory */
/** @typedef {{ id: string, categoryId: string, amountCents: Cents, cadence: Cadence, effectiveFrom: string, note: string | null }} VariableBudget */
/** @typedef {{ categoryId: string, name: string, isEssential: boolean, budgetPerMonthCents: Cents, trailingAveragePerMonthCents: Cents | null, varianceCents: Cents | null, cyclesRecorded: number }} CategorySummary */
/** @typedef {{ essentialPerMonthCents: Cents, nonEssentialPerMonthCents: Cents, byCategory: CategorySummary[], warnings: { code: string, message: string, categoryId?: string }[] }} VariableCostsSummary */
/** @typedef {{ categoryId: string, name: string, isEssential: boolean, amountCents: Cents | null }} CycleEntry */
/** @typedef {{ ordinal: number, label: string, cycleStart: string, cycleEnd: string, entries: CycleEntry[] }} Cycle */

const LOOKBACK_OPTIONS = /** @type {const} */ (["6", "12", "24", "custom"]);

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
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState(currentCadence);
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [note, setNote] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (amount.trim() === "") {
      setError("Enter an amount.");
      return;
    }
    try {
      await onSubmit({ categoryId, amountCents: toCents(Number(amount)), cadence, effectiveFrom, note: note.trim() || null });
      setAmount("");
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
            onClick={() => setAmount(String(equivalent(prefillAmountCents, "monthly", cadence) / 100))}
          >
            <SparklesIcon />
            Use average as budget
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Amount" htmlFor="variable-budget-amount" required>
          <InputGroup>
            <InputGroupAddon>
              <InputGroupText>$</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              id="variable-budget-amount"
              type="number"
              step="0.01"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </InputGroup>
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
        <Input id="variable-budget-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </FieldRow>
      <FieldRow label="Note" htmlFor="variable-budget-note" hint="Optional.">
        <Input id="variable-budget-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </FieldRow>
      {error ? <p className="text-sm text-negative">{error}</p> : null}
      <Button type="submit" size="sm" className="self-start" disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

/**
 * @param {{
 *   category: CostCategory | null, onOpenChange: (open: boolean) => void, ownBudgets: VariableBudget[],
 *   categorySummary: CategorySummary | undefined, primary: { anchorDate: string, cadence: Cadence } | null,
 *   submitting: boolean,
 *   onCreateBudget: (data: { categoryId: string, amountCents: Cents, cadence: Cadence, effectiveFrom: string, note: string | null }) => Promise<void>,
 *   onDeleteBudget: (id: string) => void,
 * }} props
 */
function CategoryBudgetSheet({ category, onOpenChange, ownBudgets, categorySummary, primary, submitting, onCreateBudget, onDeleteBudget }) {
  const today = todayIso();
  const current = category ? resolveVariableBudget(ownBudgets, today) : null;
  const history = [...ownBudgets].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));

  return (
    <Sheet open={category !== null} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
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
                  {categorySummary?.varianceCents != null ? <Delta value={categorySummary.varianceCents} kind="cents" invert /> : "—"}
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
                  {history.map((b) => (
                    <DataListRow
                      key={b.id}
                      primary={
                        <>
                          <Money value={b.amountCents} /> / {CADENCE_LABELS[b.cadence].toLowerCase()}
                        </>
                      }
                      secondary={`from ${formatIsoDate(b.effectiveFrom, "en-AU")}${b.note ? ` · ${b.note}` : ""}`}
                      trailing={
                        <Button size="sm" variant="ghost" className="text-negative" onClick={() => onDeleteBudget(b.id)}>
                          <Trash2Icon />
                        </Button>
                      }
                    />
                  ))}
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
      <div className="overflow-x-auto rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
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
                    {summary?.varianceCents != null ? <Delta value={summary.varianceCents} kind="cents" invert /> : <span className="text-text-subtle">—</span>}
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
    <div className="overflow-x-auto rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-muted">
            <th className="sticky left-0 bg-surface px-4 py-2 font-medium">Cycle</th>
            {gridCategories.map((cat) => (
              <th key={cat.id} className="px-3 py-2 font-medium whitespace-nowrap">
                <span className="flex items-center gap-1.5">
                  {cat.name}
                  <span className={cat.isEssential ? "size-1.5 rounded-full bg-(--accent)" : "size-1.5 rounded-full bg-text-subtle"} aria-hidden="true" />
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
                  <InputGroup className="h-9 w-28">
                    <InputGroupAddon>
                      <InputGroupText className="text-xs">$</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      // The column heading and the row heading are both
                      // visible, but neither is associated with the cell —
                      // a screen reader in a 7x4 grid of bare number fields
                      // hears "edit, blank" and nothing else.
                      aria-label={`${cat.name}, cycle starting ${formatIsoDate(cycle.cycleStart, "en-AU")}`}
                      ref={(el) => {
                        if (el) inputRefs.current.set(`${cycleIndex}:${cat.id}`, el);
                        else inputRefs.current.delete(`${cycleIndex}:${cat.id}`);
                      }}
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={values[cycleIndex]?.[cat.id] ?? ""}
                      onChange={(e) => onChange(cycleIndex, cat.id, e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, cycleIndex, cat.id)}
                    />
                  </InputGroup>
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
    </div>
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 rounded-(--radius-card) bg-surface p-3 shadow-(--shadow-card)">
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
      <div className="flex flex-col divide-y divide-border rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
        {gridCategories.map((cat, i) => (
          <div key={cat.id} className="flex items-center justify-between gap-3 p-4">
            <span className="flex items-center gap-2 text-sm text-text">
              {cat.name}
              <Badge variant={cat.isEssential ? "default" : "secondary"}>{cat.isEssential ? "Essential" : "Target"}</Badge>
            </span>
            <InputGroup className="h-11 w-32 shrink-0">
              <InputGroupAddon>
                <InputGroupText>$</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                aria-label={`${cat.name} spend this cycle`}
                ref={(el) => {
                  mobileRefs.current[i] = el;
                }}
                type="number"
                step="0.01"
                inputMode="decimal"
                className="text-base"
                value={values[cycleIndex]?.[cat.id] ?? ""}
                onChange={(e) => onChange(cycleIndex, cat.id, e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, i)}
              />
            </InputGroup>
          </div>
        ))}
      </div>
      <p className="text-right text-sm font-medium text-text">
        Cycle total: <Money value={total} />
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
      toast.success("Orphaned cycle deleted.");
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
          {orphans.length} entered cycle{orphans.length === 1 ? "" : "s"} no longer line up with the primary pay schedule —
          real history, kept, never auto-deleted. Delete one to realign, then re-enter it above.
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-border">
        {orphans.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="text-text">
              {formatIsoDate(o.cycleStart, "en-AU")} · <Money value={o.amountCents} />
            </span>
            <Button size="sm" variant="ghost" className="text-negative" onClick={() => deleteMutation.mutate(o.id)}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
    </div>
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
  const queryClient = useQueryClient();
  const today = useMemo(todayIso, []);
  const inputRefs = useRef(/** @type {Map<string, HTMLInputElement>} */ (new Map()));

  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [budgetSheetCategoryId, setBudgetSheetCategoryId] = useState(/** @type {string | null} */ (null));
  const [lookback, setLookback] = useState(/** @type {(typeof LOOKBACK_OPTIONS)[number]} */ ("6"));
  const [customPeriods, setCustomPeriods] = useState("18");
  const [values, setValues] = useState(/** @type {Record<string, string>[]} */ ([]));
  const [mobileCycleIndex, setMobileCycleIndex] = useState(0);

  const periods = lookback === "custom" ? Math.max(1, Number(customPeriods) || 1) : Number(lookback);

  const categoriesQuery = useQuery({
    queryKey: ["cost-categories", "variable"],
    queryFn: async () => {
      const res = await api["cost-categories"].$get({ query: { kind: "variable" } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {CostCategory[]} */ ((await res.json()).costCategories);
    },
  });

  const budgetsQuery = useQuery({
    queryKey: ["variable-budgets"],
    queryFn: async () => {
      const res = await api["variable-budgets"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {VariableBudget[]} */ ((await res.json()).variableBudgets);
    },
  });

  const summaryQuery = useQuery({
    queryKey: ["variable-costs-summary"],
    queryFn: async () => {
      const res = await api["variable-costs"].summary.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {VariableCostsSummary} */ (await res.json());
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

  const primary = (payScheduleQuery.data ?? []).find((s) => s.isPrimary) ?? null;

  const cyclesQuery = useQuery({
    queryKey: ["variable-costs-cycles", periods],
    queryFn: async () => {
      const res = await api["variable-costs"].cycles.$get({ query: { periods: String(periods) } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {{ cycles: Cycle[] }} */ (await res.json());
    },
    enabled: primary !== null,
  });

  const categories = categoriesQuery.data ?? [];
  const budgets = budgetsQuery.data ?? [];
  const summary = summaryQuery.data ?? null;
  const cycles = cyclesQuery.data?.cycles ?? [];
  const summaryByCategory = useMemo(() => new Map((summary?.byCategory ?? []).map((c) => [c.categoryId, c])), [summary]);
  const essentialCategories = categories.filter((c) => c.isEssential);
  const nonEssentialCategories = categories.filter((c) => !c.isEssential);
  const gridCategories = useMemo(() => [...essentialCategories, ...nonEssentialCategories], [essentialCategories, nonEssentialCategories]);

  // Re-syncs only when the cycle set itself changes (a different lookback or
  // fresh data from the server) — never while the operator is mid-edit,
  // same rule as bill-history-page.jsx.
  useEffect(() => {
    setValues(cycles.map((cycle) => Object.fromEntries(cycle.entries.map((e) => [e.categoryId, e.amountCents !== null ? String(e.amountCents / 100) : ""]))));
    setMobileCycleIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cyclesQuery.data]);

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
    mutationFn: async () => {
      // Only cells that actually changed from what loaded — an untouched
      // blank cell has nothing to remember (phases/07-variable-costs.md
      // "Schema"), and submitting one anyway would try to insert a row this
      // table's NOT NULL amount column can't hold.
      /** @type {{ categoryId: string, cycleStart: string, amountCents: Cents | null }[]} */
      const entries = [];
      cycles.forEach((cycle, cycleIndex) => {
        for (const entry of cycle.entries) {
          const raw = values[cycleIndex]?.[entry.categoryId]?.trim() ?? "";
          const nextCents = raw === "" ? null : toCents(Number(raw));
          if (nextCents !== entry.amountCents) {
            entries.push({ categoryId: entry.categoryId, cycleStart: cycle.cycleStart, amountCents: nextCents });
          }
        }
      });
      if (entries.length === 0) return { variableActuals: [] };
      const res = await api["variable-actuals"].$put({ json: { entries } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: (result) => {
      invalidateCosts();
      toast.success(result.variableActuals.length > 0 ? "Cycle spending saved." : "Nothing changed.");
    },
    onError: (err) => toast.error(err.message),
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

      {!isLoading && categories.length === 0 ? (
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
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile
            label={`Essential${payCadenceLabel ? ` (${payCadenceLabel})` : " per month"}`}
            value={<Money value={essentialHeadlineCents} />}
            sparkline={<p className="text-xs text-text-muted">The figure the allocation deducts.</p>}
          />
          <StatTile
            className="opacity-90"
            label={
              <span className="inline-flex items-center gap-1.5">
                Non-essential{payCadenceLabel ? ` (${payCadenceLabel})` : " per month"}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <InfoIcon className="size-3.5 text-text-subtle" aria-label="What is this?" />
                  </TooltipTrigger>
                  <TooltipContent>a benchmark compared against your prize pool — never deducted from income.</TooltipContent>
                </Tooltip>
              </span>
            }
            value={<span className="text-text-muted"><Money value={nonEssentialHeadlineCents} /></span>}
            sparkline={<p className="text-xs text-text-muted">A target, not a deduction.</p>}
          />
          <StatTile
            label="Trailing average vs budget"
            value={withTrailingData.length > 0 ? <Money value={totalTrailingPerMonthCents} /> : <span className="text-text-subtle">—</span>}
            delta={withTrailingData.length > 0 ? <Delta value={trailingVsBudgetPct} kind="pct" invert /> : undefined}
            sparkline={
              withTrailingData.length > 0 ? (
                <p className="text-xs text-text-muted">
                  vs <Money value={totalBudgetForTrailingCents} />/mo budgeted
                </p>
              ) : (
                <p className="text-xs text-text-muted">No history entered yet.</p>
              )
            }
          />
          <StatTile label="Cycles recorded" value={cyclesRecorded} />
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

      {categories.length > 0 ? (
        <div ref={budgetsSectionRef} className="flex flex-col gap-6">
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
          <div className="flex flex-col gap-6 md:hidden">
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
      ) : null}

      {!primary ? (
        <EmptyState
          icon={CalendarClockIcon}
          title="Set a primary pay schedule"
          description="Cycle spending is entered per pay cycle — set a primary pay schedule in Accounts before entering history."
        />
      ) : (
        <div ref={actualsSectionRef} className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-end gap-4">
              <FieldRow label="Lookback" htmlFor="variable-lookback" className="w-40">
                <Select value={lookback} onValueChange={(v) => setLookback(/** @type {(typeof LOOKBACK_OPTIONS)[number]} */ (v))}>
                  <SelectTrigger id="variable-lookback" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="6">6 cycles</SelectItem>
                    <SelectItem value="12">12 cycles</SelectItem>
                    <SelectItem value="24">24 cycles</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </FieldRow>
              {lookback === "custom" ? (
                <FieldRow label="Cycles" htmlFor="variable-custom" className="w-28">
                  <Input id="variable-custom" type="number" min="1" inputMode="numeric" value={customPeriods} onChange={(e) => setCustomPeriods(e.target.value)} />
                </FieldRow>
              ) : null}
            </div>
            <Button onClick={() => saveActuals.mutate()} disabled={saveActuals.isPending}>
              <SaveIcon />
              {saveActuals.isPending ? "Saving…" : "Save"}
            </Button>
          </div>

          {cyclesQuery.isLoading ? null : cycles.length === 0 || gridCategories.length === 0 ? (
            <EmptyState title="Nothing to enter yet" description="Add a variable cost category first." />
          ) : (
            <>
              <div className="hidden md:block">
                <ActualsGridDesktop cycles={cycles} gridCategories={gridCategories} values={values} inputRefs={inputRefs} onChange={(i, categoryId, value) => setValues((prev) => prev.map((row, idx) => (idx === i ? { ...row, [categoryId]: value } : row)))} />
              </div>
              <div className="md:hidden">
                <ActualsGridMobile
                  cycles={cycles}
                  gridCategories={gridCategories}
                  values={values}
                  cycleIndex={Math.min(mobileCycleIndex, cycles.length - 1)}
                  onCycleIndexChange={setMobileCycleIndex}
                  onChange={(i, categoryId, value) => setValues((prev) => prev.map((row, idx) => (idx === i ? { ...row, [categoryId]: value } : row)))}
                />
              </div>
            </>
          )}

          <OrphanedCyclesPanel />
        </div>
      )}

      {cycles.length > 0 && gridCategories.length > 0 ? (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-text">Trends</h2>
          <div className="rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
            <h3 className="mb-3 text-sm font-semibold text-text">Actual per cycle, budget as a dashed reference</h3>
            {/* The grid above holds the same actuals, but only for the
                cycles currently in view and, on mobile, one cycle at a time
                — so this trend chart carries figures the grid does not. */}
            <Chart
              height={280}
              ariaLabel={`Actual spend per cycle for ${gridCategories.length} categories across ${cycles.length} cycles, each with its budget as a dashed reference line.`}
              dataTable={{
                caption: "Actual spend per category, per cycle",
                columns: ["Cycle", ...gridCategories.map((cat) => cat.name)],
                rows: [...cycles].reverse().map((cycle) => [
                  formatIsoDate(cycle.cycleStart, locale),
                  ...gridCategories.map((cat) => {
                    const amountCents = cycle.entries.find((e) => e.categoryId === cat.id)?.amountCents ?? null;
                    return amountCents === null ? "—" : formatMoney(amountCents, { currency, locale });
                  }),
                ]),
              }}
              option={(tokens) => {
                const oldestFirst = [...cycles].reverse();
                return {
                  legend: { top: 0, textStyle: { color: tokens.axisLabel } },
                  grid: { top: 36 },
                  xAxis: { type: "category", data: oldestFirst.map((c) => formatIsoDate(c.cycleStart, "en-AU")) },
                  yAxis: { type: "value" },
                  series: gridCategories.map((cat, i) => {
                    const current = resolveVariableBudget(budgetsFor(budgets, cat.id), today);
                    const budgetPerCycleCents = current && primary ? equivalent(current.amountCents, current.cadence, primary.cadence) : null;
                    const color = tokens.series[i % tokens.series.length];
                    return {
                      type: "line",
                      name: cat.name,
                      data: oldestFirst.map((c) => {
                        const amountCents = c.entries.find((e) => e.categoryId === cat.id)?.amountCents ?? null;
                        return amountCents !== null ? amountCents / 100 : null;
                      }),
                      connectNulls: false,
                      smooth: true,
                      lineStyle: { color, width: 2 },
                      itemStyle: { color },
                      markLine:
                        budgetPerCycleCents !== null
                          ? {
                              silent: true,
                              symbol: "none",
                              label: { show: false },
                              lineStyle: { type: "dashed", color },
                              data: [{ yAxis: budgetPerCycleCents / 100 }],
                            }
                          : undefined,
                    };
                  }),
                };
              }}
            />
          </div>
          <div className="rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
            <h3 className="mb-3 text-sm font-semibold text-text">Total variable spend, essential vs non-essential</h3>
            <Chart
              height={240}
              ariaLabel={`Total variable spend per cycle across ${cycles.length} cycles, split into essential and non-essential.`}
              dataTable={{
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
              }}
              option={(tokens) => {
                const oldestFirst = [...cycles].reverse();
                /** @param {boolean} essential */
                const seriesFor = (essential) =>
                  oldestFirst.map((c) =>
                    c.entries.filter((e) => e.isEssential === essential).reduce((sum, e) => sum + (e.amountCents ?? 0), 0) / 100,
                  );
                return {
                  legend: { top: 0, textStyle: { color: tokens.axisLabel } },
                  grid: { top: 36 },
                  xAxis: { type: "category", data: oldestFirst.map((c) => formatIsoDate(c.cycleStart, "en-AU")) },
                  yAxis: { type: "value" },
                  series: [
                    { type: "line", name: "Essential", stack: "total", areaStyle: {}, data: seriesFor(true), itemStyle: { color: tokens.series[0] }, lineStyle: { color: tokens.series[0] } },
                    { type: "line", name: "Non-essential", stack: "total", areaStyle: {}, data: seriesFor(false), itemStyle: { color: tokens.series[3] }, lineStyle: { color: tokens.series[3] } },
                  ],
                };
              }}
            />
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
        </div>
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
        onArchive={(id) => archiveCategory.mutate(id)}
      />

      <CategoryBudgetSheet
        category={categories.find((c) => c.id === budgetSheetCategoryId) ?? null}
        onOpenChange={(open) => !open && setBudgetSheetCategoryId(null)}
        ownBudgets={budgetSheetCategoryId ? budgetsFor(budgets, budgetSheetCategoryId) : []}
        categorySummary={budgetSheetCategoryId ? summaryByCategory.get(budgetSheetCategoryId) : undefined}
        primary={primary}
        submitting={createBudget.isPending}
        onCreateBudget={async (data) => {
          await createBudget.mutateAsync(data);
        }}
        onDeleteBudget={(id) => deleteBudget.mutate(id)}
      />
    </>
  );
}
