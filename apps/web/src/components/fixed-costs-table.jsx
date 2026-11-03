import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, RotateCcwIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { DatePicker } from "@/components/date-picker.jsx";
import { IntegerInput, MoneyInput, PercentInput } from "@/components/money-input.jsx";
import { Money } from "@/components/money.jsx";
import { InlineError } from "@/components/notice.jsx";
import { AMOUNT_MODEL_LABELS, AMOUNT_MODELS, CADENCES, CADENCE_LABELS } from "@/lib/constants.js";
import { formatIsoDate } from "@/lib/dates.js";
import { billToDraft, draftSignature, isBlankGhost, restatedFigures } from "@/lib/fixed-costs-draft.js";
import { formatDecimalText, formatMoneyText, parseDecimalText, parseMoneyText } from "@/lib/numeric-text.js";
import { cn } from "@/lib/utils.js";
import { ScrollArea } from "@/components/scroll-area.jsx";

/** @import { AmountModel, Cadence, Cents, WindowFigures } from "@budget/engine" */
/** @import { Bill, DraftBill } from "@/lib/fixed-costs-draft.js" */
/** @typedef {{ id: string, name: string }} Person */
/** @typedef {{ id: string, name: string, type: string, isIncomeLanding: boolean }} Account */
/** @typedef {{ id: string, name: string, kind: "fixed" | "variable", isEssential: boolean, colour: string | null, sortOrder: number }} CostCategory */
/** @typedef {{ count: number, minCents: Cents, maxCents: Cents, meanCents: Cents }} HistorySpread */

/**
 * @typedef {{
 *   draft: DraftBill,
 *   bill: Bill | null,
 *   figures: WindowFigures | null,
 *   spread: HistorySpread | null,
 *   error: string | null,
 * }} BillRow
 *
 * One line of the table, already resolved: `figures` is what this bill costs
 * across the contribution window (the server's, at rest; recomputed from the
 * draft while editing), and `spread` is what it has actually cost according
 * to the actuals entered against it.
 */

/**
 * @typedef {{
 *   perPayCents: Cents | null,
 *   perMonthCents: Cents,
 *   perYearCents: Cents,
 * }} GroupTotals
 */

/**
 * An unsaved edit: the draft no longer matches its saved bill, or a new row
 * has something in it. The same test the page's "N unsaved changes" count
 * uses, so every change it counts is visibly marked — edited rows amber,
 * removed rows faded (and not amber).
 *
 * @param {Pick<BillRow, "draft" | "bill">} row
 */
function isEdited({ draft, bill }) {
  if (draft.removed) return false;
  return bill ? draftSignature(draft) !== draftSignature(billToDraft(bill)) : !isBlankGhost(draft);
}

/** @param {Person[]} people @param {string | null} personId */
function personName(people, personId) {
  if (personId === null || personId === "") return "Shared";
  return people.find((p) => p.id === personId)?.name ?? "Unknown person";
}

/**
 * The amber "this date is a guess" mark. An imported bill's due date is one
 * placeholder day the importer chose (the workbook holds none), and the
 * calendar, the bills buffer and the balance curve are all computed from it —
 * so it says so on every row until the date is changed or confirmed.
 *
 * @param {{ bill: Bill | null }} props
 */
export function PlaceholderDateBadge({ bill }) {
  if (!bill || bill.dueDateConfirmed) return null;
  return (
    <Badge variant="attention" title="Imported with a placeholder due date. Set the real one, or confirm it from the bill.">
      Placeholder date
    </Badge>
  );
}

/**
 * The line under a row's amount that says where the amount came from — the
 * answer to "this bill is a rolling average and the app appears to be
 * ignoring that". For a flat bill there is nothing to explain and nothing is
 * shown.
 *
 * @param {{ draft: DraftBill, bill: Bill | null, figures: WindowFigures | null, spread: HistorySpread | null }} props
 */
