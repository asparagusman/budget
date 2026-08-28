import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useStore } from "zustand";
import { computeAllocation, diffAllocations, equivalent, sumCents } from "@budget/engine";
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
import { Input } from "@/components/ui/input.jsx";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Textarea } from "@/components/ui/textarea.jsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.jsx";
import { AllocationProportionBar, AllocationSankey, accountName } from "@/components/allocation-flow.jsx";
import { Delta } from "@/components/delta.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { GoodLifeFidelity } from "@/components/good-life-fidelity.jsx";
import { Money } from "@/components/money.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { TopBarAction } from "@/components/topbar-action.jsx";
import { UnallocatedIndicator } from "@/components/unallocated-indicator.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { useFlashOnChange } from "@/lib/motion.js";
import {
  allocationDraftHistory,
  draftLineToEngine,
  draftLinesSignature,
  draftLinesToPayload,
  lineValueToText,
  serverLinesSignature,
  useAllocationDraft,
} from "@/lib/allocation-draft.js";
import { registerCommands } from "@/lib/commands.js";
import { LG, useMediaQuery } from "@/lib/use-media-query.js";
import {
  ALLOCATION_BASES,
  ALLOCATION_BASIS_HINTS,
  ALLOCATION_BASIS_LABELS,
  ALLOCATION_BASIS_VALUE_KIND,
  CADENCE_LABELS,
} from "@/lib/constants.js";
import { formatIsoDate, todayIso } from "@/lib/dates.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";
import { cn } from "@/lib/utils.js";

/** @import { AllocationResult, Basis, Cadence, Cents, TransferDelta } from "@budget/engine" */
/** @import { DraftLine } from "@/lib/allocation-draft.js" */

/** @typedef {{ id: string, name: string, sortOrder: number }} Account */
/** @typedef {{ id: string, name: string, incomeVariantId: string, incomeVariantName: string | null, activeVersion: VersionSummary | null, draftVersion: VersionSummary | null, versionCount: number }} Plan */
/** @typedef {{ id: string, version: number, status: "draft" | "active" | "archived", note: string | null, createdAt: string, activatedAt: string | null }} VersionSummary */
/** @typedef {{ id: string, stage: number, label: string, basis: Basis, value: number | null, goalPct: number | null, accountId: string, sortOrder: number }} ServerLine */
/** @typedef {{ id: string, planId: string, version: number, status: "draft" | "active" | "archived", basedOnVersionId: string | null, note: string | null, createdBy: string | null, createdByName: string | null, createdAt: string, activatedAt: string | null, lines: ServerLine[] }} Version */
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

/** @param {{ stage: number }[]} lines */
function stageNumbers(lines) {
  return Array.from(new Set(lines.map((l) => l.stage))).sort((a, b) => a - b);
}

/**
 * Remaining at a stage's *entry* — the figure a `pct_of_remaining` row is
 * computed against, and the one the spreadsheet never showed. A lookup of the
 * previous stage's own remaining (gross for the first), never a subtraction of
 * its own: every number on this screen comes from the engine.
 *
 * @param {AllocationResult} result
 * @param {number} stage
 * @param {Cents} grossPerMonthCents
 */
function remainingAtStageStart(result, stage, grossPerMonthCents) {
  const index = result.stages.findIndex((s) => s.stage === stage);
  if (index <= 0) return grossPerMonthCents;
  return result.stages[index - 1]?.remainingPerMonthCents ?? grossPerMonthCents;
}

/**
 * The transfer table's rows: one per destination, current beside new, with the
 * engine's own delta. Actionable destinations first, then the income-landing
 * account — money that stays where it landed is not a transfer to make.
 *
 * @param {{
 *   active: AllocationResult | null,
 *   draft: AllocationResult | null,
 *   diff: TransferDelta[] | null,
 *   accounts: Account[],
 * }} args
 */
