import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { addDaysIso, periodsBetween, toCents } from "@budget/engine";
import {
  AlertTriangleIcon,
  BanknoteIcon,
  CheckCircle2Icon,
  PencilIcon,
  PlusIcon,
  ShieldIcon,
  TargetIcon,
  Trash2Icon,
  TrendingUpIcon,
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
import { Chart } from "@/components/chart.jsx";
import { Delta } from "@/components/delta.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { Money } from "@/components/money.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { QuickBalanceSheet } from "@/components/quick-balance-sheet.jsx";
import { StatTile } from "@/components/stat-tile.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { CADENCE_LABELS, CADENCE_PERIOD_NOUNS } from "@/lib/constants.js";
import { formatIsoDate, todayIso } from "@/lib/dates.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";
import { cn } from "@/lib/utils.js";

/** @import { Cadence, Cents } from "@budget/engine" */

/** @typedef {{ id: string, name: string, type: "transaction" | "savings" | "investment" | "external", latestBalance: { amountCents: Cents, asAt: string } | null }} Account */
/** @typedef {{ months: number, targetCents: Cents, covered: boolean, eta: string | null, periodsToReach: number | null, approxMonthsToReach: number | null }} Threshold */
/**
 * @typedef {{
 *   goal: {
 *     id: string, accountId: string, name: string,
 *     targetMode: "amount" | "months_of_expenses",
 *     targetAmountCents: Cents | null, targetMonths: number | null,
 *     targetDate: string | null, note: string | null,
 *     status: "active" | "achieved" | "abandoned", createdAt: string,
 *   },
 *   account: { id: string, name: string, type: string, annualGrowthRate: number | null },
 *   targetCents: Cents,
 *   currentBalanceCents: Cents,
 *   currentBalanceAsAt: string | null,
 *   contributionPerPayCents: Cents,
 *   contributionPerMonthCents: Cents,
 *   isFunded: boolean,
 *   progressPct: number,
 *   reached: boolean,
 *   eta: { date: string | null, aheadBehindDays: number | null },
 *   beyondHorizon: boolean,
 *   horizonYears: number,
 *   required: { perPayCents: Cents, perMonthCents: Cents, pctOfGross: number, feasible: boolean } | null,
 *   curve: { date: string, projectedCents: Cents, targetCents: Cents }[],
 *   monthsCovered: number | null,
 *   thresholds: Threshold[] | null,
 * }} Goal
 */
/**
 * @typedef {{
 *   on: string, activeCount: number, payCadence: Cadence, hasPrimaryPaySchedule: boolean,
 *   monthlyEssentialBurnCents: Cents, grossPerMonthCents: Cents,
 *   allocationPlan: { id: string, name: string } | null,
 *   totalRequiredPerPayCents: Cents, totalAllocatedToGoalsPerPayCents: Cents,
 *   shortfallPerPayCents: Cents, goalsWithDeadline: number,
 * }} GoalsSummary
 */

const TARGET_MODES = /** @type {const} */ (["amount", "months_of_expenses"]);

/** @type {Record<(typeof TARGET_MODES)[number], string>} */
const TARGET_MODE_LABELS = {
  amount: "A dollar amount",
  months_of_expenses: "Months of expenses",
};

/**
 * "39 fortnights, about 18 months" — never weeks. The source spreadsheet
 * labelled a column of fortnights "Weeks to save" and understated every
 * emergency-fund timeline by half (phases/09-goals-projections.md "/goals").
 *
 * @param {number | null} periods
 * @param {number | null} approxMonths
 * @param {Cadence} payCadence
 */
function durationLabel(periods, approxMonths, payCadence) {
  if (periods === null) return "—";
  const [singular, plural] = CADENCE_PERIOD_NOUNS[payCadence];
  const periodPart = `${periods} ${periods === 1 ? singular : plural}`;
  // Months are the second unit, and only when they add something: "2 months,
  // about 2 months" is noise.
  if (approxMonths === null || payCadence === "monthly") return periodPart;
  return `${periodPart}, about ${approxMonths} month${approxMonths === 1 ? "" : "s"}`;
}

/**
 * @param {{ goal: Goal, summary: GoalsSummary }} props
 */
function ProgressBar({ goal }) {
  const pct = Math.max(0, Math.min(100, goal.progressPct));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-semibold text-text">
          <Money value={goal.currentBalanceCents} />
          <span className="font-normal text-text-muted">
            {" of "}
            <Money value={goal.targetCents} />
          </span>
        </span>
        <span className={cn("text-xs font-medium", goal.reached ? "text-positive" : "text-text-muted")}>
          {goal.progressPct.toFixed(1)}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
        <div
          className={cn("h-full rounded-full", goal.reached ? "bg-positive" : "bg-accent-brand")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-text-subtle">
        {goal.currentBalanceAsAt ? (
          <>Balance as at {formatIsoDate(goal.currentBalanceAsAt, "en-AU")}</>
        ) : (
          <>No balance recorded yet</>
        )}
      </p>
    </div>
  );
}

/**
 * ETA and required contribution side by side, given equal weight because they
 * answer different questions (phases/09-goals-projections.md "/goals").
 *
 * @param {{ goal: Goal, summary: GoalsSummary }} props
 */
function EtaAndRequired({ goal, summary }) {
  const perPeriod = CADENCE_PERIOD_NOUNS[summary.payCadence][0];
  const aheadBehind = goal.eta.aheadBehindDays;
  // Days for a near miss, months once it runs to years — "20061 days sooner"
  // is a true number that tells the operator nothing.
  const aheadBehindLabel =
    aheadBehind === null || aheadBehind <= 0
      ? null
      : aheadBehind < 60
        ? `${aheadBehind} days`
        : `about ${periodsBetween(summary.on, addDaysIso(summary.on, aheadBehind), "monthly")} months`;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="rounded-(--radius-control) bg-surface-muted p-3">
        <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
          At the current contribution
        </p>
        {goal.reached ? (
          <p className="mt-1 flex items-center gap-1.5 text-lg font-semibold text-positive">
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
            Reached
          </p>
        ) : goal.eta.date ? (
          <>
            <p className="mt-1 text-lg font-semibold text-text">{formatIsoDate(goal.eta.date, "en-AU")}</p>
            <p className="text-xs text-text-muted">
              {durationLabel(
                periodsBetween(summary.on, goal.eta.date, summary.payCadence),
                periodsBetween(summary.on, goal.eta.date, "monthly"),
                summary.payCadence,
              )}
              {aheadBehindLabel ? ` · growth brings it ${aheadBehindLabel} sooner` : ""}
            </p>
          </>
        ) : (
          <>
            <p className="mt-1 text-lg font-semibold text-text-muted">—</p>
            <p className="text-xs text-text-muted">
              {goal.beyondHorizon
                ? `Not within ${goal.horizonYears} years at this contribution.`
                : "Nothing is being contributed to this account."}
            </p>
          </>
        )}
        <p className="mt-2 text-xs text-text-muted">
          {goal.isFunded ? (
            <>
              <Money value={goal.contributionPerPayCents} className="font-medium text-text" /> per {perPeriod} ·{" "}
              <Money value={goal.contributionPerMonthCents} />
              /month
            </>
          ) : (
            <span className="text-negative">Not currently funded</span>
          )}
        </p>
      </div>

      <div className="rounded-(--radius-control) bg-surface-muted p-3">
        <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
          {goal.goal.targetDate ? `To hit ${formatIsoDate(goal.goal.targetDate, "en-AU")}` : "To hit a deadline"}
        </p>
        {goal.required ? (
          <>
            <p className="mt-1 text-lg font-semibold text-text">
              <Money value={goal.required.perPayCents} />
              <span className="text-sm font-normal text-text-muted"> per {perPeriod}</span>
            </p>
            <p className="text-xs text-text-muted">
              <Money value={goal.required.perMonthCents} />
              /month · <span className="font-medium text-text">{goal.required.pctOfGross.toFixed(2)}%</span> of gross
            </p>
            {goal.required.feasible ? null : (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-negative">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                Not achievable at any allocation — this needs more than the household earns.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="mt-1 text-lg font-semibold text-text-muted">—</p>
            <p className="text-xs text-text-muted">No target date set, so there is nothing to catch up to.</p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Projected balance against the target. Where a target date exists, a second
 * line runs straight from today's balance to the target on that date — the
 * pace the goal would have to keep.
 *
 * @param {{ goal: Goal, summary: GoalsSummary }} props
 */
function GoalCurve({ goal, summary }) {
  const { currency, locale } = useSettings();

  const option = useMemo(
    () =>
      /** @param {import("@/components/chart.jsx").ChartTokens} tokens */
      (tokens) => {
        const dates = goal.curve.map((p) => p.date);
        const paceLine =
          goal.goal.targetDate && goal.curve[0]
            ? [
                [goal.curve[0].date, goal.currentBalanceCents / 100],
                [goal.goal.targetDate, goal.targetCents / 100],
              ]
            : null;

        return {
          grid: { top: 16, left: 8, right: 12, bottom: 8, containLabel: true },
          xAxis: { type: "time" },
          yAxis: { type: "value" },
          tooltip: {
            trigger: "axis",
            /** @param {{ seriesName: string, value: [string, number] }[]} params */
            formatter: (params) =>
              params
                .map(
                  (p) =>
                    `${p.seriesName}: ${new Intl.NumberFormat(locale, { style: "currency", currency }).format(p.value[1])}`,
                )
                .join("<br/>"),
          },
          series: [
            {
              type: "line",
              name: "Projected",
              data: goal.curve.map((p) => [p.date, p.projectedCents / 100]),
              smooth: true,
              showSymbol: false,
              lineStyle: { width: 2, color: tokens.series[0] },
              itemStyle: { color: tokens.series[0] },
              areaStyle: { color: tokens.accentSoft, opacity: 0.5 },
            },
            {
              type: "line",
              name: "Target",
              data: dates.map((date) => [date, goal.targetCents / 100]),
              showSymbol: false,
              lineStyle: { type: "dashed", width: 1.5, color: tokens.series[2] },
              itemStyle: { color: tokens.series[2] },
            },
            ...(paceLine
              ? [
                  {
                    type: "line",
                    name: "Pace to target date",
                    data: paceLine,
                    showSymbol: false,
                    lineStyle: { type: "dotted", width: 1.5, color: tokens.series[3] },
                    itemStyle: { color: tokens.series[3] },
                  },
                ]
              : []),
          ],
        };
      },
    [goal, currency, locale],
  );

  return (
    <Chart
      option={option}
      height={160}
      ariaLabel={`Projected balance for ${goal.goal.name} against a target of ${formatMoney(goal.targetCents, { currency, locale })}, currently ${formatMoney(goal.currentBalanceCents, { currency, locale })}.`}
      dataTable={{
        caption: `Projected balance for ${goal.goal.name}, against its target`,
        columns: ["Date", "Projected", "Target"],
        rows: goal.curve.map((point) => [
          formatIsoDate(point.date, locale),
          formatMoney(point.projectedCents, { currency, locale }),
          formatMoney(goal.targetCents, { currency, locale }),
        ]),
      }}
      empty={goal.curve.length < 2}
      emptyTitle="Nothing to project yet"
      emptyDescription={
        goal.isFunded ? "This goal is already at its target." : "Fund this account from an allocation line to see a curve."
      }
    />
  );
}

/**
 * The emergency fund's own treatment: how long the household could last as the
 * dominant figure, with the 1 / 3 / 6 / 12-month markers and how long each
 * takes at the current contribution (phases/09-goals-projections.md "/goals").
 *
 * @param {{ goal: Goal, summary: GoalsSummary }} props
 */
function ExpenseCoverPanel({ goal, summary }) {
  const covered = goal.monthsCovered ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-3xl font-bold tracking-tight text-text">
            {covered.toFixed(1)} <span className="text-base font-medium text-text-muted">months of expenses</span>
          </p>
          <p className="text-xs text-text-muted">
            covered · essentials run <Money value={summary.monthlyEssentialBurnCents} className="font-medium text-text" />
            /month
          </p>
        </div>
        <p className="text-xs text-text-subtle">
          Target moves with your costs — it is {goal.goal.targetMonths} × this month&apos;s essentials, not a fixed
          figure.
        </p>
      </div>

      <ul className="flex flex-col divide-y divide-border">
        {(goal.thresholds ?? []).map((threshold) => (
          <li
            key={threshold.months}
            // Wraps rather than truncates: at 375px the duration is the long
            // half, and squeezing "3 months" down to "3.." loses the row's
            // whole point.
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2"
          >
            <span className="flex shrink-0 items-center gap-2">
              {threshold.covered ? (
                <CheckCircle2Icon className="size-4 shrink-0 text-positive" aria-hidden="true" />
              ) : (
                <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                  <span className="size-1.5 rounded-full bg-text-subtle" />
                </span>
              )}
              <span className="text-sm whitespace-nowrap text-text">
                {threshold.months} month{threshold.months === 1 ? "" : "s"}
              </span>
              <span className="text-xs whitespace-nowrap text-text-subtle">
                <Money value={threshold.targetCents} />
              </span>
            </span>
            <span className="ml-6 text-xs text-text-muted sm:ml-0 sm:text-right">
              {threshold.covered ? (
                <span className="text-positive">covered</span>
              ) : threshold.eta ? (
                <>
                  {durationLabel(threshold.periodsToReach, threshold.approxMonthsToReach, summary.payCadence)}
                  <span className="text-text-subtle"> · {formatIsoDate(threshold.eta, "en-AU")}</span>
                </>
              ) : (
                "—"
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * @param {{
 *   goal: Goal, summary: GoalsSummary,
 *   onEdit: () => void, onDelete: () => void, onUpdateBalance: () => void,
 * }} props
 */
function GoalCard({ goal, summary, onEdit, onDelete, onUpdateBalance }) {
  const isCover = goal.goal.targetMode === "months_of_expenses";

  return (
    <section className="flex flex-col gap-4 rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-text">
            {isCover ? (
              <ShieldIcon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
            ) : (
              <TargetIcon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
            )}
            <span className="truncate">{goal.goal.name}</span>
            {goal.goal.status !== "active" ? <Badge variant="secondary">{goal.goal.status}</Badge> : null}
            {!goal.isFunded ? <Badge variant="outline">not currently funded</Badge> : null}
          </h2>
          <p className="text-xs text-text-muted">
            {goal.account.name}
            {goal.account.annualGrowthRate ? ` · ${(goal.account.annualGrowthRate * 100).toFixed(2)}% p.a. assumed` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onUpdateBalance}>
            <BanknoteIcon />
            Balance
          </Button>
          <Button size="icon" variant="ghost" aria-label="Edit goal" onClick={onEdit}>
            <PencilIcon />
          </Button>
          <Button size="icon" variant="ghost" className="text-negative" aria-label="Delete goal" onClick={onDelete}>
            <Trash2Icon />
          </Button>
        </div>
      </header>

      {isCover ? <ExpenseCoverPanel goal={goal} summary={summary} /> : null}

      <ProgressBar goal={goal} summary={summary} />
      <EtaAndRequired goal={goal} summary={summary} />
      <GoalCurve goal={goal} summary={summary} />

      {goal.goal.note ? <p className="text-xs text-text-muted">{goal.goal.note}</p> : null}
    </section>
  );
}

/**
 * @param {{
 *   open: boolean, onOpenChange: (open: boolean) => void, accounts: Account[],
 *   editing: Goal | null, submitting: boolean,
 *   onSubmit: (data: {
 *     accountId: string, name: string, targetMode: "amount" | "months_of_expenses",
 *     targetAmountCents: number | null, targetMonths: number | null,
 *     targetDate: string | null, note: string | null, status: "active" | "achieved" | "abandoned",
 *   }) => Promise<void>,
 * }} props
 */
function GoalFormDialog({ open, onOpenChange, accounts, editing, submitting, onSubmit }) {
  const pickable = accounts.filter((a) => a.type !== "external");
  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState(/** @type {(typeof TARGET_MODES)[number]} */ ("amount"));
  const [amount, setAmount] = useState("");
  const [months, setMonths] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState(/** @type {"active" | "achieved" | "abandoned"} */ ("active"));
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setAccountId(editing?.goal.accountId ?? pickable[0]?.id ?? "");
    setName(editing?.goal.name ?? "");
    setMode(editing?.goal.targetMode ?? "amount");
    setAmount(editing?.goal.targetAmountCents != null ? String(editing.goal.targetAmountCents / 100) : "");
    setMonths(editing?.goal.targetMonths != null ? String(editing.goal.targetMonths) : "");
    setTargetDate(editing?.goal.targetDate ?? "");
    setNote(editing?.goal.note ?? "");
    setStatus(editing?.goal.status ?? "active");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!accountId) return setError("Choose an account.");
    if (name.trim() === "") return setError("Name the goal.");
    if (mode === "amount" && amount.trim() === "") return setError("Enter a target amount.");
    if (mode === "months_of_expenses" && months.trim() === "") return setError("Enter a number of months.");
    try {
      await onSubmit({
        accountId,
        name: name.trim(),
        targetMode: mode,
        targetAmountCents: mode === "amount" ? toCents(Number(amount)) : null,
        targetMonths: mode === "months_of_expenses" ? Number(months) : null,
        targetDate: targetDate === "" ? null : targetDate,
        note: note.trim() === "" ? null : note.trim(),
        status,
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
          <DialogTitle>{editing ? "Edit goal" : "Add goal"}</DialogTitle>
          <DialogDescription>
            A goal reports an ETA and a required contribution. It never changes your allocation — you decide what to do
            with what it tells you.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FieldRow label="Name" htmlFor="goal-name" required>
            <Input id="goal-name" value={name} placeholder="e.g. House deposit" onChange={(e) => setName(e.target.value)} />
          </FieldRow>
          <FieldRow label="Destination account" htmlFor="goal-account" required>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="goal-account" className="w-full">
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                {pickable.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow
            label="Target"
            htmlFor="goal-mode"
            hint={
              mode === "months_of_expenses"
                ? "Resolves against your essential costs every time it's read, so it never goes stale."
                : "A fixed dollar figure."
            }
          >
            <Select value={mode} onValueChange={(v) => setMode(/** @type {(typeof TARGET_MODES)[number]} */ (v))}>
              <SelectTrigger id="goal-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TARGET_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {TARGET_MODE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          {mode === "amount" ? (
            <FieldRow label="Target amount" htmlFor="goal-amount" required>
              <InputGroup>
                <InputGroupAddon>
                  <InputGroupText>$</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id="goal-amount"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </InputGroup>
            </FieldRow>
          ) : (
            <FieldRow label="Months of expenses" htmlFor="goal-months" required>
              <Input
                id="goal-months"
                type="number"
                step="0.5"
                min="0"
                inputMode="decimal"
                value={months}
                onChange={(e) => setMonths(e.target.value)}
              />
            </FieldRow>
          )}
          <FieldRow
            label="Target date"
            htmlFor="goal-date"
            hint="Optional. Without one you still get an ETA — a date is what makes a required contribution meaningful."
          >
            <Input id="goal-date" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          </FieldRow>
          {editing ? (
            <FieldRow label="Status" htmlFor="goal-status">
              <Select
                value={status}
                onValueChange={(v) => setStatus(/** @type {"active" | "achieved" | "abandoned"} */ (v))}
              >
                <SelectTrigger id="goal-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="achieved">Achieved</SelectItem>
                  <SelectItem value="abandoned">Abandoned</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>
          ) : null}
          <FieldRow label="Note" htmlFor="goal-note" hint="Optional.">
            <Textarea id="goal-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </FieldRow>
          {error ? <p className="text-sm text-negative">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : editing ? "Save goal" : "Add goal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Two questions per savings destination: when do we get there at the current
 * contribution, and what would it take to hit a date. Both are reports —
 * nothing on this screen writes to an allocation, and there is no button that
 * would (phases/09-goals-projections.md "Advisory only").
 */
export function GoalsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const today = useMemo(todayIso, []);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(/** @type {Goal | null} */ (null));
  const [balanceFor, setBalanceFor] = useState(/** @type {{ accountId: string | null } | null} */ (null));

  const goalsQuery = useQuery({
    queryKey: ["goals", today],
    queryFn: async () => {
      const res = await api.goals.$get({ query: {} });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {{ goals: Goal[], summary: GoalsSummary, warnings: { code: string, message: string }[] }} */ (
        await res.json()
      );
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

  const accounts = accountsQuery.data ?? [];
  const goals = goalsQuery.data?.goals ?? [];
  const summary = goalsQuery.data?.summary ?? null;
  const warnings = goalsQuery.data?.warnings ?? [];

  function invalidateGoals() {
    queryClient.invalidateQueries({ queryKey: ["goals"] });
  }

  const saveGoal = useMutation({
    mutationFn: async (/** @type {Parameters<Parameters<typeof GoalFormDialog>[0]["onSubmit"]>[0]} */ data) => {
      const res = editing
        ? await api.goals[":id"].$patch({ param: { id: editing.goal.id }, json: data })
        : await api.goals.$post({ json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateGoals();
      toast.success(editing ? "Goal saved." : "Goal added.");
    },
  });

  const deleteGoal = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api.goals[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateGoals();
      toast.success("Goal deleted.");
    },
    onError: (err) => toast.error(err.message),
  });

  const updateBalance = useMutation({
    mutationFn: async (
      /** @type {{ accountId: string, asAt: string, amountCents: number }} */ { accountId, ...data }
    ) => {
      const res = await api.accounts[":id"].balances.$post({ param: { id: accountId }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["account-balances"] });
      queryClient.invalidateQueries({ queryKey: ["net-worth"] });
      queryClient.invalidateQueries({ queryKey: ["projections"] });
      invalidateGoals();
      toast.success("Balance updated.");
    },
  });

  useEffect(
    () =>
      registerCommands([
        {
          id: "goals:add",
          group: "Actions",
          label: "Add goal",
          icon: TargetIcon,
          run: () => {
            setEditing(null);
            setFormOpen(true);
          },
        },
        {
          id: "goals:open-projections",
          group: "Actions",
          label: "Open projections",
          icon: TrendingUpIcon,
          run: () => navigate({ to: "/projections" }),
        },
        {
          id: "goals:update-balance",
          group: "Actions",
          label: "Update balance",
          icon: BanknoteIcon,
          run: () => setBalanceFor({ accountId: null }),
        },
      ]),
    [navigate],
  );

  const shortfall = summary?.shortfallPerPayCents ?? 0;
  const cadenceLabel = summary ? CADENCE_LABELS[summary.payCadence] : null;
  const isLoading = goalsQuery.isLoading || accountsQuery.isLoading;

  return (
    <>
      <PageHeader
        title="Goals"
        description="When do we get there, and what would it take to hit a date? Both are reports — nothing here changes your allocation."
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <PlusIcon />
            Add goal
          </Button>
        }
      />

      {summary ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="Active goals" value={summary.activeCount} />
          <StatTile
            label={`Required${cadenceLabel ? ` (${cadenceLabel})` : ""}`}
            value={
              summary.goalsWithDeadline > 0 ? (
                <Money value={summary.totalRequiredPerPayCents} />
              ) : (
                <span className="text-text-subtle">—</span>
              )
            }
            sparkline={
              <p className="text-xs text-text-muted">
                {summary.goalsWithDeadline > 0
                  ? `across ${summary.goalsWithDeadline} goal${summary.goalsWithDeadline === 1 ? "" : "s"} with a date`
                  : "No goal has a target date yet."}
              </p>
            }
          />
          <StatTile
            label={`Allocated${cadenceLabel ? ` (${cadenceLabel})` : ""}`}
            value={<Money value={summary.totalAllocatedToGoalsPerPayCents} />}
            sparkline={
              <p className="text-xs text-text-muted">
                {summary.allocationPlan ? `from the ${summary.allocationPlan.name} plan` : "No active allocation"}
              </p>
            }
          />
          <StatTile
            className={shortfall > 0 && summary.goalsWithDeadline > 0 ? "bg-negative-soft" : undefined}
            label="Shortfall"
            value={
              summary.goalsWithDeadline === 0 ? (
                <span className="text-text-subtle">—</span>
              ) : shortfall > 0 ? (
                <span className="text-negative">
                  <Money value={shortfall} />
                </span>
              ) : (
                <span className="text-positive">
                  <Money value={0} />
                </span>
              )
            }
            sparkline={
              <p className="text-xs text-text-muted">
                {summary.goalsWithDeadline === 0
                  ? "Set a target date to see one."
                  : shortfall > 0
                    ? "Goals with a date need more than is allocated. Nothing is reprioritised for you."
                    : "Everything with a date is covered."}
              </p>
            }
          />
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-(--radius-card) bg-warning-soft p-4">
          {warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-2 text-sm text-text">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {w.message}
            </p>
          ))}
        </div>
      ) : null}

      {isLoading ? null : goals.length === 0 ? (
        <EmptyState
          icon={TargetIcon}
          title="No goals yet"
          description="Pick a savings account and say what it's for — a dollar target, or how many months of expenses you want covered. You'll get an ETA at your current contribution and what it would take to hit a date."
          action={
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <PlusIcon />
              Add goal
            </Button>
          }
        />
      ) : summary ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {goals.map((goal) => (
            <GoalCard
              key={goal.goal.id}
              goal={goal}
              summary={summary}
              onEdit={() => {
                setEditing(goal);
                setFormOpen(true);
              }}
              onDelete={() => deleteGoal.mutate(goal.goal.id)}
              onUpdateBalance={() => setBalanceFor({ accountId: goal.goal.accountId })}
            />
          ))}
        </div>
      ) : null}

      {summary && goals.length > 0 ? (
        <p className="text-xs text-text-subtle">
          Contributions come from the active allocation
          {summary.allocationPlan ? ` (${summary.allocationPlan.name})` : ""}, matched by destination account. Goals
          never write back to it.{" "}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help underline decoration-dotted">Why isn&apos;t there an apply button?</span>
            </TooltipTrigger>
            <TooltipContent>
              Because a goal reporting a number and a goal changing your transfers are different things. You decide.
            </TooltipContent>
          </Tooltip>
        </p>
      ) : null}

      <GoalFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        accounts={accounts}
        editing={editing}
        submitting={saveGoal.isPending}
        onSubmit={async (data) => {
          await saveGoal.mutateAsync(data);
        }}
      />

      <QuickBalanceSheet
        open={balanceFor !== null}
        onOpenChange={(open) => !open && setBalanceFor(null)}
        accounts={accounts}
        accountId={balanceFor?.accountId ?? null}
        submitting={updateBalance.isPending}
        onSubmit={async (accountId, data) => {
          await updateBalance.mutateAsync({ accountId, ...data });
        }}
      />
    </>
  );
}