function AmountBasis({ draft, bill, figures, spread }) {
  if (draft.amountModel === "flat" && !figures?.variesInWindow) return null;

  /** @type {import("react").ReactNode} */
  let text = null;

  if (draft.amountModel === "rolling_average") {
    const need = Number(draft.rollingWindowText) || 0;
    const have = spread?.count ?? 0;
    text =
      have >= need && need > 0 ? (
        <>average of the last {need} actuals</>
      ) : (
        <>
          base — only {have} of {need} actuals entered
        </>
      );
  } else if (draft.amountModel === "seasonal") {
    const complete = Object.keys(bill?.seasonalFactors ?? {}).length >= 12;
    text = complete ? <>seasonal</> : <>seasonal · factors unfinished</>;
  } else if (draft.amountModel === "escalating") {
    text = <>+{draft.escalationPctText || 0}% a year</>;
  } else {
    text = <>stepped</>;
  }

  return (
    <span className="text-xs text-text-subtle">
      {text}
      {figures && figures.variesInWindow && figures.minAmountCents !== null && figures.maxAmountCents !== null ? (
        <>
          {" · "}
          <Money value={figures.minAmountCents} />–<Money value={figures.maxAmountCents} />
        </>
      ) : null}
    </span>
  );
}

/**
 * @param {{ row: BillRow, people: Person[], locale: string, onOpenBill: (id: string) => void }} props
 */
function ViewRow({ row, people, locale, onOpenBill }) {
  const { draft, bill, figures, spread } = row;
  const { weeklyCents, monthlyCents, quarterlyCents, yearlyCents } = restatedFigures(
    figures ?? { perMonthCents: 0, perYearCents: 0 },
  );

  return (
    <tr>
      <td className="px-4 py-3 text-text">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            className="text-left hover:underline"
            onClick={() => bill && onOpenBill(bill.id)}
          >
            {draft.name}
          </button>
          {draft.amountModel !== "flat" ? (
            <Badge variant="secondary">{AMOUNT_MODEL_LABELS[draft.amountModel]}</Badge>
          ) : null}
          <PlaceholderDateBadge bill={bill} />
        </span>
      </td>
      <td className="px-4 py-3 text-text-muted">{personName(people, draft.ownerPersonId)}</td>
      <td className="px-4 py-3 text-text">
        <div className="flex flex-col">
          <span>
            {figures?.nextAmountCents != null ? <Money value={figures.nextAmountCents} /> : "—"}{" "}
            <span className="text-text-subtle">/{CADENCE_LABELS[draft.frequency].toLowerCase()}</span>
          </span>
          <AmountBasis draft={draft} bill={bill} figures={figures} spread={spread} />
        </div>
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-text-muted">
        {figures?.nextDueDate ? formatIsoDate(figures.nextDueDate, locale) : "—"}
      </td>
      <td className="px-4 py-3 text-right text-text-muted">
        <Money value={weeklyCents} />
      </td>
      <td className="px-4 py-3 text-right text-text-muted">
        <Money value={monthlyCents} />
      </td>
      <td className="px-4 py-3 text-right text-text-muted">
        <Money value={quarterlyCents} />
      </td>
      <td className="px-4 py-3 text-right text-text-muted">
        <Money value={yearlyCents} />
      </td>
    </tr>
  );
}

/**
 * @param {{
 *   row: BillRow, people: Person[], accounts: Account[],
 *   onChange: (key: string, patch: Partial<DraftBill>) => void,
 *   onRemove: (key: string) => void,
 *   onOpenBill: (id: string) => void,
 * }} props
 */
