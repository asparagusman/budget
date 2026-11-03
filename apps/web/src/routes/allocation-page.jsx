import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useStore } from "zustand";
import { ALLOCATION_SECTIONS, computeAllocation, diffAllocations, equivalent, sumCents } from "@budget/engine";
import {
  AlertTriangleIcon,
  ArrowLeftRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardCopyIcon,
  CopyIcon,
  GripVerticalIcon,
  HistoryIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlusIcon,
  RedoIcon,
  RotateCcwIcon,
  Trash2Icon,
  UndoIcon,
  XIcon,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.jsx";
import { Input } from "@/components/ui/input.jsx";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Textarea } from "@/components/ui/textarea.jsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.jsx";
import { AllocationProportionBar, accountName } from "@/components/allocation-proportion-bar.jsx";
import { DatePicker } from "@/components/date-picker.jsx";
import { Delta } from "@/components/delta.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { PanelSkeleton, SectionsSkeleton } from "@/components/loading.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { FidelityBadge } from "@/components/fidelity-badge.jsx";
import { GoodLifeFidelity } from "@/components/good-life-fidelity.jsx";
import { Money } from "@/components/money.jsx";
import { InlineError, Notice } from "@/components/notice.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { QueryError } from "@/components/query-error.jsx";
import { TopBarAction } from "@/components/topbar-action.jsx";
import { UnallocatedIndicator, isBalanced } from "@/components/unallocated-indicator.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { api } from "@/lib/api.js";
import { copyText } from "@/lib/copy-text.js";
import { ApiError, apiErrorFrom, readApiError } from "@/lib/api-error.js";
import { useFlashOnChange } from "@/lib/motion.js";
import {
  allocationDraftHistory,
  draftLineToEngine,
  draftLinesSignature,
  draftLinesToPayload,
  draftProblems,
  draftStageGoalsToPayload,
  lineValueToText,
  serverLinesSignature,
  useAllocationDraft,
} from "@/lib/allocation-draft.js";
import { registerCommands } from "@/lib/commands.js";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard.js";
import { LG, useMediaQuery } from "@/lib/use-media-query.js";
import { useNumericText } from "@/lib/use-numeric-text.js";
import {
  ALLOCATION_BASES,
  ALLOCATION_BASIS_HINTS,
  ALLOCATION_BASIS_LABELS,
  ALLOCATION_BASIS_VALUE_KIND,
  CADENCE_LABELS,
  CADENCE_PERIOD_NOUNS,
} from "@/lib/constants.js";
import { formatIsoDate, localIsoDate, todayIso } from "@/lib/dates.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";
import { cn } from "@/lib/utils.js";
import { ScrollArea } from "@/components/scroll-area.jsx";
import {
  accountsQueryOptions,
  allocationPlansQueryOptions,
  incomeResolveQueryOptions,
  incomeVariantsQueryOptions,
} from "@/lib/queries.js";

/** @import { AllocationResult, Basis, Cadence, Cents, TransferDelta } from "@budget/engine" */
/** @import { DraftLine, DraftStageGoals, LineProblem } from "@/lib/allocation-draft.js" */

/** @typedef {{ id: string, name: string, sortOrder: number }} Account */
/** @typedef {{ id: string, name: string, incomeVariantId: string, incomeVariantName: string | null, activeVersion: VersionSummary | null, draftVersion: VersionSummary | null, versionCount: number }} Plan */
/** @typedef {{ id: string, version: number, status: "draft" | "active" | "archived", note: string | null, createdAt: string, activatedAt: string | null }} VersionSummary */
/** @typedef {{ id: string, stage: number, label: string, basis: Basis, value: number | null, goalPct: number | null, accountId: string, sortOrder: number }} ServerLine */
/** @typedef {{ stage: number, goalPct: number }} ServerStageGoal */
/**
 * What the standing transfers were set to when a version was applied — the
 * amounts at the bank. Recorded once, at apply, and never recomputed
 * (apps/api/src/lib/allocation.js "Applied amounts").
 *
 * @typedef {{
 *   version: 1, payCadence: Cadence, hasPrimaryPaySchedule: boolean,
 *   computedOn: string, appliedOn: string, grossPerMonthCents: Cents,
 *   transfers: { accountId: string, accountName: string, perPayCents: Cents, perMonthCents: Cents, isNoOp: boolean }[],
 * }} AppliedSnapshot
 */
/** @typedef {{ id: string, planId: string, version: number, status: "draft" | "active" | "archived", basedOnVersionId: string | null, note: string | null, createdBy: string | null, createdByName: string | null, createdAt: string, activatedAt: string | null, lines: ServerLine[], stageGoals: ServerStageGoal[], applied: AppliedSnapshot | null }} Version */
/**
 * The preview's "Current": the amounts recorded when the active version was
 * applied (`source: "applied"`), or — when there are none to compare,
 * `reason` says why — today's recomputation of it. `drift` is live − applied
 * per destination, and only exists for recorded amounts.
 *
 * @typedef {{
 *   source: "applied" | "recomputed",
 *   reason: "not_recorded" | "cadence_changed" | null,
 *   applied: AppliedSnapshot | null,
 *   transfers: { accountId: string, accountName: string | null, perPayCents: Cents, perMonthCents: Cents, isNoOp: boolean }[],
 *   drift: TransferDelta[] | null,
 * }} CurrentTransfers
 */
/**
 * @typedef {{
 *   on: string,
 *   payCadence: Cadence,
 *   hasPrimaryPaySchedule: boolean,
 *   grossPerMonthCents: Cents,
 *   grossPerPayCents: Cents,
 *   fixedTotalPerMonthCents: Cents,
 *   variableEssentialsPerMonthCents: Cents,
 *   variableNonEssentialPerMonthCents: Cents,
 *   incomeLandingAccountId: string | null,
 *   resolvedVariantId: string | null,
 * }} AllocationInputs
 */

const AUTOSAVE_DELAY_MS = 800;

// The cadence every figure on screen is read in. The spreadsheet prints all
// three columns at once; one column and a switch is the same information with
// two thirds less to read past — which is what this screen needed more than it
// needed simultaneity.
/** @type {Cadence[]} */
const VIEW_CADENCES = ["monthly", "fortnightly", "weekly"];

/**
 * One section's figures out of the engine's result. Read, never derived — a
 * section subtotal that disagreed with the rows above it is the exact failure
 * the old fine-print footer was able to hide.
 *
 * @param {AllocationResult} result
 * @param {number} stage
 */
function sectionResult(result, stage) {
  return result.stages.find((s) => s.stage === stage) ?? null;
}

/**
 * A figure in the cadence being viewed. `ResolvedLine` and `StageResult` both
 * carry all three, so this picks one rather than converting.
 *
 * @param {{ perMonthCents: Cents, perPayCents: Cents, perWeekCents: Cents }} figures
 * @param {Cadence} view
 * @param {Cadence} payCadence
 * @returns {Cents}
 */
function inCadence(figures, view, payCadence) {
  // Monthly before per-pay, deliberately: a fortnightly-paid household viewing
  // monthly must get the per-month figure, and `view === payCadence` checked
  // first would hand back the fortnight for every cadence it was asked for.
  if (view === "weekly") return figures.perWeekCents;
  if (view === "monthly") return figures.perMonthCents;
  if (view === payCadence) return figures.perPayCents;
  // Only reachable when the household is paid on some other cadence and the
  // operator asks for fortnightly. `equivalent` is the engine's own — this
  // screen never does cadence arithmetic by hand.
  return equivalent(figures.perMonthCents, "monthly", view);
}

/**
 * Remaining at a stage's *entry* — the figure a `pct_of_remaining` row is
 * computed against, and the one the spreadsheet never showed. A lookup of the
 * previous stage's own remaining (gross for the first), never a subtraction of
 * its own: every number on this screen comes from the engine.
 *
 * @param {AllocationResult} result
 * @param {number} stage
 * @param {AllocationInputs} inputs
 * @param {Cadence} view
 */
function remainingAtStageStart(result, stage, inputs, view) {
  const gross = inCadence(
    {
      perMonthCents: inputs.grossPerMonthCents,
      perPayCents: inputs.grossPerPayCents,
      perWeekCents: equivalent(inputs.grossPerMonthCents, "monthly", "weekly"),
    },
    view,
    inputs.payCadence,
  );
  const index = result.stages.findIndex((s) => s.stage === stage);
  if (index <= 0) return gross;
  const previous = result.stages[index - 1];
  if (!previous) return gross;
  return inCadence(
    {
      perMonthCents: previous.remainingPerMonthCents,
      perPayCents: previous.remainingPerPayCents,
      perWeekCents: previous.remainingPerWeekCents,
    },
    view,
    inputs.payCadence,
  );
}

/**
 * The transfer table's rows: one per destination, current beside new, with the
 * engine's own delta. Actionable destinations first, then the income-landing
 * account — money that stays where it landed is not a transfer to make.
 *
 * `active` is the "was" side — the amounts recorded at the last apply, where
 * there are any — and `draft` the "now" side: the draft being edited, or,
 * with no draft open, the active plan as it resolves today. `recordedNames`
 * names a destination that has since been archived (the live account list
 * no longer carries it) by the name it had when the amounts were recorded.
 *
 * @param {{
 *   active: AllocationResult | null,
 *   draft: AllocationResult | null,
 *   diff: TransferDelta[] | null,
 *   accounts: Account[],
 *   recordedNames?: Map<string, string>,
 * }} args
 */