function buildTransferRows({ active, draft, diff, accounts }) {
  const ids = Array.from(
    new Set([...(active?.transfers ?? []).map((t) => t.accountId), ...(draft?.transfers ?? []).map((t) => t.accountId)]),
  );

  const rows = ids.map((accountId) => {
    const current = active?.transfers.find((t) => t.accountId === accountId) ?? null;
    const next = draft?.transfers.find((t) => t.accountId === accountId) ?? null;
    const delta = diff?.find((d) => d.accountId === accountId) ?? null;
    return {
      accountId,
      name: accountName(accounts, accountId),
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
 * @param {{
 *   plans: Plan[], plan: Plan | null, on: string, inputs: AllocationInputs | null,
 *   variantNames: Map<string, string>,
 *   onPlanChange: (id: string) => void, onDateChange: (on: string) => void,
 * }} props
 */
function ContextBar({ plans, plan, on, inputs, variantNames, onPlanChange, onDateChange }) {
  const resolvedVariantName =
    inputs?.resolvedVariantId != null ? variantNames.get(inputs.resolvedVariantId) ?? null : null;
  const variantMismatch =
    plan !== null && inputs?.resolvedVariantId != null && inputs.resolvedVariantId !== plan.incomeVariantId;

  return (
    <div className="flex flex-col gap-4 rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-end gap-4">
          <FieldRow label="Plan" htmlFor="allocation-plan" className="w-56">
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
            <Input id="allocation-on" type="date" value={on} onChange={(e) => onDateChange(e.target.value)} />
          </FieldRow>
        </div>
        <div className="text-sm">
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
 * @param {{ line: DraftLine, onChange: (patch: Partial<DraftLine>) => void }} props
 */
function LineValueInput({ line, onChange }) {
  const kind = ALLOCATION_BASIS_VALUE_KIND[line.basis];

  if (kind === "none") {
    return <span className="text-sm text-text-subtle">From totals</span>;
  }

  return (
    <InputGroup className="h-9 w-28">
      {kind === "money" ? (
        <InputGroupAddon>
          <InputGroupText className="text-xs">$</InputGroupText>
        </InputGroupAddon>
      ) : null}
      <InputGroupInput
        aria-label={`${line.label || "Line"} value`}
        type="number"
        step={kind === "percent" ? "0.01" : kind === "money" ? "0.01" : "1"}
        inputMode="decimal"
        value={line.valueText}
        onChange={(e) => onChange({ valueText: e.target.value })}
      />
      {kind === "percent" ? (
        <InputGroupAddon align="inline-end">
          <InputGroupText className="text-xs">%</InputGroupText>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

/**
 * One editable line. A card rather than a table row at every width: the editor
 * shares the screen with the sticky preview panel, and eight columns of
 * controls do not fit beside it on a laptop — a table that has to scroll
 * sideways to reach the amount is the same failure at 1440px that it is at
 * 375px.
 *
 * Drag to reorder (dropping onto a card in another stage moves it there), or
 * use the buttons and the stage selector — the same moves without a pointer,
 * since a drag handle alone is not keyboard reachable.
 *
 * @param {{
 *   line: DraftLine, resolved: AllocationResult["lines"][number] | undefined, accounts: Account[],
 *   stages: number[], payCadence: Cadence, hasPrimaryPaySchedule: boolean, isDragTarget: boolean,
 *   onChange: (patch: Partial<DraftLine>) => void, onRemove: () => void,
 *   onMove: (direction: -1 | 1) => void, onStageChange: (stage: number) => void,
 *   onDragStart: () => void, onDragOver: () => void, onDrop: () => void, onDragEnd: () => void,
 * }} props
 */
function DraftLineCard({
  line,
  resolved,
  accounts,
  stages,
  payCadence,
  hasPrimaryPaySchedule,
  isDragTarget,
  onChange,
  onRemove,
  onMove,
  onStageChange,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}) {
  const cadenceLabel = hasPrimaryPaySchedule ? CADENCE_LABELS[payCadence].toLowerCase() : "month";
  const [typing, setTyping] = useState(false);
  // Undo/redo confirmation. Keyed on the line's own stored inputs, and
  // suppressed while this card has focus, so the flash fires exactly when
  // a value here changed WITHOUT the operator touching it — which is what
  // an undo looks like from the card's point of view
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
      // Focus-within, tracked in state rather than read from CSS, because
      // it gates the tween below: this card's own figures must not count up
      // to each keystroke while the operator is typing the percentage that
      // drives them. Every OTHER card still tweens, which is the whole
      // point — you see which lines your change moved.
      onFocusCapture={() => setTyping(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setTyping(false);
      }}
      className={cn(
        "flex flex-col gap-2 rounded-(--radius-control) border border-border p-3",
        isDragTarget && "outline-2 -outline-offset-2 outline-(--accent)",
        flashing && "animate-row-flash",
      )}
    >
      <div className="flex items-start gap-2">
        <GripVerticalIcon
          className="mt-2.5 hidden size-4 shrink-0 cursor-grab text-text-subtle sm:block"
          aria-hidden="true"
        />
        <Input
          aria-label="Line label"
          className="h-9 min-w-0 flex-1"
          value={line.label}
          placeholder="Label"
          onChange={(e) => onChange({ label: e.target.value })}
        />
        <p className="shrink-0 text-right whitespace-nowrap">
          <span className="font-semibold text-text">
            {resolved ? (
              <Money
                value={hasPrimaryPaySchedule ? resolved.perPayCents : resolved.perMonthCents}
                tween={!typing}
              />
            ) : (
              "—"
            )}
          </span>
          <span className="block text-xs text-text-subtle">/{cadenceLabel}</span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={line.basis} onValueChange={(v) => onChange({ basis: /** @type {Basis} */ (v) })}>
          <SelectTrigger className="h-9 w-36" aria-label="Basis">
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
        <LineValueInput line={line} onChange={onChange} />
        <Select value={line.accountId} onValueChange={(v) => onChange({ accountId: v })}>
          <SelectTrigger className="h-9 w-36" aria-label="Destination">
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
        <InputGroup className="h-9 w-24">
          <InputGroupInput
            aria-label="Goal percent of gross"
            type="number"
            step="0.01"
            inputMode="decimal"
            placeholder="Goal"
            value={line.goalPctText}
            onChange={(e) => onChange({ goalPctText: e.target.value })}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText className="text-xs">%</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        <div className="ml-auto flex items-center gap-0.5">
          <Button size="icon" variant="ghost" aria-label="Move up" onClick={() => onMove(-1)}>
            <ChevronUpIcon />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Move down" onClick={() => onMove(1)}>
            <ChevronDownIcon />
          </Button>
          <Select value={String(line.stage)} onValueChange={(v) => onStageChange(Number(v))}>
            <SelectTrigger className="h-8 w-24" aria-label="Stage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {stages.map((stage) => (
                <SelectItem key={stage} value={String(stage)}>
                  Stage {stage}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="icon" variant="ghost" className="text-negative" aria-label="Remove line" onClick={onRemove}>
            <Trash2Icon />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <p className="text-text-subtle">{ALLOCATION_BASIS_HINTS[line.basis]}</p>
        {resolved ? (
          <p className="flex items-center gap-2 text-text-muted">
            <span>
              <Money value={resolved.perMonthCents} tween={!typing} />
              <span className="text-text-subtle">/month</span>
            </span>
            {resolved.actualPct != null ? <span>{resolved.actualPct.toFixed(2)}% of gross</span> : null}
            {resolved.fidelity != null ? <Delta value={resolved.fidelity * 100} kind="pct" /> : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The same line with no draft open: the applied version, stated rather than
 * offered for editing. A screen full of disabled inputs would say "broken"
 * where this says "this is what's live — open a draft to change it".
 *
 * @param {{
 *   line: DraftLine, resolved: AllocationResult["lines"][number] | undefined, accounts: Account[],
 *   payCadence: Cadence, hasPrimaryPaySchedule: boolean,
 * }} props
 */
function AppliedLineRow({ line, resolved, accounts, payCadence, hasPrimaryPaySchedule }) {
  const kind = ALLOCATION_BASIS_VALUE_KIND[line.basis];
  const valueSuffix =
    kind === "percent" && line.valueText !== ""
      ? ` ${line.valueText}%`
      : kind === "money" && line.valueText !== ""
        ? ` $${line.valueText}/month`
        : kind === "weight" && line.valueText !== ""
          ? ` weight ${line.valueText}`
          : "";

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="font-medium text-text">{line.label || "Untitled line"}</p>
        <p className="text-xs text-text-muted">
          {ALLOCATION_BASIS_LABELS[line.basis]}
          {valueSuffix} → {accountName(accounts, line.accountId)}
        </p>
      </div>
      <div className="text-right">
        <p className="font-semibold text-text whitespace-nowrap">
          {resolved ? <Money value={hasPrimaryPaySchedule ? resolved.perPayCents : resolved.perMonthCents} /> : "—"}
          <span className="text-xs font-normal text-text-subtle">
            /{hasPrimaryPaySchedule ? CADENCE_LABELS[payCadence].toLowerCase() : "month"}
          </span>
        </p>
        <p className="flex items-center justify-end gap-2 text-xs text-text-muted">
          {resolved ? (
            <span>
              <Money value={resolved.perMonthCents} />
              <span className="text-text-subtle">/month</span>
            </span>
          ) : null}
          {line.goalPctText !== "" ? <span>goal {line.goalPctText}%</span> : null}
          {resolved?.fidelity != null ? <Delta value={resolved.fidelity * 100} kind="pct" /> : null}
        </p>
      </div>
    </div>
  );
}

/**
 * @param {{
 *   stage: number, lines: DraftLine[], result: AllocationResult, inputs: AllocationInputs,
 *   accounts: Account[], stages: number[], readOnly: boolean, dragTargetId: string | null,
 *   onChange: (id: string, patch: Partial<DraftLine>) => void, onRemove: (id: string) => void,
 *   onMove: (id: string, direction: -1 | 1) => void, onStageChange: (id: string, stage: number) => void,
 *   onAddLine: () => void,
 *   onDragStart: (id: string) => void, onDragOver: (id: string) => void, onDrop: (id: string) => void,
 *   onDragEnd: () => void,
 * }} props
 */
function StageSection({
  stage,
  lines,
  result,
  inputs,
  accounts,
  stages,
  readOnly,
  dragTargetId,
  onChange,
  onRemove,
  onMove,
  onStageChange,
  onAddLine,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}) {
  const stageResult = result.stages.find((s) => s.stage === stage) ?? null;
  const entryRemaining = remainingAtStageStart(result, stage, inputs.grossPerMonthCents);
  // Only the rows whose amount actually depends on it get told what remaining
  // was — no hunting, and no noise on the rows where it's irrelevant
  // (phases/08-allocation.md "Stage editor").
  const hasRemainingBasis = lines.some((l) => l.basis === "pct_of_remaining" || l.basis === "sweep");
  const resolvedById = new Map(result.lines.map((l) => [l.lineId, l]));

  return (
    <section className="flex flex-col gap-3 rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-base font-semibold text-text">Stage {stage}</h2>
        {hasRemainingBasis ? (
          <p className="text-xs text-text-muted">
            Remaining when this stage starts: <Money value={entryRemaining} tween className="font-medium text-text" />
            <span className="text-text-subtle">/month</span>
          </p>
        ) : null}
      </header>

      {readOnly ? (
        <div className="flex flex-col">
          {lines.map((line) => (
            <AppliedLineRow
              key={line.id}
              line={line}
              resolved={resolvedById.get(line.id)}
              accounts={accounts}
              payCadence={inputs.payCadence}
              hasPrimaryPaySchedule={inputs.hasPrimaryPaySchedule}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {lines.map((line) => (
            <DraftLineCard
              key={line.id}
              line={line}
              resolved={resolvedById.get(line.id)}
              accounts={accounts}
              stages={stages}
              payCadence={inputs.payCadence}
              hasPrimaryPaySchedule={inputs.hasPrimaryPaySchedule}
              isDragTarget={dragTargetId === line.id}
              onChange={(patch) => onChange(line.id, patch)}
              onRemove={() => onRemove(line.id)}
              onMove={(direction) => onMove(line.id, direction)}
              onStageChange={(next) => onStageChange(line.id, next)}
              onDragStart={() => onDragStart(line.id)}
              onDragOver={() => onDragOver(line.id)}
              onDrop={() => onDrop(line.id)}
              onDragEnd={onDragEnd}
            />
          ))}
        </div>
      )}

      {stageResult ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-border pt-3 text-xs">
          <p className="font-medium text-text-muted">Stage {stage} subtotal</p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              <Money value={stageResult.subtotalPerMonthCents} tween className="font-semibold text-text" />
              <span className="text-text-subtle">/month</span>
            </span>
            {stageResult.goalPct != null ? <span className="text-text-muted">goal {stageResult.goalPct}%</span> : null}
            {stageResult.actualPct != null ? (
              <span className="text-text-muted">actual {stageResult.actualPct.toFixed(2)}%</span>
            ) : null}
            {stageResult.fidelity != null ? <Delta value={stageResult.fidelity * 100} kind="pct" /> : null}
            <span className="text-text-muted">
              left <Money value={stageResult.remainingPerMonthCents} tween className="font-medium text-text" />
            </span>
          </p>
        </div>
      ) : null}

      {readOnly ? null : (
        <div>
          <Button size="sm" variant="outline" onClick={onAddLine}>
            <PlusIcon />
            Add line to stage {stage}
          </Button>
        </div>
      )}
    </section>
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
 * @param {{ row: TransferRow, editing: boolean, onCopy: (cents: Cents) => void }} props
 */
function TransferRowItem({ row, editing, onCopy }) {
  const changed = !row.isNoOp && row.deltaPerPayCents !== null && row.deltaPerPayCents !== 0;
  const amount = row.newPerPayCents ?? row.currentPerPayCents;
  const flashing = useFlashOnChange(row.newPerPayCents);

  return (
    <li
      className={cn(
        "flex items-start justify-between gap-3 py-2",
        changed && "-mx-2 rounded-(--radius-control) bg-accent-brand-soft/40 px-2",
        flashing && "animate-row-flash",
      )}
    >
      <div className="min-w-0">
        <p className={cn("truncate text-sm font-medium", row.isNoOp ? "text-text-muted" : "text-text")}>
          {row.name}
        </p>
        {row.isNoOp ? (
          <p className="text-xs text-text-subtle">no move required</p>
        ) : editing && !changed ? (
          <p className="text-xs text-text-subtle">unchanged</p>
        ) : null}
      </div>
      <div className="shrink-0 text-right">
        <p className="flex items-center justify-end gap-1 whitespace-nowrap">
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
        <p className="flex items-center justify-end gap-2 text-xs whitespace-nowrap text-text-subtle">
          <span>
            <Money value={row.newPerMonthCents} tween />
            /month
          </span>
          {changed && row.currentPerPayCents !== null ? (
            <>
              <span>
                was <Money value={row.currentPerPayCents} />
              </span>
              <Delta value={row.deltaPerPayCents ?? 0} kind="cents" />
            </>
          ) : null}
        </p>
      </div>
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
 * @param {{ rows: TransferRow[], inputs: AllocationInputs, editing: boolean, totalPerPayCents: Cents }} props
 */
function TransfersPanel({ rows, inputs, editing, totalPerPayCents }) {
  const { currency, locale } = useSettings();
  const cadenceLabel = inputs.hasPrimaryPaySchedule ? CADENCE_LABELS[inputs.payCadence].toLowerCase() : "month";
  const reconciles = totalPerPayCents === inputs.grossPerPayCents;
  const actionable = rows.filter((r) => !r.isNoOp && r.deltaPerPayCents !== null && r.deltaPerPayCents !== 0);

  /** @param {Cents} cents */
  async function copyAmount(cents) {
    // Exactly what gets typed into the bank: no symbol, no thousands
    // separator (phases/08-allocation.md "Acceptance criteria").
    try {
      await navigator.clipboard.writeText((cents / 100).toFixed(2));
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
        <p className="flex items-start gap-1.5 rounded-lg bg-negative-soft p-2 text-xs text-negative">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          Transfers total {formatMoney(totalPerPayCents, { currency, locale })} but gross income is{" "}
          {formatMoney(inputs.grossPerPayCents, { currency, locale })}. That&apos;s a bug — please report it.
        </p>
      )}
    </div>
  );
}

/**
 * Goal versus actual per line, and `goodLifeFidelityCents` in plain language
 * via the shared <GoodLifeFidelity> (the sign is easy to get backwards, so it
 * lives in one place — phases/08-allocation.md "Fidelity").
 *
 * @param {{ result: AllocationResult, lines: DraftLine[], inputs: AllocationInputs }} props
 */
function FidelityPanel({ result, lines, inputs }) {
  const withGoals = result.lines.filter((l) => l.fidelity !== null);
  const labelOf = (/** @type {string} */ lineId) => lines.find((l) => l.id === lineId)?.label || "Untitled line";

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-text">Fidelity</h3>
      <p className="rounded-lg bg-surface-muted p-3 text-sm text-text">
        <GoodLifeFidelity
          cents={result.goodLifeFidelityCents}
          targetPerMonthCents={inputs.variableNonEssentialPerMonthCents}
        />
      </p>
      {withGoals.length === 0 ? (
        <p className="text-xs text-text-muted">No line has a goal set — add one to track fidelity.</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {withGoals.map((line) => (
            <li key={line.lineId} className="flex items-center justify-between gap-2">
              <span className="truncate text-text">{labelOf(line.lineId)}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
                {line.actualPct != null ? `${line.actualPct.toFixed(2)}%` : "—"}
                <Delta value={(line.fidelity ?? 0) * 100} kind="pct" />
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
 *   rows: TransferRow[], inputs: AllocationInputs, editing: boolean, result: AllocationResult,
 *   accounts: Account[], lines: DraftLine[], totalPerPayCents: Cents, withSankey: boolean,
 * }} props
 */
function PreviewPanel({ rows, inputs, editing, result, accounts, lines, totalPerPayCents, withSankey }) {
  return (
    <div className="flex flex-col gap-6">
      <TransfersPanel rows={rows} inputs={inputs} editing={editing} totalPerPayCents={totalPerPayCents} />
      {withSankey ? (
        <AllocationSankey result={result} accounts={accounts} lines={lines} />
      ) : (
        <AllocationProportionBar result={result} accounts={accounts} />
      )}
      <FidelityPanel result={result} lines={lines} inputs={inputs} />
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
    <div className="fixed inset-x-0 bottom-14 z-30 px-2 md:bottom-0 lg:hidden">
      <div className="mx-auto max-w-2xl overflow-hidden rounded-t-(--radius-card) border border-border bg-surface shadow-(--shadow-raised)">
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
        {open ? <div className="max-h-[55vh] overflow-y-auto border-t border-border px-4 py-4">{children}</div> : null}
      </div>
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
  const [compare, setCompare] = useState(/** @type {[string, string] | null} */ (null));

  const left = compare ? versions.find((v) => v.id === compare[0]) ?? null : null;
  const right = compare ? versions.find((v) => v.id === compare[1]) ?? null : null;

  return (
    <section className="flex flex-col gap-4 rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
      <div className="flex items-center gap-2">
        <HistoryIcon className="size-4 text-text-muted" aria-hidden="true" />
        <h2 className="text-base font-semibold text-text">Version history</h2>
      </div>

      <ol className="flex flex-col divide-y divide-border">
        {versions.map((version) => (
          <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium text-text">
                v{version.version}
                <Badge
                  variant={
                    version.status === "active" ? "default" : version.status === "draft" ? "secondary" : "outline"
                  }
                >
                  {version.status}
                </Badge>
                <span className="text-xs font-normal text-text-muted">{version.lines.length} lines</span>
              </p>
              <p className="text-xs text-text-muted">
                {version.createdByName ?? "Seeded"} · {formatIsoDate(version.createdAt.slice(0, 10), "en-AU")}
                {version.activatedAt
                  ? ` · applied ${formatIsoDate(version.activatedAt.slice(0, 10), "en-AU")}`
                  : ""}
                {version.note ? ` · ${version.note}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
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
 * @param {{
 *   open: boolean, onOpenChange: (open: boolean) => void, rows: TransferRow[], inputs: AllocationInputs,
 *   unallocatedPerMonthCents: Cents, submitting: boolean, onApply: (note: string | null) => void,
 * }} props
 */
function ApplyDialog({ open, onOpenChange, rows, inputs, unallocatedPerMonthCents, submitting, onApply }) {
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
          <p className="flex items-start gap-2 rounded-lg bg-negative-soft p-3 text-sm text-negative">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Unallocated is <Money value={unallocatedPerMonthCents} signed /> per month, not zero. You can still apply
            this — nothing will be rebalanced for you.
          </p>
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
          <Button disabled={submitting} onClick={() => onApply(note.trim() === "" ? null : note.trim())}>
            {submitting ? "Applying…" : "Apply draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Divides income into destinations and answers the one question the operator
 * actually has: if I change this percentage, what does every standing transfer
 * become? Edit freely, see the complete before-and-after, apply or discard —
 * the app never adjusts a figure on its own (phases/08-allocation.md).
 */
export function AllocationPage() {
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(LG);
  const search = useSearch({ strict: false });
  const queryClient = useQueryClient();

  const on = typeof search.on === "string" ? search.on : todayIso();
  const [applyOpen, setApplyOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dragTargetId, setDragTargetId] = useState(/** @type {string | null} */ (null));
  const draggingIdRef = useRef(/** @type {string | null} */ (null));
  const savedSignatureRef = useRef(/** @type {string | null} */ (null));

  const lines = useAllocationDraft((s) => s.lines);
  const dirty = useAllocationDraft((s) => s.dirty);
  const draftVersionId = useAllocationDraft((s) => s.versionId);
  const loadDraft = useAllocationDraft((s) => s.load);
  const resetDraft = useAllocationDraft((s) => s.reset);
  const markSaved = useAllocationDraft((s) => s.markSaved);
  const updateLine = useAllocationDraft((s) => s.updateLine);
  const addLine = useAllocationDraft((s) => s.addLine);
  const removeLine = useAllocationDraft((s) => s.removeLine);
  const moveLine = useAllocationDraft((s) => s.moveLine);
  const moveLineBefore = useAllocationDraft((s) => s.moveLineBefore);
  const setLineStage = useAllocationDraft((s) => s.setLineStage);
  const addStage = useAllocationDraft((s) => s.addStage);

  const undoDepth = useStore(allocationDraftHistory, (s) => s.pastStates.length);
  const redoDepth = useStore(allocationDraftHistory, (s) => s.futureStates.length);

  const plansQuery = useQuery({
    queryKey: ["allocation-plans"],
    queryFn: async () => {
      const res = await api["allocation-plans"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {{ plans: Plan[] }} */ (await res.json()).plans;
    },
  });

  const variantsQuery = useQuery({
    queryKey: ["income-variants"],
    queryFn: async () => {
      const res = await api["income-variants"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).variants;
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

  const plans = plansQuery.data ?? [];
  const accounts = accountsQuery.data ?? [];
  const variantNames = useMemo(
    () => new Map((variantsQuery.data ?? []).map((v) => [v.id, v.name])),
    [variantsQuery.data],
  );
  const selectedPlanId = typeof search.plan === "string" ? search.plan : plans[0]?.id;
  const plan = plans.find((p) => p.id === selectedPlanId) ?? null;

  const previewQuery = useQuery({
    queryKey: ["allocation-preview", selectedPlanId, on],
    queryFn: async () => {
      const res = await api.allocation.preview.$get({ query: { planId: selectedPlanId ?? "", on } });
      if (!res.ok) throw new Error(await readApiError(res));
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
  const serverDraft = preview?.draft ?? null;
  const editing = serverDraft !== null;

  // Adopt the server's draft when it isn't the one already loaded — a fresh
  // page load, a different plan, or the other session having saved. Never
  // while there are unsaved local edits: their work wins until they save.
  useEffect(() => {
    if (!serverDraft) {
      resetDraft();
      savedSignatureRef.current = null;
      return;
    }
    const signature = serverLinesSignature(serverDraft.version.lines);
    const isNewVersion = serverDraft.version.id !== draftVersionId;
    if (isNewVersion || (!dirty && signature !== savedSignatureRef.current)) {
      loadDraft(serverDraft.version.id, serverDraft.version.lines);
      savedSignatureRef.current = signature;
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
    });
  }, [inputs, lines]);

  const shownResult = editing ? draftResult : activeResult;
  const diff = useMemo(
    () => (activeResult && draftResult && editing ? diffAllocations(activeResult, draftResult) : null),
    [activeResult, draftResult, editing],
  );

  const transferRows = useMemo(
    () => buildTransferRows({ active: activeResult, draft: editing ? draftResult : null, diff, accounts }),
    [activeResult, draftResult, diff, accounts, editing],
  );

  const totalPerPayCents = shownResult ? sumCents(shownResult.transfers.map((t) => t.perPayCents)) : 0;
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

  const stages = stageNumbers(shownLines);

  const savePayload = useMemo(() => draftLinesToPayload(lines), [lines]);
  const localSignature = useMemo(() => draftLinesSignature(lines), [lines]);

  const saveLines = useMutation({
    mutationFn: async () => {
      if (!draftVersionId) return null;
      const res = await api["allocation-versions"][":id"].lines.$put({
        param: { id: draftVersionId },
        json: { lines: savePayload },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: (result) => {
      if (!result) return;
      markSaved();
      savedSignatureRef.current = serverLinesSignature(result.version.lines);
      queryClient.invalidateQueries({ queryKey: ["allocation-versions", selectedPlanId] });
    },
    onError: (err) => toast.error(err.message),
  });

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
      savedSignatureRef.current = null;
      queryClient.invalidateQueries({ queryKey: ["allocation-preview"] });
      queryClient.invalidateQueries({ queryKey: ["allocation-plans"] });
      queryClient.invalidateQueries({ queryKey: ["allocation-versions", selectedPlanId] });
      toast.success("Draft discarded.");
    },
    onError: (err) => toast.error(err.message),
  });

  const applyDraft = useMutation({
    mutationFn: async (/** @type {string | null} */ note) => {
      // Flush any pending edit first: apply must promote what's on screen,
      // not the last autosave.
      if (dirty) await saveLines.mutateAsync();
      const res = await api["allocation-plans"][":id"].draft.apply.$post({
        param: { id: selectedPlanId ?? "" },
        json: { note },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: (result) => {
      setApplyOpen(false);
      resetDraft();
      savedSignatureRef.current = null;
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
    const timer = setTimeout(() => saveLines.mutate(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, localSignature, draftVersionId, discardDraft.isPending, applyDraft.isPending]);

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
      await navigator.clipboard.writeText(text);
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
          run: () => (editing ? discardDraft.mutate() : toast.info("No draft to discard.")),
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

  const previewError = previewQuery.error ? previewQuery.error.message : null;
  const defaultAccountId = accounts[0]?.id ?? "";

  if (!plansQuery.isLoading && plans.length === 0) {
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
        description="Edit freely — nothing changes your standing transfers until you apply. Every figure comes from the engine; nothing is rebalanced for you."
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
                <Button variant="ghost" disabled={discardDraft.isPending} onClick={() => discardDraft.mutate()}>
                  Discard
                </Button>
                <Button onClick={() => setApplyOpen(true)}>
                  <CheckIcon />
                  Apply draft
                </Button>
              </>
            ) : (
              <Button disabled={createDraft.isPending || !selectedPlanId} onClick={() => createDraft.mutate()}>
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
        onPlanChange={selectPlan}
        onDateChange={selectDate}
      />

      {previewError ? (
        <EmptyState
          icon={AlertTriangleIcon}
          title="Can't compute this allocation yet"
          description={previewError}
        />
      ) : null}

      {preview?.warnings?.length ? (
        <div className="flex flex-col gap-2 rounded-(--radius-card) bg-warning-soft p-4">
          {preview.warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-2 text-sm text-text">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {w.message}
            </p>
          ))}
        </div>
      ) : null}

      {editing && dirty ? (
        <p className="text-xs text-text-muted">
          {saveLines.isPending ? "Saving draft…" : "Unsaved changes — saving shortly."}
        </p>
      ) : null}

      {inputs && shownResult ? (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="flex flex-col gap-4">
            <UnallocatedIndicator
              result={shownResult}
              payCadence={inputs.payCadence}
              hasPrimaryPaySchedule={inputs.hasPrimaryPaySchedule}
            />

            {shownLines.length === 0 ? (
              <EmptyState
                icon={ArrowLeftRightIcon}
                title={editing ? "No lines yet" : "This version has no lines"}
                description={
                  editing
                    ? "Start with the two totals you never type by hand — a 'From fixed costs' line and a 'From variable essentials' line — then add your savings percentages."
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
              stages.map((stage) => (
                <StageSection
                  key={stage}
                  stage={stage}
                  lines={shownLines.filter((l) => l.stage === stage)}
                  result={shownResult}
                  inputs={inputs}
                  accounts={accounts}
                  stages={stages}
                  readOnly={!editing}
                  dragTargetId={dragTargetId}
                  onChange={updateLine}
                  onRemove={removeLine}
                  onMove={moveLine}
                  onStageChange={setLineStage}
                  onAddLine={() => addLine(stage, defaultAccountId)}
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
                />
              ))
            )}

            {editing && shownLines.length > 0 ? (
              <div>
                <Button size="sm" variant="outline" onClick={() => addStage(defaultAccountId)}>
                  <PlusIcon />
                  Add stage {stages.length > 0 ? Math.max(...stages) + 1 : 1}
                </Button>
              </div>
            ) : null}
          </div>

          {/* `hidden lg:block` alone would still MOUNT the panel below lg, and
              its sankey initialises inside `display: none` at 0x0 — echarts
              logs "Can't get DOM width or height" and draws nothing. The
              media query keeps it out of the tree entirely; the classes stay
              for the layout. */}
          <aside className="sticky top-4 hidden rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card) lg:block">
            {isDesktop ? (
              <PreviewPanel
                rows={transferRows}
                inputs={inputs}
                editing={editing}
                result={shownResult}
                accounts={accounts}
                lines={shownLines}
                totalPerPayCents={totalPerPayCents}
                withSankey
              />
            ) : null}
          </aside>
        </div>
      ) : null}

      {versionsQuery.data && versionsQuery.data.length > 0 ? (
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
          {/* Spacer so the drawer never covers the last stage on mobile. */}
          <div className="h-16 lg:hidden" aria-hidden="true" />
          <MobilePreviewDrawer
            open={previewOpen}
            onToggle={() => setPreviewOpen((v) => !v)}
            summary={
              <span className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium text-text">Preview</span>
                <span className={shownResult.unallocatedPerMonthCents === 0 ? "text-positive" : "text-negative"}>
                  Unallocated <Money value={shownResult.unallocatedPerMonthCents} />
                </span>
                {editing ? (
                  <span className="text-text-muted">
                    · {changedCount} transfer{changedCount === 1 ? "" : "s"} change
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
              lines={shownLines}
              totalPerPayCents={totalPerPayCents}
              withSankey={false}
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

  const variantsQuery = useQuery({
    queryKey: ["income-variants"],
    queryFn: async () => {
      const res = await api["income-variants"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).variants;
    },
  });

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

  const variants = variantsQuery.data ?? [];

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