function EditRow({ row, people, accounts, onChange, onRemove, onOpenBill }) {
  const { draft, bill, figures, error } = row;
  const ghost = draft.billId === null;
  const blank = isBlankGhost(draft);
  // Typing a different date is what confirms it (the server does that on
  // save), so the mark stays only while the placeholder is still the value.
  const placeholderBill = bill && draft.anchorDate === bill.anchorDate ? bill : null;

  return (
    <tr className={cn(draft.removed && "opacity-45", blank && "text-text-subtle", isEdited(row) && "bg-warning-soft")}>
      <td className="px-2 py-2 align-top">
        <Input
          className="h-8 min-w-36"
          aria-label="Bill name"
          placeholder={ghost ? "Add a bill…" : undefined}
          value={draft.name}
          disabled={draft.removed}
          onChange={(e) => onChange(draft.key, { name: e.target.value })}
        />
        {error ? <InlineError size="xs" className="mt-1">{error}</InlineError> : null}
      </td>
      <td className="px-2 py-2 align-top">
        <Select
          value={draft.ownerPersonId || "shared"}
          disabled={draft.removed}
          onValueChange={(v) => onChange(draft.key, { ownerPersonId: v === "shared" ? "" : v })}
        >
          <SelectTrigger className="h-8 w-full min-w-28" aria-label="Owner">
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
      </td>
      <td className="px-2 py-2 align-top">
        <MoneyInput
          density="cell"
          className="h-8 w-28"
          aria-label={draft.amountModel === "flat" ? "Amount" : "Base amount"}
          value={parseMoneyText(draft.amountText)}
          disabled={draft.removed}
          onChange={(cents) => onChange(draft.key, { amountText: formatMoneyText(cents) })}
        />
        {draft.amountModel !== "flat" ? (
          <p className="mt-1 text-xs text-text-subtle">base / fallback</p>
        ) : null}
      </td>
      <td className="px-2 py-2 align-top">
        <Select
          value={draft.frequency}
          disabled={draft.removed}
          onValueChange={(v) => onChange(draft.key, { frequency: /** @type {Cadence} */ (v) })}
        >
          <SelectTrigger className="h-8 w-full min-w-32" aria-label="Cadence">
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
      </td>
      <td className="px-2 py-2 align-top">
        <DatePicker
          className="min-w-36"
          ariaLabel="A known due date"
          value={draft.anchorDate}
          disabled={draft.removed}
          onChange={(v) => onChange(draft.key, { anchorDate: v })}
        />
        {placeholderBill && !placeholderBill.dueDateConfirmed ? (
          <div className="mt-1">
            <PlaceholderDateBadge bill={placeholderBill} />
          </div>
        ) : null}
      </td>
      <td className="px-2 py-2 align-top">
        <div className="flex items-start gap-1">
          <Select
            value={draft.amountModel}
            disabled={draft.removed}
            onValueChange={(v) => onChange(draft.key, { amountModel: /** @type {AmountModel} */ (v) })}
          >
            <SelectTrigger className="h-8 w-full min-w-36" aria-label="Amount model">
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
          {draft.amountModel === "rolling_average" ? (
            <IntegerInput
              density="cell"
              className="h-8 w-16"
              min={1}
              aria-label="How many past actuals to average"
              value={parseDecimalText(draft.rollingWindowText, 0)}
              disabled={draft.removed}
              onChange={(n) => onChange(draft.key, { rollingWindowText: formatDecimalText(n, 0) })}
            />
          ) : null}
          {draft.amountModel === "escalating" ? (
            <PercentInput
              density="cell"
              className="h-8 w-24"
              decimals={4}
              aria-label="Percent per year"
              value={parseDecimalText(draft.escalationPctText, 4)}
              disabled={draft.removed}
              onChange={(pct) => onChange(draft.key, { escalationPctText: formatDecimalText(pct, 4) })}
            />
          ) : null}
        </div>
        {/* The models that need data this table cannot hold say so, and say
            where it lives — a select that silently does nothing is exactly
            the complaint that started this. */}
        {!ghost && (draft.amountModel === "rolling_average" || draft.amountModel === "seasonal") ? (
          <button
            type="button"
            className="mt-1 text-xs text-primary hover:underline"
            onClick={() => draft.billId && onOpenBill(draft.billId)}
          >
            {draft.amountModel === "seasonal" ? "Set monthly factors…" : "Enter bill history…"}
          </button>
        ) : null}
        {ghost && draft.amountModel !== "flat" && !blank ? (
          <p className="mt-1 text-xs text-text-subtle">Save first, then enter its history.</p>
        ) : null}
      </td>
      <td className="px-2 py-2 text-right align-top text-text-muted">
        {figures ? <Money value={figures.perYearCents} /> : <span className="text-text-subtle">—</span>}
      </td>
      <td className="px-2 py-2 align-top">
        {/* Nothing at all on an untouched ghost — a greyed-out X on an empty
            row reads as a control that ought to work. */}
        {blank ? null : (
          <Button
            size="icon-sm"
            variant="ghost"
            className={draft.removed ? undefined : "text-text-muted hover:text-text"}
            aria-label={draft.removed ? `Keep ${draft.name}` : `Remove ${draft.name || "this row"}`}
            onClick={() => onRemove(draft.key)}
          >
            {draft.removed ? <RotateCcwIcon /> : <XIcon />}
          </Button>
        )}
      </td>
    </tr>
  );
}