function buildTransferRows({ active, draft, diff, accounts, recordedNames }) {
  const ids = Array.from(
    new Set([...(active?.transfers ?? []).map((t) => t.accountId), ...(draft?.transfers ?? []).map((t) => t.accountId)]),
  );

  const rows = ids.map((accountId) => {
    const current = active?.transfers.find((t) => t.accountId === accountId) ?? null;
    const next = draft?.transfers.find((t) => t.accountId === accountId) ?? null;
    const delta = diff?.find((d) => d.accountId === accountId) ?? null;
    const live = accounts.some((a) => a.id === accountId);
    return {
      accountId,
      name: live ? accountName(accounts, accountId) : (recordedNames?.get(accountId) ?? accountName(accounts, accountId)),
      currentPerPayCents: current?.perPayCents ?? null,
      newPerPayCents: next?.perPayCents ?? null,
      newPerMonthCents: next?.perMonthCents ?? current?.perMonthCents ?? 0,
      deltaPerPayCents: delta?.deltaPerPayCents ?? null,
      isNoOp: (next ?? current)?.isNoOp ?? false,
      sortOrder: accounts.find((a) => a.id === accountId)?.sortOrder ?? 0,
    };
  });

  return rows.sort((a, b) => Number(a.isNoOp) - Number(b.isNoOp) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** @typedef {ReturnType<typeof buildTransferRows>[number]} TransferRow */

/**
 * Plan selector, the variant it divides, the date being previewed, and what
 * the schedule actually resolves for that date. Editing the "Usual" plan while
 * on parental leave is legitimate — worth knowing, not worth blocking
 * (phases/08-allocation.md "Context bar").
 *
 * It also carries the cadence switch and the balanced tick — both belong to
 * the whole screen rather than to any one section, and the tick is what is
 * left of a 110px card that said "nothing is wrong" (phases/08-allocation.md
 * "The invariant indicator": the full card still appears the moment it is
 * not).
 *
 * @param {{
 *   plans: Plan[], plan: Plan | null, on: string, inputs: AllocationInputs | null,
 *   variantNames: Map<string, string>, view: Cadence, balanced: boolean, hasResult: boolean,
 *   onPlanChange: (id: string) => void, onDateChange: (on: string) => void,
 *   onViewChange: (view: Cadence) => void,
 * }} props
 */
function ContextBar({
  plans,
  plan,
  on,
  inputs,
  variantNames,
  view,
  balanced,
  hasResult,
  onPlanChange,
  onDateChange,
  onViewChange,
}) {
  const resolvedVariantName =
    inputs?.resolvedVariantId != null ? variantNames.get(inputs.resolvedVariantId) ?? null : null;
  const variantMismatch =
    plan !== null && inputs?.resolvedVariantId != null && inputs.resolvedVariantId !== plan.incomeVariantId;

  return (
    <div className="flex flex-col gap-4 rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <FieldRow label="Plan" htmlFor="allocation-plan" className="w-full sm:w-56">
            <Select value={plan?.id ?? ""} onValueChange={onPlanChange}>
              <SelectTrigger id="allocation-plan" className="w-full">
                <SelectValue placeholder="Choose a plan" />
              </SelectTrigger>
              <SelectContent>
                {plans.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Preview on" htmlFor="allocation-on" className="w-44">
            <DatePicker id="allocation-on" value={on} onChange={onDateChange} />
          </FieldRow>
          {/* The spreadsheet's Monthly / Fortnightly / Weekly columns, one at
              a time. All three at once is three times the figures to read
              past, and the pay period is the one the transfers are actually
              made in. */}
          <FieldRow label="Show" htmlFor="allocation-view" className="w-auto">
            <div id="allocation-view" role="group" aria-label="Cadence" className="flex rounded-(--radius-control) bg-surface-muted p-0.5">
              {VIEW_CADENCES.map((cadence) => (
                <button
                  key={cadence}
                  type="button"
                  aria-pressed={view === cadence}
                  onClick={() => onViewChange(cadence)}
                  className={cn(
                    "rounded-[calc(var(--radius-control)-2px)] px-2.5 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)",
                    view === cadence ? "bg-accent-brand-soft text-accent-brand" : "text-text-muted hover:text-text",
                  )}
                >
                  {CADENCE_LABELS[cadence]}
                </button>
              ))}
            </div>
          </FieldRow>
        </div>
        <div className="text-sm">
          {/* Balanced is the resting state, so it is a line of text with a
              tick rather than a card. Anything else and the full indicator
              appears above the sections instead. */}
          {hasResult ? (
            <p className="flex items-center gap-1.5 font-medium text-text-muted">
              {balanced ? (
                <>
                  <CheckIcon className="size-4" aria-hidden="true" />
                  Every dollar allocated
                </>
              ) : (
                <>
                  <AlertTriangleIcon className="size-4 text-warning-strong" aria-hidden="true" />
                  Not balanced — see above
                </>
              )}
            </p>
          ) : null}
          <p className="text-text-muted">
            Income variant: <span className="font-medium text-text">{plan?.incomeVariantName ?? "—"}</span>
          </p>
          <p className="text-text-muted">
            Gross:{" "}
            <span className="font-medium text-text">
              {inputs ? <Money value={inputs.grossPerMonthCents} /> : "—"}
            </span>
            <span className="text-text-subtle"> /month</span>
            {inputs?.hasPrimaryPaySchedule ? (
              <>
                {" · "}
                <span className="font-medium text-text">
                  <Money value={inputs.grossPerPayCents} />
                </span>
                <span className="text-text-subtle"> /{CADENCE_LABELS[inputs.payCadence].toLowerCase()}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>

      {variantMismatch ? (
        <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-text">
          On {formatIsoDate(on, "en-AU")} the schedule resolves to{" "}
          <strong>{resolvedVariantName ?? "a different variant"}</strong>, not this plan&apos;s{" "}
          <strong>{plan?.incomeVariantName}</strong>. The figures below use this plan&apos;s own variant.
        </p>
      ) : null}
    </div>
  );
}

/**
 * @param {{ line: DraftLine, invalid: boolean, onChange: (patch: Partial<DraftLine>) => void }} props
 */
function LineValueInput({ line, invalid, onChange }) {
  const kind = ALLOCATION_BASIS_VALUE_KIND[line.basis];
  // One step is one of whatever the column is counting — a percentage point,
  // a dollar, a share of the sweep — with Shift for ten and Alt for a tenth.
  // A share of gross above 100% is a typo in every basis that uses one.
  const numeric = useNumericText({
    value: line.valueText,
    onChange: (valueText) => onChange({ valueText }),
    step: 1,
    min: 0,
    max: kind === "percent" ? 100 : undefined,
  });

  if (kind === "none") {
    // Nothing to set: the basis beside it already says the amount is a whole
    // total from another screen, so repeating that here would be the same
    // sentence twice in two columns.
    return <span className="text-sm text-text-subtle">—</span>;
  }

  return (
    <InputGroup className="h-8 w-24 min-w-0 @min-[38rem]:w-full">
      {kind === "money" ? (
        <InputGroupAddon>
          <InputGroupText className="text-xs">$</InputGroupText>
        </InputGroupAddon>
      ) : null}
      <InputGroupInput
        aria-label={`${line.label || "Line"} value`}
        aria-invalid={invalid || undefined}
        className="text-right tabular-nums"
        {...numeric}
      />
      {kind === "percent" ? (
        <InputGroupAddon align="inline-end">
          <InputGroupText className="text-xs">%</InputGroupText>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

/** The editor's column template, shared by the header strip and every row so
 * the figures line up the way the spreadsheet's do.
 *
 * The widths are measured rather than chosen: at 1440 with the sidebar open
 * and the transfers rail beside it, a section is ~760px wide, and eight
 * columns only fit if the seven fixed ones stay inside ~600px. Division takes
 * whatever is left and truncates (with a `title`) — a shortened label the
 * operator typed is a far smaller loss than a column of figures they came here
 * to compare being pushed off the edge.
 *
 * A container query, not a media query: what decides whether the table fits is
 * the width of the section, which the collapsible sidebar and the rail both
 * change without the viewport moving at all. Below the threshold a row becomes
 * two stacked lines — sideways scrolling to reach the amount is the same
 * failure at 375px that it was at 1440px, just in the other direction. */
const ROW_GRID = [
  "@min-[38rem]:grid @min-[38rem]:items-center @min-[38rem]:gap-1.5",
  // Eight columns: Division · Basis · Value · Goal % · Actual · Destination ·
  // amount · row menu.
  "@min-[38rem]:grid-cols-[minmax(0,1fr)_7.5rem_5.5rem_4.5rem_3.25rem_6.75rem_5rem_1.5rem]",
  // Nine, when the section is wide enough to also carry Fidelity — collapsing
  // the sidebar is what usually buys it. Below this the goal and the actual
  // are adjacent columns, so the comparison is still right there to read; the
  // pill that spells it out is what goes, not the figures.
  "@min-[52rem]:grid-cols-[minmax(0,1fr)_7.5rem_5.5rem_4.5rem_3.25rem_6.5rem_7.5rem_5rem_1.5rem]",
].join(" ");

/**
 * The column headings, once per section rather than once per row. Every row
 * used to carry its own labels as a hint sentence underneath it, which is how
 * "Fixed-cost total · From totals · Income + Bills" ended up reading as one
 * garbled phrase with no clue which control was the destination.
 *
 * @param {{ readOnly: boolean, cadenceLabel: string }} props
 */
function SectionColumnHeader({ readOnly, cadenceLabel }) {
  return (
    <div className={cn("hidden border-b border-border pb-1.5 text-xs font-medium text-text-subtle", ROW_GRID)}>
      <span className="pl-5">Division</span>
      <span>Basis</span>
      <span className="text-right">Value</span>
      <span className="text-right">Goal %</span>
      <span className="text-right">Actual</span>
      <span className="hidden @min-[52rem]:block">Fidelity</span>
      <span>Destination</span>
      <span className="text-right">/{cadenceLabel}</span>
      {readOnly ? null : <span className="sr-only">Actions</span>}
    </div>
  );
}

/**
 * One editable line, as one row.
 *
 * It was a ~90px card carrying eleven controls and two sentences of hint text,
 * which meant two lines filled a laptop viewport and a ten-line plan was a
 * long scroll through an unlabelled list. The spreadsheet fits the whole plan
 * on one screen and is read fluently; this is that shape — the section header
 * carries what every row in it shares (its heading, its basis hint, its
 * subtotal) and the row carries only what is its own.
 *
 * Drag to reorder (dropping onto a row in another section moves it there), or
 * use the row menu — the same moves without a pointer, since a drag handle
 * alone is not keyboard reachable.
 *
 * `problem` is why the line can't be saved yet ("Needs a value."), shown under
 * the row it belongs to. While any line has one the draft is not autosaved —
 * sending it would only be refused — and the status line above says so.
 *
 * @param {{
 *   line: DraftLine, resolved: AllocationResult["lines"][number] | undefined, accounts: Account[],
 *   view: Cadence, payCadence: Cadence, isDragTarget: boolean, problem: LineProblem | null,
 *   onChange: (patch: Partial<DraftLine>) => void, onRemove: () => void,
 *   onMove: (direction: -1 | 1) => void, onStageChange: (stage: number) => void,
 *   onDragStart: () => void, onDragOver: () => void, onDrop: () => void, onDragEnd: () => void,
 * }} props
 */
function DraftLineRow({
  line,
  resolved,
  accounts,
  view,
  payCadence,
  isDragTarget,
  problem,
  onChange,
  onRemove,
  onMove,
  onStageChange,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}) {
  const [typing, setTyping] = useState(false);
  const injected = ALLOCATION_BASIS_VALUE_KIND[line.basis] === "none";
  const goalNumeric = useNumericText({
    value: line.goalPctText,
    onChange: (goalPctText) => onChange({ goalPctText }),
    step: 1,
    min: 0,
    max: 100,
  });
  // Undo/redo confirmation. Keyed on the line's own stored inputs, and
  // suppressed while this row has focus, so the flash fires exactly when a
  // value here changed WITHOUT the operator touching it — which is what an
  // undo looks like from the row's point of view
  // (phases/11-polish-mobile-import.md, workstream A, "Undo / redo").
  const flashing = useFlashOnChange(
    `${line.stage}|${line.basis}|${line.valueText}|${line.goalPctText}|${line.accountId}|${line.label}`,
    { enabled: !typing },
  );

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      // Focus-within, tracked in state rather than read from CSS, because it
      // gates the tween below: this row's own figure must not count up to each
      // keystroke while the operator is typing the percentage that drives it.
      // Every OTHER row still tweens, which is the whole point — you see which
      // lines your change moved.
      onFocusCapture={() => setTyping(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setTyping(false);
      }}
      className={cn(
        "group flex flex-col gap-2 rounded-(--radius-control) px-1 py-1.5 hover:bg-surface-muted",
        ROW_GRID,
        isDragTarget && "outline-2 -outline-offset-2 outline-(--accent)",
        flashing && "animate-row-flash",
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        <GripVerticalIcon
          className="hidden size-4 shrink-0 cursor-grab text-text-subtle opacity-0 group-hover:opacity-100 @min-[38rem]:block"
          aria-hidden="true"
        />
        <Input
          aria-label="Division"
          aria-invalid={problem?.field === "label" || undefined}
          className="h-8 min-w-0 flex-1"
          value={line.label}
          placeholder="Division"
          title={line.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 @min-[38rem]:contents">
        {injected ? (
          // Nothing to choose: the amount is the whole fixed-cost or essentials
          // total, maintained on the screen that owns it. Stated, with a
          // tooltip saying where from, rather than offered as a control the
          // operator can only put back the way they found it.
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="truncate text-xs text-text-muted underline decoration-dotted underline-offset-2">
                {ALLOCATION_BASIS_LABELS[line.basis]}
              </span>
            </TooltipTrigger>
            <TooltipContent>{ALLOCATION_BASIS_HINTS[line.basis]}</TooltipContent>
          </Tooltip>
        ) : (
          <Select value={line.basis} onValueChange={(v) => onChange({ basis: /** @type {Basis} */ (v) })}>
            <SelectTrigger
              className="h-8 w-34 min-w-0 @min-[38rem]:w-full"
              aria-label="Basis"
              aria-invalid={problem?.field === "basis" || undefined}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALLOCATION_BASES.map((basis) => (
                <SelectItem key={basis} value={basis}>
                  {ALLOCATION_BASIS_LABELS[basis]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <LineValueInput line={line} invalid={problem?.field === "value"} onChange={onChange} />

        <InputGroup className="h-8 w-20 min-w-0 @min-[38rem]:w-full">
          <InputGroupInput
            aria-label="Goal percent of gross"
            aria-invalid={problem?.field === "goal" || undefined}
            className="text-right tabular-nums"
            {...goalNumeric}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText className="text-xs">%</InputGroupText>
          </InputGroupAddon>
        </InputGroup>

        {/* Actual share of gross beside how far that is from the goal — the
            sheet's two columns, together because neither reads without the
            other. */}
        <span className="text-xs text-text-muted tabular-nums @min-[38rem]:text-right">
          {resolved?.actualPct != null ? `${resolved.actualPct.toFixed(1)}%` : "—"}
        </span>
        <span className="hidden min-w-0 overflow-hidden @min-[52rem]:block">
          {resolved?.fidelity != null ? (
            <FidelityBadge fidelity={resolved.fidelity} goalPct={Number(line.goalPctText)} compact />
          ) : null}
        </span>

        <Select value={line.accountId} onValueChange={(v) => onChange({ accountId: v })}>
          <SelectTrigger
            className="h-8 w-34 min-w-0 @min-[38rem]:w-full"
            aria-label="Destination"
            aria-invalid={problem?.field === "destination" || undefined}
          >
            <SelectValue placeholder="Destination" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <p
          className={cn(
            "ml-auto font-semibold tabular-nums @min-[38rem]:text-right",
            // No bank transfer can be negative: a line resolving below zero
            // is the plan committing more than it has, flagged on the row it
            // happens in as well as in the indicator above.
            resolved && resolved.perMonthCents < 0 ? "text-warning-strong" : "text-text",
          )}
        >
          {resolved ? <Money value={inCadence(resolved, view, payCadence)} tween={!typing} /> : "—"}
        </p>

        <RowMenu line={line} onMove={onMove} onStageChange={onStageChange} onRemove={onRemove} />
      </div>

      {problem ? (
        // The whole width of the row in the wide grid, so the reason sits
        // under the fields it is about rather than squeezed into a column.
        <InlineError size="xs" className="@min-[38rem]:col-span-full @min-[38rem]:pl-5">
          {problem.message} Changes are saved once it&apos;s fixed.
        </InlineError>
      ) : null}
    </div>
  );
}

/**
 * Reorder, move to another section, delete. In a menu rather than four
 * always-visible controls: they are the rarest things done to a row and were
 * costing a third of its width.
 *
 * @param {{
 *   line: DraftLine, onMove: (direction: -1 | 1) => void,
 *   onStageChange: (stage: number) => void, onRemove: () => void,
 * }} props
 */
function RowMenu({ line, onMove, onStageChange, onRemove }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          aria-label={`Actions for ${line.label || "this line"}`}
        >
          <MoreVerticalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onMove(-1)}>
          <ChevronUpIcon />
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onMove(1)}>
          <ChevronDownIcon />
          Move down
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Move to section</DropdownMenuLabel>
        {ALLOCATION_SECTIONS.filter((section) => section.stage !== line.stage).map((section) => (
          <DropdownMenuItem key={section.stage} onSelect={() => onStageChange(section.stage)}>
            {section.letter} · {section.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRemove}>
          <Trash2Icon />
          Remove line
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The same row with no draft open: the applied version, stated rather than
 * offered for editing. A screen full of disabled inputs would say "broken"
 * where this says "this is what's live — open a draft to change it".
 *
 * @param {{
 *   line: DraftLine, resolved: AllocationResult["lines"][number] | undefined, accounts: Account[],
 *   view: Cadence, payCadence: Cadence,
 * }} props
 */
function AppliedLineRow({ line, resolved, accounts, view, payCadence }) {
  const kind = ALLOCATION_BASIS_VALUE_KIND[line.basis];
  const valueText =
    line.valueText === ""
      ? "—"
      : kind === "percent"
        ? `${line.valueText}%`
        : kind === "money"
          ? `$${line.valueText}/mo`
          : kind === "weight"
            ? `×${line.valueText}`
            : "—";

  // Below the container threshold the same cells reflow into two lines: the
  // division and its amount, then how it is worked out and where it goes —
  // "6.5% of gross → Raiz", with goal and actual labelled on the right. In a
  // flat run of seven unlabelled figures ("% of gross 6.5% 10% 6.5% Raiz"),
  // nobody could tell the value from the goal from the actual. `order` does
  // the reflow so the DOM — and the wide grid — keep the column order.
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 py-2 text-sm", ROW_GRID)}>
      <p className="order-1 min-w-0 flex-1 truncate font-medium text-text @min-[38rem]:order-none @min-[38rem]:pl-5">
        {line.label || "Untitled line"}
      </p>
      <div className="contents text-xs text-text-muted">
        <span className="order-4 truncate @min-[38rem]:order-none">{ALLOCATION_BASIS_LABELS[line.basis]}</span>
        <span
          className={cn(
            "order-5 tabular-nums @min-[38rem]:order-none @min-[38rem]:text-right",
            // A basis with no value of its own ("Fixed-cost total") reads
            // fine without a dash after it on one line.
            valueText === "—" && "@max-[38rem]:hidden",
          )}
        >
          {valueText}
        </span>
        <span className="order-8 ml-auto tabular-nums @min-[38rem]:order-none @min-[38rem]:ml-0 @min-[38rem]:text-right">
          {/* Narrow: goal and actual as one unit, so a long destination
              wraps them to the next line together rather than splitting
              "goal 10%" from its "actual 6.5%". */}
          <span className="whitespace-nowrap @min-[38rem]:hidden">
            {line.goalPctText === "" ? null : `goal ${line.goalPctText}% · `}
            actual {resolved?.actualPct != null ? `${resolved.actualPct.toFixed(1)}%` : "—"}
          </span>
          <span className="hidden @min-[38rem]:inline">{line.goalPctText === "" ? "—" : `${line.goalPctText}%`}</span>
        </span>
        <span className="hidden tabular-nums @min-[38rem]:block @min-[38rem]:text-right">
          {resolved?.actualPct != null ? `${resolved.actualPct.toFixed(1)}%` : "—"}
        </span>
        <span className="min-w-0 overflow-hidden @max-[52rem]:hidden">
          {resolved?.fidelity != null ? (
            <FidelityBadge fidelity={resolved.fidelity} goalPct={Number(line.goalPctText)} compact />
          ) : null}
        </span>
        <span className="order-6 min-w-0 truncate @min-[38rem]:order-none" title={accountName(accounts, line.accountId)}>
          <span aria-hidden="true" className="@min-[38rem]:hidden">→ </span>
          {accountName(accounts, line.accountId)}
        </span>
        <span className="order-2 shrink-0 text-sm font-semibold text-text tabular-nums @min-[38rem]:order-none @min-[38rem]:text-right">
          {resolved ? <Money value={inCadence(resolved, view, payCadence)} /> : "—"}
        </span>
      </div>
      {/* Line break for the narrow layout only; not a cell of the wide grid. */}
      <span aria-hidden="true" className="order-3 basis-full @min-[38rem]:hidden" />
    </div>
  );
}

/**
 * One of the three sections, with the running totals that break the plan up.
 *
 * The spreadsheet's structure is its meaning: **what we must pay → what we
 * choose to set aside → what's left**, with a Subtotal and a Remaining row
 * between each. The editor used to call these "Stage 1/2/3", put the sheet's
 * own headings in a free-text field on every row, and compress both running
 * totals into a single line of 12px text. This is that structure restored —
 * the heading names the section, and the footer states the two figures the
 * sheet gives whole rows to.
 *
 * @param {{
 *   section: (typeof ALLOCATION_SECTIONS)[number], lines: DraftLine[], result: AllocationResult,
 *   inputs: AllocationInputs, accounts: Account[], view: Cadence, readOnly: boolean,
 *   goalText: string, dragTargetId: string | null,
 *   problems: ReturnType<typeof draftProblems> | null,
 *   onGoalChange: (text: string) => void,
 *   onChange: (id: string, patch: Partial<DraftLine>) => void, onRemove: (id: string) => void,
 *   onMove: (id: string, direction: -1 | 1) => void, onStageChange: (id: string, stage: number) => void,
 *   onAddLine: () => void,
 *   onDragStart: (id: string) => void, onDragOver: (id: string) => void, onDrop: (id: string) => void,
 *   onDragEnd: () => void,
 *   footer?: import("react").ReactNode,
 * }} props
 */
function SectionCard({
  section,
  lines,
  result,
  inputs,
  accounts,
  view,
  readOnly,
  goalText,
  dragTargetId,
  problems,
  onGoalChange,
  onChange,
  onRemove,
  onMove,
  onStageChange,
  onAddLine,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  footer,
}) {
  const stage = sectionResult(result, section.stage);
  const goalProblem = problems?.byStage.get(section.stage) ?? null;
  const cadenceLabel = CADENCE_LABELS[view].toLowerCase();
  const entryRemaining = remainingAtStageStart(result, section.stage, inputs, view);
  // Stated only where it changes an amount — `pct_of_remaining` and `sweep`
  // resolve against it, nothing else does, and on the other sections it is
  // one more figure to read past (phases/08-allocation.md "Stage editor").
  const hasRemainingBasis = lines.some((l) => l.basis === "pct_of_remaining" || l.basis === "sweep");
  const resolvedById = new Map(result.lines.map((l) => [l.lineId, l]));
  const goalNumeric = useNumericText({ value: goalText, onChange: onGoalChange, step: 1, min: 0, max: 100 });

  return (
    <section className="@container flex flex-col gap-3 rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5">
      {/* The goal stays in the header's top-right at every width; stacked
          under the blurb on a phone it read as one more line of the
          description. */}
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-baseline gap-2 text-base font-semibold text-text">
            <span className="text-text-subtle">{section.letter}</span>
            {section.name}
          </h2>
          <p className="text-xs text-text-muted">{section.blurb}</p>
          {hasRemainingBasis ? (
            <p className="mt-0.5 text-xs text-text-subtle">
              Dividing <Money value={entryRemaining} tween className="font-medium text-text-muted" /> — what{" "}
              {section.stage === 1 ? "income" : "the section above"} leaves.
            </p>
          ) : null}
        </div>

        {/* The section's own Goal %, which the sheet puts on this row and the
            app previously had nowhere to put. Editable here; when it's blank
            the sum of the section's lines' goals stands in, and the footer
            says which of the two is being read. */}
        <div className="flex shrink-0 items-center gap-2">
          <label className="text-xs text-text-muted" htmlFor={`section-goal-${section.stage}`}>
            Goal
          </label>
          {readOnly ? (
            <span className="text-sm font-medium text-text tabular-nums">
              {stage?.goalPct != null ? `${stage.goalPct}%` : "—"}
            </span>
          ) : (
            <InputGroup className="h-8 w-20">
              <InputGroupInput
                id={`section-goal-${section.stage}`}
                aria-label={`${section.name} goal percent of income`}
                aria-invalid={goalProblem !== null || undefined}
                className="text-right tabular-nums"
                {...goalNumeric}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText className="text-xs">%</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
          )}
        </div>
      </header>

      {goalProblem ? (
        <InlineError size="xs" className="-mt-1 justify-end">
          Section goal: {goalProblem} Changes are saved once it&apos;s fixed.
        </InlineError>
      ) : null}

      {lines.length > 0 ? <SectionColumnHeader readOnly={readOnly} cadenceLabel={cadenceLabel} /> : null}

      <div className="flex flex-col divide-y divide-border @min-[38rem]:divide-y-0">
        {lines.map((line) =>
          readOnly ? (
            <AppliedLineRow
              key={line.id}
              line={line}
              resolved={resolvedById.get(line.id)}
              accounts={accounts}
              view={view}
              payCadence={inputs.payCadence}
            />
          ) : (
            <DraftLineRow
              key={line.id}
              line={line}
              resolved={resolvedById.get(line.id)}
              accounts={accounts}
              view={view}
              payCadence={inputs.payCadence}
              isDragTarget={dragTargetId === line.id}
              problem={problems?.byLine.get(line.id) ?? null}
              onChange={(patch) => onChange(line.id, patch)}
              onRemove={() => onRemove(line.id)}
              onMove={(direction) => onMove(line.id, direction)}
              onStageChange={(next) => onStageChange(line.id, next)}
              onDragStart={() => onDragStart(line.id)}
              onDragOver={() => onDragOver(line.id)}
              onDrop={() => onDrop(line.id)}
              onDragEnd={onDragEnd}
            />
          ),
        )}
        {lines.length === 0 ? (
          <p className="px-1 py-3 text-sm text-text-muted">
            Nothing in this section yet.
            {section.stage === 1 ? " Add the fixed-cost and essentials totals to start." : null}
          </p>
        ) : null}
      </div>

      {stage ? (
        <SectionTotals
          section={section}
          stage={stage}
          view={view}
          payCadence={inputs.payCadence}
          cadenceLabel={cadenceLabel}
        />
      ) : null}

      {footer}

      {readOnly ? null : (
        <div>
          <Button size="sm" variant="outline" onClick={onAddLine}>
            <PlusIcon />
            Add a line
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * What the Leftover section is for, said on the section itself.
 *
 * Two things used to sit at the bottom of the side panel, three scrolls away
 * from the figure they describe:
 *
 * - The Good Life benchmark. Non-essential variable costs are never deducted
 *   (`07-variable-costs.md`: "the one thing in this phase that must not be got
 *   wrong") — they are compared against whatever is left, which is this pool.
 *   The wording goes through the shared `<GoodLifeFidelity>` because its sign
 *   is easy to get backwards.
 * - Where the pool actually lands. The operator's own description of this
 *   section: *"whatever is leftover is added to the spending amount, as you
 *   see, to total an amount to send to our daily transactions account."* That
 *   combined figure is the engine's own transfer for the account — never the
 *   two halves re-added here.
 *
 * And it states what the section is, because it is the one section that is not
 * an instruction: *"less about allocating, more about gauging how much is
 * theoretically left for each at that point."*
 *
 * @param {{
 *   result: AllocationResult, inputs: AllocationInputs, accounts: Account[],
 *   lines: DraftLine[], view: Cadence, editing: boolean,
 * }} props
 */
function LeftoverNotes({ result, inputs, accounts, lines, view, editing }) {
  const cadenceLabel = CADENCE_LABELS[view].toLowerCase();
  // The destinations this section feeds, and the whole transfer each one gets
  // — which for the day-to-day account includes the essentials line from
  // section A, and that total is the point.
  const destinationIds = Array.from(new Set(lines.map((l) => l.accountId)));
  const destinations = destinationIds.flatMap((accountId) => {
    const transfer = result.transfers.find((t) => t.accountId === accountId);
    if (!transfer) return [];
    const alsoFedByOtherSections = transfer.lineIds.some((id) => !lines.some((l) => l.id === id));
    return [
      {
        accountId,
        name: accountName(accounts, accountId),
        alsoFedByOtherSections,
        cents: inCadence(
          {
            perMonthCents: transfer.perMonthCents,
            perPayCents: transfer.perPayCents,
            perWeekCents: equivalent(transfer.perMonthCents, "monthly", "weekly"),
          },
          view,
          inputs.payCadence,
        ),
      },
    ];
  });

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-muted p-3 text-sm">
      {editing ? (
        <p className="text-text-muted">
          Nothing is set aside here — this is what&apos;s left once needs and goals are met. The splits are a
          gauge of how much of it each thing has, not a rule: if{" "}
          {lines[0]?.label ? <span className="text-text">{lines[0].label.toLowerCase()}</span> : "one of them"} is
          more than you meant, move the numbers — or enjoy it.
        </p>
      ) : null}

      {destinations.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {destinations.map((destination) => (
            <li key={destination.accountId} className="text-text">
              <Money value={destination.cents} tween className="font-semibold" />
              <span className="text-xs text-text-subtle">/{cadenceLabel}</span> goes to{" "}
              <span className="font-medium">{destination.name}</span>
              {destination.alsoFedByOtherSections ? (
                <span className="text-text-muted"> — this pool together with what the sections above send it</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-text">
        <GoodLifeFidelity
          cents={result.goodLifeFidelityCents}
          targetPerMonthCents={inputs.variableNonEssentialPerMonthCents}
        />
      </p>
    </div>
  );
}

/**
 * The sheet's two Running Totals rows: Subtotal, then what's left after it.
 *
 * They were a single sentence of 12px text — *"Stage 1 subtotal
 * $2,321.83/fortnightly no goal set — type one in a line's Goal % field actual
 * 59.88% left $1,555.85"* — which is every figure the sheet gives two whole
 * rows to, run together in one line with no columns to read them against.
 *
 * The last section has nothing after it, so its "left" row is `Unallocated`
 * instead: at that point what remains is either exactly zero or a number the
 * operator has to fix, and calling it "left" would make a defect sound like a
 * result.
 *
 * @param {{
 *   section: (typeof ALLOCATION_SECTIONS)[number],
 *   stage: import("@budget/engine").StageResult,
 *   view: Cadence, payCadence: Cadence, cadenceLabel: string,
 * }} props
 */
function SectionTotals({ section, stage, view, payCadence, cadenceLabel }) {
  const isLast = section.stage === ALLOCATION_SECTIONS[ALLOCATION_SECTIONS.length - 1]?.stage;
  const subtotal = inCadence(
    { perMonthCents: stage.subtotalPerMonthCents, perPayCents: stage.subtotalPerPayCents, perWeekCents: stage.subtotalPerWeekCents },
    view,
    payCadence,
  );
  const remaining = inCadence(
    { perMonthCents: stage.remainingPerMonthCents, perPayCents: stage.remainingPerPayCents, perWeekCents: stage.remainingPerWeekCents },
    view,
    payCadence,
  );

  // A ledger: labels left, figures right — under the amount column of the
  // rows above, so a subtotal reads as the sum of the figures over it. The
  // right padding at the wide layout is the row menu column plus its gap.
  return (
    <dl className="flex flex-col gap-1.5 border-t border-border pt-3 text-sm @min-[38rem]:pr-8.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1">
        <dt className="font-medium text-text">Subtotal</dt>
        <dd className="text-right font-semibold text-text tabular-nums">
          <Money value={subtotal} tween />
          <span className="text-xs font-normal text-text-subtle">/{cadenceLabel}</span>
        </dd>
        <dd className="col-span-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-text-muted">
          <span className="tabular-nums">
            {stage.actualPct != null ? `${stage.actualPct.toFixed(1)}% of income` : "—"}
          </span>
          <span aria-hidden="true">·</span>
          {stage.goalPct != null ? (
            <>
              <span>
                goal {stage.goalPct}%
                {/* A percentage is not a figure anyone recognises against
                    their own pay, so the goal is answered in money too. Both
                    come from the engine. */}
                {stage.goalPerMonthCents != null ? (
                  <>
                    {" = "}
                    <Money
                      value={inCadence(
                        {
                          perMonthCents: stage.goalPerMonthCents,
                          perPayCents: stage.goalPerPayCents ?? stage.goalPerMonthCents,
                          perWeekCents: equivalent(stage.goalPerMonthCents, "monthly", "weekly"),
                        },
                        view,
                        payCadence,
                      )}
                      tween
                    />
                  </>
                ) : null}
              </span>
              {/* Summed from the lines is a different claim from set on the
                  section, and the operator can only edit one of them — so the
                  screen says which it is rather than letting a derived total
                  pass for something typed. */}
              {stage.goalSource === "lines" ? <span className="text-text-subtle">(from lines)</span> : null}
            </>
          ) : (
            <span className="text-text-subtle">no goal set</span>
          )}
          {stage.fidelity != null ? <FidelityBadge fidelity={stage.fidelity} goalPct={stage.goalPct} /> : null}
        </dd>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
        <dt className="text-text-muted">{isLast ? "Unallocated" : "Left after this"}</dt>
        <dd className="text-right font-medium text-text tabular-nums">
          <Money value={remaining} tween />
          <span className="text-xs font-normal text-text-subtle">/{cadenceLabel}</span>
        </dd>
      </div>
    </dl>
  );
}

/**
 * One destination in the transfer list. Its own component purely so it can
 * hold the flash hook: the two standing orders that actually need editing
 * are the whole point of this panel, and a row that visibly reacts when its
 * number moves is how the operator finds them without re-reading the list
 * (phases/11-polish-mobile-import.md, workstream A).
 *
 * Keyed on the per-pay amount, not on the row identity — the row is there
 * either way; what is worth announcing is the figure changing.
 *
 * With no draft open the same "was → now" shape says something else: the
 * amount applied to the bank against what the plan resolves to today, so a
 * row reads "bank order $X" rather than "was $X".
 *
 * @param {{ row: TransferRow, editing: boolean, onCopy: (cents: Cents) => void }} props
 */
function TransferRowItem({ row, editing, onCopy }) {
  const changed = !row.isNoOp && row.deltaPerPayCents !== null && row.deltaPerPayCents !== 0;
  const amount = row.newPerPayCents ?? row.currentPerPayCents;
  const flashing = useFlashOnChange(row.newPerPayCents);

  return (
    <li
      className={cn(
        "flex flex-col gap-0.5 py-2",
        changed && "-mx-2 rounded-(--radius-control) bg-warning-soft px-2",
        flashing && "animate-row-flash",
      )}
    >
      {/* Name and amount on one line, the per-month/was/delta trail on its
          own beneath. It used to be two side-by-side columns with the right
          one `shrink-0` and `whitespace-nowrap`, so on a changed row the
          "was $563.91 −$140.98" trail claimed the width and the account name
          — the one thing identifying which standing order to go and edit —
          truncated to a single letter. */}
      <div className="flex items-baseline justify-between gap-2">
        <p
          className={cn("min-w-0 truncate text-sm font-medium", row.isNoOp ? "text-text-muted" : "text-text")}
          title={row.name}
        >
          {row.name}
        </p>
        <p className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          <span className={cn("text-sm font-semibold", row.isNoOp ? "text-text-muted" : "text-text")}>
            {amount !== null ? <Money value={amount} tween /> : "—"}
          </span>
          {amount !== null ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={`Copy ${row.name} amount`}
                  onClick={() => onCopy(amount)}
                >
                  <CopyIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy {(amount / 100).toFixed(2)}</TooltipContent>
            </Tooltip>
          ) : null}
        </p>
      </div>

      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-subtle">
        {row.isNoOp ? <span>no move required</span> : editing && !changed ? <span>unchanged</span> : null}
        <span className="ml-auto">
          <Money value={row.newPerMonthCents} tween />
          /month
        </span>
        {changed && row.currentPerPayCents !== null ? (
          <>
            <span>
              {editing ? "was" : "bank order"} <Money value={row.currentPerPayCents} />
            </span>
            <Delta value={row.deltaPerPayCents ?? 0} kind="cents" />
          </>
        ) : null}
      </p>
    </li>
  );
}

/**
 * The reason this screen exists: what every standing bank order should be set
 * to. Exact cents, copyable, with the unchanged rows visibly quiet so only the
 * ones that need editing draw the eye.
 *
 * Two columns rather than four (destination, then the amount with its own
 * before-and-after stacked under it): this panel is 400px on a laptop and the
 * full width of a phone, and a Destination/Current/New/Change table clips the
 * change — the one column the operator is here to read — at both sizes.
 *
 * `current` says what "was" is: the amounts recorded when the active version
 * was applied — what the bank holds — or, when there are none to compare,
 * today's figures for it and why.
 *
 * @param {{
 *   rows: TransferRow[], inputs: AllocationInputs, editing: boolean, totalPerPayCents: Cents,
 *   current: CurrentTransfers | null,
 * }} props
 */
function TransfersPanel({ rows, inputs, editing, totalPerPayCents, current }) {
  const { currency, locale } = useSettings();
  const cadenceLabel = inputs.hasPrimaryPaySchedule ? CADENCE_LABELS[inputs.payCadence].toLowerCase() : "month";
  const reconciles = totalPerPayCents === inputs.grossPerPayCents;
  const actionable = rows.filter((r) => !r.isNoOp && r.deltaPerPayCents !== null && r.deltaPerPayCents !== 0);
  const appliedOn = current?.applied ? formatIsoDate(current.applied.appliedOn, locale) : null;

  /** @param {Cents} cents */
  async function copyAmount(cents) {
    // Exactly what gets typed into the bank: no symbol, no thousands
    // separator (phases/08-allocation.md "Acceptance criteria").
    try {
      await copyText((cents / 100).toFixed(2));
      toast.success("Amount copied.");
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">Standing transfers</h3>
        {editing ? (
          <p className="text-xs text-text-muted">
            {actionable.length} to change
          </p>
        ) : null}
      </div>

      {/* What "was" is measured against, said once above the rows. The bank
          does not move when a bill or an income line does, so the amounts
          recorded at apply are the honest baseline — and when there are none
          to compare, the screen says so rather than passing today's figures
          off as what was applied. */}
      {!editing && current?.source === "applied" && actionable.length > 0 ? (
        <Notice compact>
          {actionable.length === 1 ? "One standing order no longer matches" : `${actionable.length} standing orders no longer match`}{" "}
          this plan — bills or income have moved since it was applied on {appliedOn}. Update{" "}
          {actionable.length === 1 ? "it" : "them"} at the bank, or edit and apply the plan to record the new amounts.
        </Notice>
      ) : current?.reason === "cadence_changed" && current.applied ? (
        <Notice compact>
          The amounts applied on {appliedOn} were {CADENCE_LABELS[current.applied.payCadence].toLowerCase()} amounts,
          but pay is now {CADENCE_LABELS[inputs.payCadence].toLowerCase()}, so they can&apos;t be compared.{" "}
          {editing ? "Applying this draft" : "Applying the plan again"} records amounts in the new cadence.
        </Notice>
      ) : current?.reason === "not_recorded" ? (
        <p className="text-xs text-text-muted">
          This plan was applied before transfer amounts were recorded, so{" "}
          {editing ? "“was” is today's figure for it" : "these are today's figures for it"}. The next apply records
          them.
        </p>
      ) : editing && current?.source === "applied" ? (
        <p className="text-xs text-text-muted">“Was” is what was applied on {appliedOn} — what the bank holds.</p>
      ) : null}

      <ul className="flex flex-col divide-y divide-border">
        {rows.map((row) => (
          <TransferRowItem key={row.accountId} row={row} editing={editing} onCopy={copyAmount} />
        ))}
        <li className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
          <span className="text-xs font-medium text-text-muted">Total, per {cadenceLabel}</span>
          <span className="text-sm font-semibold text-text">
            <Money value={totalPerPayCents} tween />
          </span>
        </li>
      </ul>

      {reconciles ? (
        <p className="text-xs text-text-muted">
          Reconciles exactly to gross income of {formatMoney(inputs.grossPerPayCents, { currency, locale })} per{" "}
          {cadenceLabel}.
        </p>
      ) : (
        <Notice compact>
          Transfers total {formatMoney(totalPerPayCents, { currency, locale })} but gross income is{" "}
          {formatMoney(inputs.grossPerPayCents, { currency, locale })}. That&apos;s a bug — please report it.
        </Notice>
      )}
    </div>
  );
}

/**
 * The side panel: the standing transfers, and the shape of the division.
 *
 * It also held a "By category" list and a pie. Both were the section
 * subtotals restated — the sections now carry their own totals, goals and
 * fidelity, so a second copy beside them was two readings of one figure and
 * a screenful of height for no new information.
 *
 * @param {{
 *   rows: TransferRow[], inputs: AllocationInputs, editing: boolean, result: AllocationResult,
 *   accounts: Account[], totalPerPayCents: Cents, current: CurrentTransfers | null,
 * }} props
 */
function PreviewPanel({ rows, inputs, editing, result, accounts, totalPerPayCents, current }) {
  return (
    <div className="flex flex-col gap-6">
      <TransfersPanel
        rows={rows}
        inputs={inputs}
        editing={editing}
        totalPerPayCents={totalPerPayCents}
        current={current}
      />
      <AllocationProportionBar result={result} accounts={accounts} />
    </div>
  );
}

/**
 * Mobile preview. Deliberately not a modal sheet: it has to be peekable while
 * a field is being edited, and a focus trap would take the operator out of the
 * input they're typing in (phases/08-allocation.md "Layout").
 *
 * @param {{ open: boolean, onToggle: () => void, summary: import("react").ReactNode, children: import("react").ReactNode }} props
 */
function MobilePreviewDrawer({ open, onToggle, summary, children }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 px-2 lg:hidden">
      <div className="mx-auto max-w-2xl overflow-hidden rounded-t-(--radius-card) border border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-(--shadow-raised)">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)"
        >
          <span className="min-w-0 text-sm">{summary}</span>
          {open ? (
            <ChevronDownIcon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
          ) : (
            <ChevronUpIcon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
          )}
        </button>
        {open ? (
          <ScrollArea className="max-h-[55vh] border-t border-border">
            <div className="px-4 py-4">{children}</div>
          </ScrollArea>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What one version set the standing transfers to when it was applied — the
 * record, by the names the accounts had then, not a recomputation.
 *
 * @param {{ snapshot: AppliedSnapshot }} props
 */
function AppliedAmounts({ snapshot }) {
  const { locale } = useSettings();
  const cadence = snapshot.hasPrimaryPaySchedule ? CADENCE_PERIOD_NOUNS[snapshot.payCadence][0] : "month";
  const orders = snapshot.transfers.filter((t) => !t.isNoOp);

  return (
    <div className="flex w-full flex-col gap-1.5 rounded-lg bg-surface-muted p-3 text-xs">
      <p className="text-text-muted">
        Applied {formatIsoDate(snapshot.appliedOn, locale)}
        {snapshot.computedOn !== snapshot.appliedOn
          ? `, with the figures for ${formatIsoDate(snapshot.computedOn, locale)}`
          : ""}{" "}
        · per {cadence}
      </p>
      {orders.length === 0 ? (
        <p className="text-text-muted">No standing transfers — everything stayed in the income account.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {orders.map((transfer) => (
            <li key={transfer.accountId} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-text">{transfer.accountName}</span>
              <span className="shrink-0 font-medium text-text tabular-nums">
                <Money value={transfer.perPayCents} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * @param {{
 *   versions: Version[], accounts: Account[], activeVersionId: string | null,
 *   onRevert: (versionId: string) => void, reverting: boolean,
 * }} props
 */
function VersionHistory({ versions, accounts, activeVersionId, onRevert, reverting }) {
  const { locale } = useSettings();
  const [compare, setCompare] = useState(/** @type {[string, string] | null} */ (null));
  // The version whose applied amounts are open — one at a time, so the list
  // stays a list.
  const [amountsFor, setAmountsFor] = useState(/** @type {string | null} */ (null));

  const left = compare ? versions.find((v) => v.id === compare[0]) ?? null : null;
  const right = compare ? versions.find((v) => v.id === compare[1]) ?? null : null;

  return (
    <section className="flex flex-col gap-3 rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5">
      <div className="flex items-center gap-2">
        <HistoryIcon className="size-4 text-text-muted" aria-hidden="true" />
        <h2 className="text-base font-semibold text-text">Version history</h2>
      </div>

      <ol className="flex flex-col divide-y divide-border">
        {versions.map((version) => (
          <li key={version.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium text-text">
                v{version.version}
                <Badge
                  variant={
                    version.status === "active" ? "default" : version.status === "draft" ? "attention" : "outline"
                  }
                >
                  {version.status}
                </Badge>
                <span className="text-xs font-normal text-text-muted">{version.lines.length} lines</span>
              </p>
              {/* Local dates. The timestamps are UTC, and the first ten
                  characters of one are the UTC date — in Sydney, yesterday
                  for anything done before mid-morning. */}
              <p className="text-xs text-text-muted">
                {version.createdByName ?? "Seeded"} · {formatIsoDate(localIsoDate(version.createdAt), locale)}
                {version.activatedAt ? ` · applied ${formatIsoDate(localIsoDate(version.activatedAt), locale)}` : ""}
                {version.note ? ` · ${version.note}` : ""}
              </p>
            </div>
            {/* `ml-auto`: when the row wraps on a phone, the actions keep to
                the right edge they sit on everywhere else. */}
            <div className="ml-auto flex items-center gap-2">
              {version.applied ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={amountsFor === version.id}
                  onClick={() => setAmountsFor((open) => (open === version.id ? null : version.id))}
                >
                  Amounts
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const other = versions.find((v) => v.id !== version.id);
                  setCompare(other ? [version.id, other.id] : null);
                }}
              >
                Diff
              </Button>
              {version.status === "archived" ? (
                <Button size="sm" variant="outline" disabled={reverting} onClick={() => onRevert(version.id)}>
                  <RotateCcwIcon />
                  Revert
                </Button>
              ) : null}
            </div>
            {version.applied && amountsFor === version.id ? (
              <AppliedAmounts snapshot={version.applied} />
            ) : null}
          </li>
        ))}
      </ol>

      {left && right ? (
        <div className="flex flex-col gap-2 rounded-lg bg-surface-muted p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Select value={left.id} onValueChange={(v) => setCompare([v, right.id])}>
              <SelectTrigger className="h-8 w-28" aria-label="Compare from">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    v{v.version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-text-muted">vs</span>
            <Select value={right.id} onValueChange={(v) => setCompare([left.id, v])}>
              <SelectTrigger className="h-8 w-28" aria-label="Compare to">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    v{v.version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="ghost" onClick={() => setCompare(null)}>
              <XIcon />
              Close
            </Button>
          </div>
          <VersionDiff left={left} right={right} accounts={accounts} activeVersionId={activeVersionId} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * A line-level diff between two versions. Compares the stored inputs (basis,
 * value, destination, goal), not resolved amounts — those depend on income and
 * costs at a date, and two versions of a plan are not necessarily comparable
 * that way.
 *
 * @param {{ left: Version, right: Version, accounts: Account[], activeVersionId: string | null }} props
 */
function VersionDiff({ left, right, accounts }) {
  const { currency, locale } = useSettings();

  /** @param {ServerLine} line */
  const key = (line) => `${line.stage}:${line.label}`;
  /** @param {ServerLine} line */
  const describeValue = (line) => {
    if (line.value === null) return "";
    if (line.basis === "fixed_amount") return ` ${formatMoney(line.value, { currency, locale })}/month`;
    return ` ${line.value}${ALLOCATION_BASIS_VALUE_KIND[line.basis] === "percent" ? "%" : ""}`;
  };
  /** @param {ServerLine} line */
  const describe = (line) =>
    `${ALLOCATION_BASIS_LABELS[line.basis]}${describeValue(line)} → ${accountName(accounts, line.accountId)}${line.goalPct !== null ? ` (goal ${line.goalPct}%)` : ""}`;

  const leftByKey = new Map(left.lines.map((l) => [key(l), l]));
  const rightByKey = new Map(right.lines.map((l) => [key(l), l]));
  const keys = Array.from(new Set([...leftByKey.keys(), ...rightByKey.keys()])).sort();

  const changes = keys
    .map((k) => {
      const a = leftByKey.get(k);
      const b = rightByKey.get(k);
      if (a && b && describe(a) === describe(b)) return null;
      return { k, a, b };
    })
    .filter((entry) => entry !== null);

  if (changes.length === 0) {
    return <p className="text-xs text-text-muted">These two versions have identical lines.</p>;
  }

  return (
    <ul className="flex flex-col gap-1.5 text-xs">
      {changes.map(({ k, a, b }) => (
        <li key={k} className="flex flex-col gap-0.5">
          <span className="font-medium text-text">{(a ?? b)?.label || "Untitled"}</span>
          <span className="text-text-muted">
            v{left.version}: {a ? describe(a) : <em>absent</em>}
          </span>
          <span className="text-text-muted">
            v{right.version}: {b ? describe(b) : <em>absent</em>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * `blocked` is how many lines (or section goals) can't be saved yet. Applying
 * saves the draft first, so with any of them it could only fail — the button
 * waits and the dialog says why, rather than letting the operator press it to
 * find out.
 *
 * @param {{
 *   open: boolean, onOpenChange: (open: boolean) => void, rows: TransferRow[], inputs: AllocationInputs,
 *   unallocatedPerMonthCents: Cents, submitting: boolean, blocked: number,
 *   onApply: (note: string | null) => void,
 * }} props
 */
function ApplyDialog({ open, onOpenChange, rows, inputs, unallocatedPerMonthCents, submitting, blocked, onApply }) {
  const [note, setNote] = useState("");
  const changed = rows.filter((r) => !r.isNoOp && r.deltaPerPayCents !== null && r.deltaPerPayCents !== 0);
  const cadenceLabel = inputs.hasPrimaryPaySchedule ? CADENCE_LABELS[inputs.payCadence].toLowerCase() : "month";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {changed.length} standing transfer{changed.length === 1 ? "" : "s"} change
          </DialogTitle>
          <DialogDescription>
            Applying makes this draft the active version and archives the previous one. Undo history clears.
          </DialogDescription>
        </DialogHeader>

        {changed.length === 0 ? (
          <p className="text-sm text-text-muted">No transfer amount changes — only labels, goals or ordering.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {changed.map((row) => (
              <li key={row.accountId} className="flex items-center justify-between gap-3">
                <span className="truncate text-text">{row.name}</span>
                <span className="shrink-0 text-text-muted">
                  {row.currentPerPayCents !== null ? <Money value={row.currentPerPayCents} /> : "—"} →{" "}
                  <span className="font-semibold text-text">
                    {row.newPerPayCents !== null ? <Money value={row.newPerPayCents} /> : "—"}
                  </span>
                  <span className="ml-1.5">
                    <Delta value={row.deltaPerPayCents ?? 0} kind="cents" />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-text-muted">Amounts are per {cadenceLabel}.</p>

        {unallocatedPerMonthCents !== 0 ? (
          <Notice className="p-3">
            Unallocated is <Money value={unallocatedPerMonthCents} signed /> per month, not zero. You can still apply
            this — nothing will be rebalanced for you.
          </Notice>
        ) : null}

        {blocked > 0 ? (
          <InlineError>
            {blocked === 1 ? "One line isn't" : `${blocked} lines aren't`} finished — the marked{" "}
            {blocked === 1 ? "row says" : "rows say"} what's missing. Fix {blocked === 1 ? "it" : "them"}, then apply.
          </InlineError>
        ) : null}

        <FieldRow label="Note" htmlFor="allocation-apply-note" hint="Optional — why this changed.">
          <Textarea
            id="allocation-apply-note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </FieldRow>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={submitting || blocked > 0}
            onClick={() => onApply(note.trim() === "" ? null : note.trim())}
          >
            {submitting ? "Applying…" : "Apply draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where the draft stands against the server, in one line that stays in the
 * same place above the sections. It used to say "saving shortly" whatever was
 * happening — including after a save had been refused and nothing was going
 * to try again — so every state it can be in now has its own words, and the
 * two that need the operator (an unfinished line, a failed save) are amber.
 *
 * @param {{
 *   dirty: boolean, saving: boolean, problemCount: number,
 *   failure: { count: number, retryable: boolean, signature: string, message: string } | null,
 *   localSignature: string, onRetry: () => void,
 * }} props
 */
function DraftSaveStatus({ dirty, saving, problemCount, failure, localSignature, onRetry }) {
  /** @type {import("react").ReactNode} */
  let content;
  if (saving) {
    content = <p className="text-xs text-text-muted">Saving draft…</p>;
  } else if (!dirty) {
    content = (
      <p className="flex items-center gap-1 text-xs text-text-muted">
        <CheckIcon className="size-3.5" aria-hidden="true" />
        All changes saved to the draft.
      </p>
    );
  } else if (problemCount > 0) {
    content = (
      <InlineError size="xs">
        Not saved yet — {problemCount === 1 ? "one line below needs" : `${problemCount} lines below need`} finishing
        first. Nothing is lost while you do.
      </InlineError>
    );
  } else if (failure) {
    // A refusal waits for an edit; anything else is retried on its own.
    const waitingForEdit = !failure.retryable && failure.signature === localSignature;
    content = (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <InlineError size="xs">
          Couldn&apos;t save the draft: {failure.message}{" "}
          {waitingForEdit ? "It will try again after your next change." : "Trying again automatically."}
        </InlineError>
        <Button size="sm" variant="outline" className="h-7" onClick={onRetry}>
          Retry now
        </Button>
      </div>
    );
  } else {
    content = <p className="text-xs text-text-muted">Unsaved changes — saving shortly.</p>;
  }

  return (
    <div role="status" aria-live="polite">
      {content}
    </div>
  );
}

/**
 * GET /income-variants, cached under the key /income uses — so it has to
 * cache the same thing /income does: the whole body, `{ variants,
 * hasPrimaryPaySchedule }`. This page used to cache the bare array under the
 * same key, and whichever page ran second read the other's shape: /income →
 * /allocation crashed on `.map` of an object.
 */
function useIncomeVariantsQuery() {
  return useQuery(incomeVariantsQueryOptions());
}

/**
 * How long to wait before trying a failed autosave again: 2s, then doubling,
 * capped at a minute. Long enough not to hammer an API that is restarting,
 * short enough that a blip clears itself before anyone notices.
 *
 * @param {number} failures consecutive failures so far (1 after the first)
 */
function autosaveRetryDelay(failures) {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, failures - 1));
}

/**
 * Whether asking again could help. A network failure or a server error might
 * clear; a refusal (4xx) says the draft itself is the problem, and only an
 * edit changes that. A 401 is neither — the session ended, and the app has
 * already gone to sign-in.
 *
 * @param {unknown} err
 */
function isRetryableSaveError(err) {
  if (!(err instanceof ApiError)) return true;
  return err.status >= 500 || err.status === 408 || err.status === 429;
}

/**
 * Divides income into destinations and answers the one question the operator
 * actually has: if I change this percentage, what does every standing transfer
 * become? Edit freely, see the complete before-and-after, apply or discard —
 * the app never adjusts a figure on its own (phases/08-allocation.md).
 */
export function AllocationPage() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const isDesktop = useMediaQuery(LG);
  const search = useSearch({ strict: false });
  const queryClient = useQueryClient();

  const on = typeof search.on === "string" ? search.on : todayIso();
  const [applyOpen, setApplyOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dragTargetId, setDragTargetId] = useState(/** @type {string | null} */ (null));
  // Null until the operator picks one, then their choice stands — the fallback
  // is whatever cadence they are actually paid on, which is the column the
  // spreadsheet is read in.
  const [viewOverride, setViewOverride] = useState(/** @type {Cadence | null} */ (null));
  const draggingIdRef = useRef(/** @type {string | null} */ (null));

  const lines = useAllocationDraft((s) => s.lines);
  const stageGoals = useAllocationDraft((s) => s.stageGoals);
  const dirty = useAllocationDraft((s) => s.dirty);
  const draftVersionId = useAllocationDraft((s) => s.versionId);
  const loadDraft = useAllocationDraft((s) => s.load);
  const resetDraft = useAllocationDraft((s) => s.reset);
  const markSaved = useAllocationDraft((s) => s.markSaved);
  const updateLine = useAllocationDraft((s) => s.updateLine);
  const setStageGoal = useAllocationDraft((s) => s.setStageGoal);
  const addLine = useAllocationDraft((s) => s.addLine);
  const removeLine = useAllocationDraft((s) => s.removeLine);
  const moveLine = useAllocationDraft((s) => s.moveLine);
  const moveLineBefore = useAllocationDraft((s) => s.moveLineBefore);
  const setLineStage = useAllocationDraft((s) => s.setLineStage);

  const undoDepth = useStore(allocationDraftHistory, (s) => s.pastStates.length);
  const redoDepth = useStore(allocationDraftHistory, (s) => s.futureStates.length);

  const plansQuery = useQuery(allocationPlansQueryOptions());

  const variantsQuery = useIncomeVariantsQuery();

  const accountsQuery = useQuery(accountsQueryOptions());

  const plans = plansQuery.data ?? [];
  const accounts = accountsQuery.data ?? [];
  const variantNames = useMemo(
    () => new Map((variantsQuery.data?.variants ?? []).map((v) => [v.id, v.name])),
    [variantsQuery.data],
  );
  // What the income schedule says is running on `on`. Asked for directly
  // rather than read off a preview: the preview is fetched FOR a plan, so
  // using it to choose the plan is circular — the page would have to open on
  // the wrong one first to find out which is right.
  const resolveQuery = useQuery(incomeResolveQueryOptions(on));

  // With no `?plan=` in the URL the page used to open on `plans[0]` — first
  // by insertion order, and nothing to do with what is actually running.
  // With four plans and one schedule, that was wrong three times in four:
  // the mismatch banner would fire on arrival and the operator would read a
  // screenful of figures for a plan that does not apply today.
  //
  // The schedule picks it now, and `plans[0]` is only the fallback for when
  // the schedule resolves to nothing (a gap) or to a variant no plan
  // divides. The URL still wins over both — an explicit `?plan=` is the
  // operator saying which one they want to look at.
  const scheduledPlanId = resolveQuery.data?.variantId
    ? (plans.find((p) => p.incomeVariantId === resolveQuery.data?.variantId)?.id ?? null)
    : null;
  const selectedPlanId =
    typeof search.plan === "string" ? search.plan : (scheduledPlanId ?? plans[0]?.id);
  const plan = plans.find((p) => p.id === selectedPlanId) ?? null;

  const previewQuery = useQuery({
    queryKey: ["allocation-preview", selectedPlanId, on],
    queryFn: async () => {
      const res = await api.allocation.preview.$get({ query: { planId: selectedPlanId ?? "", on } });
      // With its code: "no income-landing account yet" is a setup step with a
      // place to go and fix it, not a failure to retry.
      if (!res.ok) throw await apiErrorFrom(res);
      return await res.json();
    },
    enabled: Boolean(selectedPlanId),
    retry: false,
  });

  const versionsQuery = useQuery({
    queryKey: ["allocation-versions", selectedPlanId],
    queryFn: async () => {
      const res = await api["allocation-plans"][":id"].versions.$get({ param: { id: selectedPlanId ?? "" } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {Version[]} */ ((await res.json()).versions);
    },
    enabled: Boolean(selectedPlanId),
  });

  const preview = previewQuery.data && "inputs" in previewQuery.data ? previewQuery.data : null;
  const inputs = preview ? /** @type {AllocationInputs} */ (preview.inputs) : null;
  const activeResult = preview?.active ? /** @type {AllocationResult} */ (preview.active.result) : null;
  const current = preview?.current ?? null;
  const serverDraft = preview?.draft ?? null;
  const editing = serverDraft !== null;

  // Adopt the server's draft when it isn't the one already loaded — a fresh
  // page load, a different plan, or the other session having saved. Never
  // while there are unsaved local edits: their work wins until they save.
  //
  // "Already loaded" is judged against the draft store's own record of what
  // the server wrote back on the last load or save, which outlives this page
  // — so coming back to /allocation with the same draft loads nothing, rather
  // than remounting every row from the cached preview (perf-inp-plan.md,
  // P2 #1), and our own save coming back rounded is not taken for the other
  // session's edit.
  useEffect(() => {
    if (!serverDraft) {
      resetDraft();
      return;
    }
    const signature = serverLinesSignature(serverDraft.version.lines, serverDraft.version.stageGoals);
    const isNewVersion = serverDraft.version.id !== draftVersionId;
    const { serverSignature } = useAllocationDraft.getState();
    if (isNewVersion || (!dirty && signature !== serverSignature)) {
      loadDraft(serverDraft.version.id, serverDraft.version.lines, serverDraft.version.stageGoals);
    }
    // `dirty`/`draftVersionId` are read, not depended on: this must run when
    // server data arrives, not every time a keystroke flips `dirty`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverDraft]);

  const draftResult = useMemo(() => {
    if (!inputs?.incomeLandingAccountId) return null;
    // The live preview: the same pure engine the API calls, run locally on
    // every keystroke. That's why there is no recalculate button
    // (phases/08-allocation.md "Stage editor").
    return computeAllocation({
      grossPerMonthCents: inputs.grossPerMonthCents,
      payCadence: inputs.payCadence,
      fixedTotalPerMonthCents: inputs.fixedTotalPerMonthCents,
      variableEssentialsPerMonthCents: inputs.variableEssentialsPerMonthCents,
      variableNonEssentialPerMonthCents: inputs.variableNonEssentialPerMonthCents,
      incomeLandingAccountId: inputs.incomeLandingAccountId,
      lines: lines.map(draftLineToEngine),
      stageGoals: draftStageGoalsToPayload(stageGoals),
    });
  }, [inputs, lines, stageGoals]);

  const shownResult = editing ? draftResult : activeResult;

  // "Current" is what the bank holds: the amounts recorded when the active
  // version was applied (or, where none were, today's figures for it — the
  // API says which). `preview.active.result` is today's recomputation, and
  // diffing a draft against THAT said "no changes" while bank orders had gone
  // stale under a moved bill. The recorded transfers are put into the
  // engine's result shape so the comparison is still `diffAllocations`, which
  // reads `transfers` alone — `lineIds` is empty because the record never
  // said which lines fed each one.
  const currentResult = useMemo(
    () =>
      activeResult && current
        ? {
            ...activeResult,
            transfers: current.transfers.map((t) => ({
              accountId: t.accountId,
              perMonthCents: t.perMonthCents,
              perPayCents: t.perPayCents,
              lineIds: [],
              isNoOp: t.isNoOp,
            })),
          }
        : activeResult,
    [activeResult, current],
  );
  // Names as recorded, for a destination archived since.
  const recordedNames = useMemo(
    () => new Map((current?.applied?.transfers ?? []).map((t) => [t.accountId, t.accountName])),
    [current],
  );
  // Editing: the draft against what the bank holds. Not editing: the active
  // plan as it resolves today against what was applied to it — the drift,
  // which is each standing order that no longer says what the plan says.
  const comparedTo = editing ? draftResult : current?.source === "applied" ? activeResult : null;
  const diff = useMemo(() => {
    if (editing) return currentResult && draftResult ? diffAllocations(currentResult, draftResult) : null;
    return current?.drift ?? null;
  }, [currentResult, draftResult, editing, current]);

  const transferRows = useMemo(
    () => buildTransferRows({ active: currentResult, draft: comparedTo, diff, accounts, recordedNames }),
    [currentResult, comparedTo, diff, accounts, recordedNames],
  );

  const totalPerPayCents = shownResult ? sumCents(shownResult.transfers.map((t) => t.perPayCents)) : 0;
  // The same test <UnallocatedIndicator> makes: zero unallocated with a line
  // resolved negative is arithmetic that closed, not a plan that is fine.
  // Green here has to mean what green means there (phases/08-allocation.md
  // "The invariant indicator").
  const balanced = shownResult !== null && isBalanced(shownResult);
  const changedCount = transferRows.filter((r) => !r.isNoOp && r.deltaPerPayCents !== null && r.deltaPerPayCents !== 0).length;

  // The lines rendered by the editor: the draft when editing, otherwise the
  // active version, mapped into the same shape so one set of components
  // serves both (read-only in the second case).
  const shownLines = useMemo(() => {
    if (editing) return lines;
    const activeLines = preview?.active?.version.lines ?? [];
    return activeLines.map((row) => ({
      id: row.id,
      stage: row.stage,
      label: row.label,
      basis: row.basis,
      valueText: lineValueToText(row.basis, row.value),
      goalPctText: row.goalPct === null ? "" : String(row.goalPct),
      accountId: row.accountId,
    }));
  }, [editing, lines, preview]);

  // The section goals as the editor shows them: the draft's own while editing,
  // otherwise whatever the applied version carries.
  const shownStageGoals = useMemo(() => {
    if (editing) return stageGoals;
    /** @type {Record<number, string>} */
    const out = {};
    for (const goal of preview?.active?.version.stageGoals ?? []) out[goal.stage] = String(goal.goalPct);
    return out;
  }, [editing, stageGoals, preview]);

  // The cadence on screen. Defaults to the household's pay cadence — the
  // column the spreadsheet is read in — and falls back to monthly when no pay
  // schedule says what a pay period is.
  const view = viewOverride ?? (inputs?.hasPrimaryPaySchedule ? inputs.payCadence : "monthly");

  const localSignature = useMemo(() => draftLinesSignature(lines, stageGoals), [lines, stageGoals]);
  // Why the draft can't be sent as it stands, per line and per section goal.
  // Only while editing — the applied version on screen otherwise was saved
  // by definition.
  const problems = useMemo(
    () => (editing ? draftProblems(lines, stageGoals) : null),
    [editing, lines, stageGoals],
  );
  const problemCount = problems?.count ?? 0;

  // The last autosave's failure, if the one before this edit failed: how many
  // in a row, whether retrying can help, and the signature that failed — a
  // refused draft is only worth sending again once it has changed.
  const [saveFailure, setSaveFailure] = useState(
    /** @type {{ count: number, retryable: boolean, signature: string, message: string } | null} */ (null),
  );
  // The save on the wire, if any, so Apply can wait for it rather than send a
  // second PUT that might land first and be overwritten by the older one.
  const savePromiseRef = useRef(/** @type {Promise<unknown> | null} */ (null));

  // A failure belongs to the draft it happened to: another plan's draft, or
  // a fresh one after apply or discard, starts clean.
  useEffect(() => {
    setSaveFailure(null);
  }, [draftVersionId]);

  const saveLines = useMutation({
    // What to send is read from the store when the save STARTS, and its
    // signature travels with it: that is what `markSaved` records, so a
    // keystroke landing while this is in flight still counts as unsaved.
    mutationFn: async (
      /** @type {{ versionId: string, lines: DraftLine[], stageGoals: DraftStageGoals }} */ draft,
    ) => {
      const res = await api["allocation-versions"][":id"].lines.$put({
        param: { id: draft.versionId },
        json: { lines: draftLinesToPayload(draft.lines), stageGoals: draftStageGoalsToPayload(draft.stageGoals) },
      });
      if (!res.ok) throw await apiErrorFrom(res);
      return res.json();
    },
    onSuccess: (result, draft) => {
      setSaveFailure(null);
      // A save for a draft since discarded, applied or swapped for another
      // plan's says nothing about the one on screen now.
      if (useAllocationDraft.getState().versionId === draft.versionId) {
        markSaved(
          draftLinesSignature(draft.lines, draft.stageGoals),
          serverLinesSignature(result.version.lines, result.version.stageGoals),
        );
      }
      // Write what was just saved into the cached preview too. Left alone,
      // the cache keeps the draft as it was when the page opened, and the
      // next visit — or switching back from another plan — would render
      // that older draft over the newer lines in the store until the refetch
      // landed; an edit typed in that gap would be autosaved on top of the
      // older lines. Only the version is patched: the page reads nothing
      // else of the draft from here (it recomputes the result locally).
      queryClient.setQueriesData({ queryKey: ["allocation-preview", selectedPlanId] }, (old) =>
        old && "draft" in old && old.draft && old.draft.version.id === result.version.id
          ? {
              ...old,
              draft: {
                ...old.draft,
                version: { ...old.draft.version, lines: result.version.lines, stageGoals: result.version.stageGoals },
              },
            }
          : old,
      );
      queryClient.invalidateQueries({ queryKey: ["allocation-versions", selectedPlanId] });
    },
    // Said in the status line above the sections, where it stays until the
    // save goes through; a toast too, but only for the first failure of a
    // run — a retry every few seconds toasting each time would be noise.
    onError: (err, draft) => {
      if (!saveFailure) toast.error(`Couldn't save the draft: ${err.message}`);
      setSaveFailure((previous) => ({
        count: (previous?.count ?? 0) + 1,
        retryable: isRetryableSaveError(err),
        signature: draftLinesSignature(draft.lines, draft.stageGoals),
        message: err.message,
      }));
    },
  });

  /** Sends the draft as it stands right now. */
  function runSave() {
    const { versionId, lines: draftLines, stageGoals: draftGoals } = useAllocationDraft.getState();
    if (!versionId) return Promise.resolve();
    const promise = saveLines.mutateAsync({ versionId, lines: draftLines, stageGoals: draftGoals });
    savePromiseRef.current = promise;
    // The failure is handled by onError; this only stops tracking it.
    promise
      .catch(() => undefined)
      .finally(() => {
        if (savePromiseRef.current === promise) savePromiseRef.current = null;
      });
    return promise;
  }

  const createDraft = useMutation({
    mutationFn: async () => {
      const res = await api["allocation-plans"][":id"].draft.$post({ param: { id: selectedPlanId ?? "" } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["allocation-preview"] });
      queryClient.invalidateQueries({ queryKey: ["allocation-plans"] });
      queryClient.invalidateQueries({ queryKey: ["allocation-versions", selectedPlanId] });
    },
    onError: (err) => toast.error(err.message),
  });

  const discardDraft = useMutation({
    mutationFn: async () => {
      const res = await api["allocation-plans"][":id"].draft.$delete({ param: { id: selectedPlanId ?? "" } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      resetDraft();
      queryClient.invalidateQueries({ queryKey: ["allocation-preview"] });
      queryClient.invalidateQueries({ queryKey: ["allocation-plans"] });
      queryClient.invalidateQueries({ queryKey: ["allocation-versions", selectedPlanId] });
      toast.success("Draft discarded.");
    },
    onError: (err) => toast.error(err.message),
  });

  const applyDraft = useMutation({
    mutationFn: async (/** @type {string | null} */ note) => {
      // Apply must promote what's on screen, not the last autosave. Let a
      // save already on the wire land, then save again whenever the screen
      // still differs from what the server holds — after an undo past a save
      // included, which the old `dirty` flag missed.
      if (savePromiseRef.current) await savePromiseRef.current.catch(() => undefined);
      const draft = useAllocationDraft.getState();
      if (draftProblems(draft.lines, draft.stageGoals).count > 0) {
        throw new Error("Some lines aren't finished — the marked rows say what's missing.");
      }
      if (draft.dirty) {
        // The save's own failure is already said (status line and toast);
        // this says what it meant for the apply.
        await runSave().catch(() => {
          throw new Error("The latest changes couldn't be saved, so nothing was applied.");
        });
      }
      const res = await api["allocation-plans"][":id"].draft.apply.$post({
        param: { id: selectedPlanId ?? "" },
        // The date being previewed: the amounts recorded as "what the bank
        // holds" are the ones this screen showed, for the cycle it showed.
        json: { note, on },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: (result) => {
      setApplyOpen(false);
      setSaveFailure(null);
      resetDraft();
      queryClient.invalidateQueries({ queryKey: ["allocation-preview"] });
      queryClient.invalidateQueries({ queryKey: ["allocation-plans"] });
      queryClient.invalidateQueries({ queryKey: ["allocation-versions", selectedPlanId] });
      toast.success(`v${result.version.version} is now active.`);
    },
    onError: (err) => toast.error(err.message),
  });

  // Debounced autosave so a reload never loses work and the other session sees
  // the same draft. Undo/redo stays local and instant — it never waits on this
  // (phases/08-allocation.md "Undo / redo").
  useEffect(() => {
    if (!dirty || !draftVersionId) return undefined;
    // Discard deletes the version and apply promotes it; a timer that fired
    // in between would write to a draft that no longer exists and surface a
    // 404 the operator can do nothing about. Apply flushes the pending edit
    // itself before it posts.
    if (discardDraft.isPending || applyDraft.isPending) return undefined;
    // One save at a time. When this one settles the effect runs again, and
    // anything typed meanwhile is still dirty, so it goes next.
    if (saveLines.isPending) return undefined;
    // An incomplete line would only be refused, and refused with it goes
    // every other change in the draft. Hold everything until it's finished;
    // the line says what's missing and the status line says nothing is
    // being saved.
    if (problemCount > 0) return undefined;
    let delay = AUTOSAVE_DELAY_MS;
    if (saveFailure) {
      // Refused: sending the same draft again gets the same answer. Wait for
      // an edit (a new signature), then save as usual.
      if (!saveFailure.retryable && saveFailure.signature === localSignature) return undefined;
      // Unreachable or a server error: try again, backing off.
      if (saveFailure.retryable) delay = autosaveRetryDelay(saveFailure.count);
    }
    const timer = setTimeout(runSave, delay);
    return () => clearTimeout(timer);
    // `runSave` reads the store when it fires; it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dirty,
    localSignature,
    draftVersionId,
    problemCount,
    saveFailure,
    saveLines.isPending,
    discardDraft.isPending,
    applyDraft.isPending,
  ]);

  // The autosave above closes the window to 800ms, it doesn't close it — a
  // navigation inside that window still drops the edit. Only guard while an
  // edit is genuinely pending; an applied or discarded draft is not dirty.
  useUnsavedGuard(dirty && draftVersionId !== null && !applyDraft.isPending && !discardDraft.isPending, {
    title: "Leave with an unsaved edit?",
    // Said as it is: "stay a moment" is only true while a save can still go
    // through.
    description:
      problemCount > 0
        ? "Some lines in this draft aren't finished, so your latest changes haven't been saved. Leave now and they're lost."
        : saveFailure
          ? "Your latest changes to this draft couldn't be saved yet. Leave now and they're lost."
          : "Your last change to this draft hasn't finished saving. Staying for a moment lets it through.",
  });

  // Discard deletes the draft version outright — every line typed into it,
  // and the undo stack with it. The one action on this screen that loses
  // real work.
  async function confirmDiscard() {
    const ok = await confirm({
      title: "Discard this draft?",
      description: "Every edit in it is deleted and the applied allocation is what's left. This cannot be undone.",
      confirmLabel: "Discard draft",
    });
    if (ok) discardDraft.mutate();
  }

  const revertVersion = useMutation({
    mutationFn: async (/** @type {string} */ versionId) => {
      const res = await api["allocation-versions"][":id"].revert.$post({ param: { id: versionId } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["allocation-preview"] });
      queryClient.invalidateQueries({ queryKey: ["allocation-plans"] });
      queryClient.invalidateQueries({ queryKey: ["allocation-versions", selectedPlanId] });
      toast.success(`Draft v${result.draft.version} seeded — review and apply it.`);
    },
    onError: (err) => toast.error(err.message),
  });

  const copyTransfers = useCallback(async () => {
    const actionable = transferRows.filter((r) => !r.isNoOp);
    const text = actionable
      .map((r) => `${r.name}\t${((r.newPerPayCents ?? r.currentPerPayCents ?? 0) / 100).toFixed(2)}`)
      .join("\n");
    try {
      await copyText(text);
      toast.success(`${actionable.length} transfer${actionable.length === 1 ? "" : "s"} copied.`);
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  }, [transferRows]);

  const undo = useCallback(() => allocationDraftHistory.getState().undo(), []);
  const redo = useCallback(() => allocationDraftHistory.getState().redo(), []);

  // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, including inside a field: the draft is
  // the document here, so an undo aimed at a percentage should walk the plan
  // back, not the input's own edit history.
  useEffect(() => {
    if (!editing) return undefined;
    /** @param {KeyboardEvent} e */
    const onKeyDown = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, undo, redo]);

  useEffect(
    () =>
      registerCommands([
        {
          id: "allocation:edit",
          group: "Actions",
          label: "Edit allocation",
          icon: PencilIcon,
          run: () => {
            if (editing) toast.info("A draft is already open.");
            else createDraft.mutate();
          },
        },
        {
          id: "allocation:apply",
          group: "Actions",
          label: "Apply draft",
          icon: CheckIcon,
          run: () => (editing ? setApplyOpen(true) : toast.info("No draft to apply.")),
        },
        {
          id: "allocation:discard",
          group: "Actions",
          label: "Discard draft",
          icon: Trash2Icon,
          run: () => (editing ? confirmDiscard() : toast.info("No draft to discard.")),
        },
        {
          id: "allocation:copy-transfers",
          group: "Actions",
          label: "Copy transfers",
          icon: ClipboardCopyIcon,
          run: copyTransfers,
        },
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing, copyTransfers],
  );

  /** @param {string} planId */
  function selectPlan(planId) {
    navigate({ to: "/allocation", search: { plan: planId, on } });
  }

  /** @param {string} nextOn */
  function selectDate(nextOn) {
    navigate({ to: "/allocation", search: { plan: selectedPlanId, on: nextOn } });
  }

  const defaultAccountId = accounts[0]?.id ?? "";

  // A failed plans query is not "no plans". Rendering it as the empty state
  // put "No allocation plan yet" beside a New plan button — an invitation to
  // create a duplicate of the plan that was there all along.
  if (plansQuery.isError) {
    return (
      <>
        <PageHeader
          title="Allocation"
          description="Divide income into destinations, and see exactly what every standing transfer should be."
        />
        <QueryError error={plansQuery.error} onRetry={() => plansQuery.refetch()} what="your allocation plans" />
      </>
    );
  }

  if (plansQuery.isSuccess && plans.length === 0) {
    return (
      <>
        <PageHeader
          title="Allocation"
          description="Divide income into destinations, and see exactly what every standing transfer should be."
        />
        <EmptyState
          icon={ArrowLeftRightIcon}
          title="No allocation plan yet"
          description="A plan divides one income variant into destinations. Create one, add its stages, then apply it to get your transfer amounts."
          action={<CreatePlanButton onCreated={(id) => selectPlan(id)} />}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Allocation"
        description="Bills and essentials, then what you set aside, then what's left. Nothing changes your standing transfers until you apply."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CreatePlanButton onCreated={(id) => selectPlan(id)} />
            {editing ? (
              <>
                <div className="flex items-center gap-1 rounded-(--radius-control) bg-surface px-1 shadow-(--shadow-card)">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Undo (${undoDepth})`}
                    disabled={undoDepth === 0}
                    onClick={undo}
                  >
                    <UndoIcon />
                  </Button>
                  <span className="min-w-8 text-center text-xs text-text-muted" aria-hidden="true">
                    {undoDepth}/{redoDepth}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Redo (${redoDepth})`}
                    disabled={redoDepth === 0}
                    onClick={redo}
                  >
                    <RedoIcon />
                  </Button>
                </div>
                <Button variant="ghost" disabled={discardDraft.isPending} onClick={confirmDiscard}>
                  Discard
                </Button>
                {/* The phone's top bar already carries Apply/Edit (below); a
                    second copy of the same primary here was two blue buttons
                    for one action on one screen. */}
                <Button className="max-md:hidden" onClick={() => setApplyOpen(true)}>
                  <CheckIcon />
                  Apply draft
                </Button>
              </>
            ) : (
              <Button
                className="max-md:hidden"
                disabled={createDraft.isPending || !selectedPlanId}
                onClick={() => createDraft.mutate()}
              >
                <PencilIcon />
                Edit allocation
              </Button>
            )}
          </div>
        }
      />

      <TopBarAction>
        {editing ? (
          <Button size="sm" onClick={() => setApplyOpen(true)}>
            Apply
          </Button>
        ) : (
          <Button size="sm" disabled={!selectedPlanId} onClick={() => createDraft.mutate()}>
            Edit
          </Button>
        )}
      </TopBarAction>

      <ContextBar
        plans={plans}
        plan={plan}
        on={on}
        inputs={inputs}
        variantNames={variantNames}
        view={view}
        balanced={balanced}
        hasResult={shownResult !== null}
        onPlanChange={selectPlan}
        onDateChange={selectDate}
        onViewChange={setViewOverride}
      />

      {previewQuery.error instanceof ApiError && previewQuery.error.code === "no_income_landing_account" ? (
        // A setup step, not a fault: the engine needs to know which account
        // pay lands in before it can tell a transfer from money that stays
        // put. Say where that's set, rather than leaving a dead end.
        <EmptyState
          icon={AlertTriangleIcon}
          title="Can't compute this allocation yet"
          description="Mark the account your pay lands in, and every transfer here can be worked out from it."
          action={
            <Button asChild>
              <Link to="/accounts">Go to Accounts</Link>
            </Button>
          }
        />
      ) : previewQuery.isError ? (
        <QueryError error={previewQuery.error} onRetry={() => previewQuery.refetch()} what="this allocation" />
      ) : null}

      {preview?.warnings?.length ? (
        <div className="flex flex-col gap-2 rounded-(--radius-card) bg-warning-soft p-4">
          {preview.warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-2 text-sm text-text">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning-strong" aria-hidden="true" />
              {w.message}
            </p>
          ))}
        </div>
      ) : null}

      {editing ? (
        <DraftSaveStatus
          dirty={dirty}
          saving={saveLines.isPending}
          problemCount={problemCount}
          failure={saveFailure}
          localSignature={localSignature}
          onRetry={() => {
            void runSave();
          }}
        />
      ) : null}

      {inputs && shownResult ? (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="flex flex-col gap-4">
            {/* Balanced is the normal state and needs a tick, not a card: the
                full indicator was ~110px of green saying "nothing is wrong",
                at the top of the one screen that has to fit three sections
                and a transfer list. It comes back the moment the arithmetic
                stops closing — including the amber "lines resolve negative"
                case, where zero unallocated is not the same as fine. */}
            {balanced ? null : (
              <UnallocatedIndicator
                result={shownResult}
                payCadence={inputs.payCadence}
                hasPrimaryPaySchedule={inputs.hasPrimaryPaySchedule}
              />
            )}

            {shownLines.length === 0 ? (
              <EmptyState
                icon={ArrowLeftRightIcon}
                title={editing ? "No lines yet" : "This version has no lines"}
                description={
                  editing
                    ? "Start in Bills & Essentials with the two totals you never type by hand — a fixed-cost line and an essentials line — then add your savings percentages to Save, Invest & Give."
                    : "Open a draft to add lines."
                }
                action={
                  editing ? (
                    <Button onClick={() => addLine(1, defaultAccountId)}>
                      <PlusIcon />
                      Add the first line
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              ALLOCATION_SECTIONS.map((section) => (
                <SectionCard
                  key={section.stage}
                  section={section}
                  lines={shownLines.filter((l) => l.stage === section.stage)}
                  result={shownResult}
                  inputs={inputs}
                  accounts={accounts}
                  view={view}
                  readOnly={!editing}
                  goalText={shownStageGoals[section.stage] ?? ""}
                  dragTargetId={dragTargetId}
                  problems={problems}
                  onGoalChange={(text) => setStageGoal(section.stage, text)}
                  onChange={updateLine}
                  onRemove={removeLine}
                  onMove={moveLine}
                  onStageChange={setLineStage}
                  onAddLine={() => addLine(section.stage, defaultAccountId)}
                  onDragStart={(id) => {
                    draggingIdRef.current = id;
                  }}
                  onDragOver={setDragTargetId}
                  onDrop={(id) => {
                    if (draggingIdRef.current) moveLineBefore(draggingIdRef.current, id);
                    draggingIdRef.current = null;
                    setDragTargetId(null);
                  }}
                  onDragEnd={() => {
                    draggingIdRef.current = null;
                    setDragTargetId(null);
                  }}
                  // The last section is the one the operator asked to have
                  // framed as a gauge rather than a rule, and the one the Good
                  // Life benchmark is measured against — so both sentences
                  // live here, on the figure they are about, instead of at the
                  // bottom of a side panel.
                  footer={
                    section.stage === 3 ? (
                      <LeftoverNotes
                        result={shownResult}
                        inputs={inputs}
                        accounts={accounts}
                        lines={shownLines.filter((l) => l.stage === section.stage)}
                        view={view}
                        editing={editing}
                      />
                    ) : undefined
                  }
                />
              ))
            )}
          </div>

          {/* `hidden lg:block` alone would still MOUNT the panel below lg,
              and a chart inside `display: none` measures its container at
              0x0 and draws nothing. The media query keeps it out of the tree
              entirely; the classes stay for the layout. */}
          {/* Pinned just below the page's own pinned header (PageHeader
              publishes its height), not under it. */}
          <aside className="sticky top-[calc(var(--page-header-h,0px)+1rem)] hidden rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card) lg:block">
            {isDesktop ? (
              <PreviewPanel
                rows={transferRows}
                inputs={inputs}
                editing={editing}
                result={shownResult}
                accounts={accounts}
                totalPerPayCents={totalPerPayCents}
                current={current}
              />
            ) : null}
          </aside>
        </div>
      ) : !previewQuery.isError && (plansQuery.isPending || previewQuery.isPending) ? (
        // The preview waits on the plans to know which plan to ask for, so
        // this covers both legs. Same two columns as the real thing: the
        // stages, and the transfers beside them.
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <SectionsSkeleton sections={[3, 4, 2]} label="Loading this allocation" />
          <PanelSkeleton height={420} label="Loading transfers" />
        </div>
      ) : null}

      {versionsQuery.isError ? (
        <QueryError
          compact
          error={versionsQuery.error}
          onRetry={() => versionsQuery.refetch()}
          what="this plan's version history"
        />
      ) : versionsQuery.data && versionsQuery.data.length > 0 ? (
        <VersionHistory
          versions={versionsQuery.data}
          accounts={accounts}
          activeVersionId={preview?.active?.version.id ?? null}
          reverting={revertVersion.isPending}
          onRevert={(versionId) => revertVersion.mutate(versionId)}
        />
      ) : null}

      {inputs && shownResult ? (
        <>
          {/* Spacer so the drawer never covers the last section on mobile. */}
          <div className="h-16 lg:hidden" aria-hidden="true" />
          <MobilePreviewDrawer
            open={previewOpen}
            onToggle={() => setPreviewOpen((v) => !v)}
            summary={
              <span className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium text-text">Preview</span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    isBalanced(shownResult) ? "text-text-muted" : "text-warning-strong",
                  )}
                >
                  {isBalanced(shownResult) ? (
                    <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span>
                    Unallocated <Money value={shownResult.unallocatedPerMonthCents} />
                  </span>
                </span>
                {editing ? (
                  <span className="text-text-muted">
                    · {changedCount} transfer{changedCount === 1 ? "" : "s"} change
                  </span>
                ) : changedCount > 0 ? (
                  // Drift, with no draft open: standing orders that no longer
                  // say what the plan says. Worth seeing without opening.
                  <span className="text-warning-strong">
                    · {changedCount} bank order{changedCount === 1 ? "" : "s"} to update
                  </span>
                ) : null}
              </span>
            }
          >
            <PreviewPanel
              rows={transferRows}
              inputs={inputs}
              editing={editing}
              result={shownResult}
              accounts={accounts}
              totalPerPayCents={totalPerPayCents}
              current={current}
            />
          </MobilePreviewDrawer>
        </>
      ) : null}

      {inputs && shownResult ? (
        <ApplyDialog
          open={applyOpen}
          onOpenChange={setApplyOpen}
          rows={transferRows}
          inputs={inputs}
          unallocatedPerMonthCents={shownResult.unallocatedPerMonthCents}
          submitting={applyDraft.isPending || saveLines.isPending}
          blocked={problemCount}
          onApply={(note) => applyDraft.mutate(note)}
        />
      ) : null}
    </>
  );
}

/**
 * @param {{ onCreated: (planId: string) => void }} props
 */
function CreatePlanButton({ onCreated }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [variantId, setVariantId] = useState("");

  const variantsQuery = useIncomeVariantsQuery();

  const createPlan = useMutation({
    mutationFn: async () => {
      const res = await api["allocation-plans"].$post({ json: { name: name.trim(), incomeVariantId: variantId } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["allocation-plans"] });
      setOpen(false);
      setName("");
      onCreated(result.plan.id);
      toast.success("Plan created with an empty draft.");
    },
    onError: (err) => toast.error(err.message),
  });

  const variants = variantsQuery.data?.variants ?? [];
  // Loaded and empty — not still loading, and not failed: a plan divides an
  // income variant, so with none there is nothing this dialog can make.
  const noVariants = variantsQuery.isSuccess && variants.length === 0;

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <PlusIcon />
        New plan
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New allocation plan</DialogTitle>
            <DialogDescription>
              A plan divides one income variant into destinations. One per variant is the usual shape, but nothing stops
              you keeping two alternatives to compare.
            </DialogDescription>
          </DialogHeader>
          <FieldRow label="Name" htmlFor="allocation-plan-name" required>
            <Input
              id="allocation-plan-name"
              value={name}
              placeholder="e.g. Usual"
              onChange={(e) => setName(e.target.value)}
            />
          </FieldRow>
          {noVariants ? (
            // An empty dropdown was a dead end: nothing to choose, and no
            // word on where the choices come from.
            <div className="flex flex-col items-start gap-2 rounded-lg bg-surface-muted p-3 text-sm">
              <p className="text-text">Add an income variant first.</p>
              <p className="text-text-muted">
                A plan divides one income variant — your household&apos;s pay, line by line — so there has to be one
                to divide.
              </p>
              <Button asChild size="sm" variant="outline">
                <Link to="/income">Go to Income</Link>
              </Button>
            </div>
          ) : (
            <FieldRow label="Income variant" htmlFor="allocation-plan-variant" required>
              <Select value={variantId} onValueChange={setVariantId}>
                <SelectTrigger id="allocation-plan-variant" className="w-full">
                  <SelectValue placeholder="Choose a variant" />
                </SelectTrigger>
                <SelectContent>
                  {variants.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          )}
          {variantsQuery.isError ? (
            <QueryError
              compact
              error={variantsQuery.error}
              onRetry={() => variantsQuery.refetch()}
              what="your income variants"
            />
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={createPlan.isPending || name.trim() === "" || variantId === ""}
              onClick={() => createPlan.mutate()}
            >
              {createPlan.isPending ? "Creating…" : "Create plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