// "Anchor date", not "Next due": in edit mode this cell is the known due date
// the whole series is derived from, which is a different thing from the next
// occurrence the view-mode column reports.
const EDIT_HEADINGS = ["Name", "Owner", "Amount", "Cadence", "Anchor date", "Model", "Annual", ""];
const VIEW_HEADINGS = ["Name", "Owner", "Amount", "Next due", "Weekly", "Monthly", "Quarterly", "Annual"];

// Fixed shares of the table's width, so every category's table puts "Owner",
// "Next due" and the four restated amounts at the same x. With automatic
// layout each table sized its columns to its own content, and the columns
// stepped left and right from one category to the next — the eye could not
// run down "Monthly" across the page. Edit mode keeps automatic layout: its
// cells are controls with their own minimum widths.
const VIEW_COLUMN_WIDTHS = ["22%", "8%", "20%", "12%", "8%", "9%", "10%", "11%"];

/**
 * @param {{
 *   category: CostCategory, rows: BillRow[], totals: GroupTotals, payCadenceLabel: string | null,
 *   editing: boolean, people: Person[], accounts: Account[], locale: string,
 *   onChange: (key: string, patch: Partial<DraftBill>) => void,
 *   onRemove: (key: string) => void,
 *   onOpenBill: (id: string) => void,
 * }} props
 */
function CategoryGroupDesktop({
  category,
  rows,
  totals,
  payCadenceLabel,
  editing,
  people,
  accounts,
  locale,
  onChange,
  onRemove,
  onOpenBill,
}) {
  const headings = editing ? EDIT_HEADINGS : VIEW_HEADINGS;
  const billCount = rows.filter((r) => !r.draft.removed && !isBlankGhost(r.draft)).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
        <h3 className="text-sm font-semibold text-text-muted">{category.name}</h3>
        <div className="flex items-center gap-4 text-xs text-text-muted tabular-nums">
          <span>
            {billCount} bill{billCount === 1 ? "" : "s"}
          </span>
          {totals.perPayCents != null ? (
            <span>
              Per pay{payCadenceLabel ? ` (${payCadenceLabel})` : ""}:{" "}
              <Money value={totals.perPayCents} className="font-medium text-text" />
            </span>
          ) : null}
          <span>
            Per month: <Money value={totals.perMonthCents} className="font-medium text-text" />
          </span>
          <span>
            Per year: <Money value={totals.perYearCents} className="font-medium text-text" />
          </span>
        </div>
      </div>
      <ScrollArea axis="x" className="rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
        <table className={cn("w-full text-sm", !editing && "min-w-208 table-fixed")}>
          {editing ? null : (
            <colgroup>
              {VIEW_COLUMN_WIDTHS.map((width, i) => (
                <col key={i} style={{ width }} />
              ))}
            </colgroup>
          )}
          <thead>
            <tr className="border-b border-border text-left text-xs text-text-muted">
              {headings.map((heading, i) => (
                <th
                  key={heading || `spacer-${i}`}
                  className={cn("px-4 py-3 font-medium", !editing && i >= 4 && "text-right", editing && heading === "Annual" && "text-right")}
                  scope="col"
                >
                  {heading || <span className="sr-only">Actions</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) =>
              editing ? (
                <EditRow
                  key={row.draft.key}
                  row={row}
                  people={people}
                  accounts={accounts}
                  onChange={onChange}
                  onRemove={onRemove}
                  onOpenBill={onOpenBill}
                />
              ) : (
                <ViewRow key={row.draft.key} row={row} people={people} locale={locale} onOpenBill={onOpenBill} />
              ),
            )}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

/**
 * @param {{
 *   category: CostCategory, rows: BillRow[], totals: GroupTotals,
 *   editing: boolean, people: Person[], locale: string,
 *   onChange: (key: string, patch: Partial<DraftBill>) => void,
 *   onRemove: (key: string) => void,
 *   onOpenBill: (id: string) => void,
 * }} props
 */
function CategoryGroupMobile({ category, rows, totals, editing, people, locale, onChange, onRemove, onOpenBill }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        data-touch-target
        aria-expanded={open}
        className="flex items-center justify-between gap-2 rounded-(--radius-control) px-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-1 text-sm font-semibold text-text-muted">
          {open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
          {category.name}
        </span>
        <span className="text-xs text-text-muted tabular-nums">
          <Money value={totals.perMonthCents} className="font-medium text-text" />
          /mo
        </span>
      </button>
      {open ? (
        // Editing, each bill is a small form and earns its own card. Reading,
        // they are rows of one list: eighteen floating cards with eighteen
        // shadows made a category boundary no stronger than a bill boundary.
        <div
          className={cn(
            editing
              ? "flex flex-col gap-2"
              : "flex flex-col divide-y divide-border overflow-hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card)",
          )}
        >
          {rows.map(({ draft, bill, figures, spread, error }) =>
            editing ? (
              <div
                key={draft.key}
                className={cn(
                  "flex flex-col gap-3 rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card)",
                  draft.removed && "opacity-45",
                  isEdited({ draft, bill }) && "bg-warning-soft",
                )}
              >
                <div className="flex items-center gap-2">
                  <Input
                    className="h-9"
                    aria-label="Bill name"
                    placeholder={draft.billId === null ? "Add a bill…" : undefined}
                    value={draft.name}
                    disabled={draft.removed}
                    onChange={(e) => onChange(draft.key, { name: e.target.value })}
                  />
                  {isBlankGhost(draft) ? null : (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className={draft.removed ? undefined : "text-text-muted hover:text-text"}
                      aria-label={draft.removed ? `Keep ${draft.name}` : `Remove ${draft.name || "this row"}`}
                      onClick={() => onRemove(draft.key)}
                    >
                      {draft.removed ? <RotateCcwIcon /> : <XIcon />}
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <MoneyInput
                    className="h-9"
                    aria-label={draft.amountModel === "flat" ? "Amount" : "Base amount"}
                    value={parseMoneyText(draft.amountText)}
                    disabled={draft.removed}
                    onChange={(cents) => onChange(draft.key, { amountText: formatMoneyText(cents) })}
                  />
                  <Select
                    value={draft.frequency}
                    disabled={draft.removed}
                    onValueChange={(v) => onChange(draft.key, { frequency: /** @type {Cadence} */ (v) })}
                  >
                    <SelectTrigger className="h-9 w-full" aria-label="Cadence">
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
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    value={draft.amountModel}
                    disabled={draft.removed}
                    onValueChange={(v) => onChange(draft.key, { amountModel: /** @type {AmountModel} */ (v) })}
                  >
                    <SelectTrigger className="h-9 w-full" aria-label="Amount model">
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
                  {draft.amountModel === "rolling_average" ? (
                    <IntegerInput
                      className="h-9"
                      min={1}
                      aria-label="How many past actuals to average"
                      value={parseDecimalText(draft.rollingWindowText, 0)}
                      disabled={draft.removed}
                      onChange={(n) => onChange(draft.key, { rollingWindowText: formatDecimalText(n, 0) })}
                    />
                  ) : null}
                  {draft.amountModel === "escalating" ? (
                    <PercentInput
                      className="h-9"
                      decimals={4}
                      aria-label="Percent per year"
                      value={parseDecimalText(draft.escalationPctText, 4)}
                      disabled={draft.removed}
                      onChange={(pct) => onChange(draft.key, { escalationPctText: formatDecimalText(pct, 4) })}
                    />
                  ) : null}
                </div>
                <div className="grid grid-cols-2 items-end gap-2">
                  <div className="flex flex-col items-start gap-1">
                    {bill && draft.anchorDate === bill.anchorDate ? <PlaceholderDateBadge bill={bill} /> : null}
                    <DatePicker
                      className="w-full"
                      ariaLabel="A known due date"
                      value={draft.anchorDate}
                      disabled={draft.removed}
                      onChange={(v) => onChange(draft.key, { anchorDate: v })}
                    />
                  </div>
                  <p className="text-right text-sm text-text-muted">
                    {figures ? (
                      <>
                        <Money value={figures.perYearCents} />
                        <span className="text-text-subtle">/yr</span>
                      </>
                    ) : null}
                  </p>
                </div>
                {error ? <InlineError size="xs">{error}</InlineError> : null}
                {draft.billId && draft.amountModel !== "flat" ? (
                  <Button size="sm" variant="outline" className="self-start" onClick={() => onOpenBill(/** @type {string} */ (draft.billId))}>
                    <SlidersHorizontalIcon />
                    {draft.amountModel === "seasonal" ? "Monthly factors" : "Bill history"}
                  </Button>
                ) : null}
              </div>
            ) : (
              <button
                key={draft.key}
                type="button"
                data-touch-target
                className="flex items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)"
                onClick={() => bill && onOpenBill(bill.id)}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                    {draft.name}
                    {draft.amountModel !== "flat" ? (
                      <Badge variant="secondary">{AMOUNT_MODEL_LABELS[draft.amountModel]}</Badge>
                    ) : null}
                    <PlaceholderDateBadge bill={bill} />
                  </span>
                  <span className="text-xs text-text-muted">
                    {personName(people, draft.ownerPersonId)} · {CADENCE_LABELS[draft.frequency]}
                    {figures?.nextDueDate ? ` · next ${formatIsoDate(figures.nextDueDate, locale)}` : ""}
                  </span>
                  <AmountBasis draft={draft} bill={bill} figures={figures} spread={spread} />
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5 text-sm tabular-nums">
                  <span className="font-medium text-text">
                    {figures?.nextAmountCents != null ? <Money value={figures.nextAmountCents} /> : "—"}
                  </span>
                  <span className="text-xs text-text-muted">
                    <Money value={figures?.perMonthCents ?? 0} cadence="mo" />
                  </span>
                </span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One category's bills, as a table on desktop and a stack of cards on a
 * phone, in either view or inline-edit mode.
 *
 * The subtotal beside the heading is the sum of the rows printed underneath
 * it and nothing else — while editing, it is the sum of the *unsaved* rows,
 * so the operator can watch a change to one bill move the category before
 * committing to it.
 *
 * @param {{
 *   category: CostCategory, rows: BillRow[], totals: GroupTotals, payCadenceLabel: string | null,
 *   editing: boolean, people: Person[], accounts: Account[], locale: string,
 *   onChange: (key: string, patch: Partial<DraftBill>) => void,
 *   onRemove: (key: string) => void,
 *   onOpenBill: (id: string) => void,
 *   onAddBill: (categoryId: string) => void,
 * }} props
 */
export function CategoryGroup(props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="hidden md:block">
        <CategoryGroupDesktop {...props} />
      </div>
      <div className="md:hidden">
        <CategoryGroupMobile {...props} />
      </div>
      {props.editing ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start border border-dashed border-border text-text-muted"
          onClick={() => props.onAddBill(props.category.id)}
        >
          <PlusIcon />
          Add another bill to {props.category.name}
        </Button>
      ) : null}
    </div>
  );
}
