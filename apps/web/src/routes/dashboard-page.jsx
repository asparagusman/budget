import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { addDaysIso, daysBetween } from "@budget/engine";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  BanknoteIcon,
  CalendarDaysIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Skeleton } from "@/components/ui/skeleton.jsx";
import { AllocationFlow } from "@/components/allocation-flow.jsx";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  AXIS,
  Chart,
  ChartTooltip,
  MoneyTooltip,
  TIME_AXIS,
  TOTAL,
  isoToMs,
  useChartMotion,
  useMoneyTick,
  useTimeAxis,
} from "@/components/chart.jsx";
import { Delta } from "@/components/delta.jsx";
import { FidelityBadge } from "@/components/fidelity-badge.jsx";
import { GoodLifeFidelity } from "@/components/good-life-fidelity.jsx";
import { Money } from "@/components/money.jsx";
import { Notice } from "@/components/notice.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { QuickBalanceSheet } from "@/components/quick-balance-sheet.jsx";
import { UnallocatedIndicator, isBalanced } from "@/components/unallocated-indicator.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { CADENCE_LABELS, CADENCE_PERIOD_NOUNS } from "@/lib/constants.js";
import { formatIsoDate, formatIsoDateRange, relativeDayLabel, todayIso } from "@/lib/dates.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";
import { cn } from "@/lib/utils.js";

/** @import { Cadence, Cents, Transfer } from "@budget/engine" */

/** @typedef {{ id: string, name: string, type: "transaction" | "savings" | "investment" | "external", isIncomeLanding: boolean, latestBalance: { amountCents: Cents, asAt: string } | null }} DashAccount */
/** @typedef {{ stage: number, goalPerMonthCents: Cents | null, goalPerPayCents: Cents | null, subtotalPerMonthCents: Cents, subtotalPerPayCents: Cents, subtotalPerWeekCents: Cents, remainingPerMonthCents: Cents, remainingPerPayCents: Cents, remainingPerWeekCents: Cents, goalPct: number | null, goalSource: "stage" | "lines" | null, actualPct: number | null, fidelity: number | null }} DashStage */
/** @typedef {{ lineId: string, perMonthCents: Cents, perPayCents: Cents, perWeekCents: Cents, actualPct: number | null, goalPerMonthCents: Cents | null, goalPerPayCents: Cents | null, fidelity: number | null }} DashResolvedLine */
/** @typedef {{ key: string, label: string, perMonthCents: Cents, perPayCents: Cents | null, pctOfGross: number | null, goalPct: number | null, goalSource: "stage" | "lines" | null, fidelity: number | null, lineCount: number }} DashBreakdown */
/**
 * @typedef {{
 *   on: string,
 *   cycle: { cycleStart: string, cycleEnd: string, payCadence: Cadence, daysRemaining: number, previousOn: string, nextOn: string } | null,
 *   variant: { id: string | null, name: string | null, totalPerPayCents: Cents | null, totalPerMonthCents: Cents | null, diagnostics: ({ kind: "overlap", variantIds: string[], from: string, to: string } | { kind: "gap", from: string, to: string })[] },
 *   bills: {
 *     contributionPerPayCents: Cents | null, contributionPerMonthCents: Cents,
 *     dueNext14DaysCents: Cents, dueSoonDays: number,
 *     nextDue: { billId: string, billName: string, dueDate: string, amountCents: Cents } | null,
 *     upcoming: { billId: string, billName: string, dueDate: string, amountCents: Cents }[],
 *     billCount: number,
 *   },
 *   variable: {
 *     essentialPerMonthCents: Cents, essentialPerPayCents: Cents | null,
 *     nonEssentialPerMonthCents: Cents,
 *     trailingAveragePerMonthCents: Cents | null, trailingAveragePerPayCents: Cents | null,
 *     varianceCents: Cents | null, categoriesWithHistory: number, cyclesRecorded: number,
 *   },
 *   allocation: {
 *     versionId: string, version: number, planId: string, planName: string, incomeVariantId: string,
 *     grossPerMonthCents: Cents, grossPerPayCents: Cents | null,
 *     transfers: Transfer[], stages: DashStage[],
 *     lines: { id: string, stage: number, label: string, accountId: string }[],
 *     resolvedLines: DashResolvedLine[], breakdown: DashBreakdown[],
 *     unallocatedPerMonthCents: Cents, goodLifeFidelityCents: Cents, hasDraft: boolean,
 *   } | null,
 *   accounts: DashAccount[],
 *   netWorth: { totalCents: Cents, series: { date: string, totalCents: Cents }[], stalestAsAt: string | null, staleDays: number | null, staleAfterDays: number, accountsWithoutBalance: number },
 *   mojo: {
 *     goalId: string, name: string, accountName: string, balanceCents: Cents,
 *     monthsCovered: number | null, burnPerMonthCents: Cents,
 *     nextThresholdMonths: number | null, periodsToNextThreshold: number | null,
 *     approxMonthsToNextThreshold: number | null, nextThresholdEta: string | null, payCadence: Cadence,
 *   } | null,
 *   goals: { id: string, name: string, accountName: string, progressPct: number, etaDate: string | null, aheadBehindDays: number | null, isFunded: boolean, reached: boolean, currentBalanceCents: Cents, targetCents: Cents }[],
 *   setup: { people: boolean, paySchedule: boolean, accounts: boolean, bills: boolean, allocation: boolean, complete: boolean },
 *   warnings: { code: string, message: string, href: string }[],
 * }} DashboardData
 */

// A wall of warnings gets ignored, which defeats the purpose
// (phases/10-dashboard.md "Warnings strip").
const MAX_VISIBLE_WARNINGS = 3;

// A group's NAME comes from the API, because on a plan with categories it is
// the household's own word and no map here could know it. Only these hints
// stay: they belong to the three groups the server falls back to when no line
// carries a category, keyed by `ALLOCATION_SECTIONS[].key`. Shown only where a
// group carries no goal — where it does, the fidelity badge is the more useful
// sentence.
/** @type {Record<string, string>} */
const BREAKDOWN_HINTS = {
  needs: "Fixed bills and variable essentials",
  saving: "Saving, investing, giving, buffer",
  leftover: "What's left for day to day",
};

// Two columns on desktop: a 4/6 main column and a 2/6 rail, over three rows
// whose middle one is `1fr`. A card spanning into the flexible row is left out
// of the auto rows' sizing, so the hero's row is exactly as tall as the hero
// and the slack lands in the cards that span — never as a gap under a card.
const CYCLE_GRID = "grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-6 lg:grid-rows-[auto_1fr_auto]";

/**
 * Every card on this screen: one surface, one radius, one shadow, and a quiet
 * "View →" into the screen that owns the figures (phases/10-dashboard.md
 * "Layout").
 *
 * @param {{
 *   title: import("react").ReactNode,
 *   to?: string,
 *   toLabel?: string,
 *   aside?: import("react").ReactNode,
 *   className?: string,
 *   children: import("react").ReactNode,
 * }} props
 */
function Card({ title, to, toLabel = "View", aside, className, children }) {
  return (
    <section
      className={cn(
        // `flex-1` fills the grid cell the card sits in, so two cards sharing
        // a row end on the same line instead of leaving a ragged hole.
        "flex flex-1 flex-col gap-4 rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5",
        className,
      )}
    >
      {/* Wraps rather than truncates: at 320px the aside ("8 orders", the
          14-day total) is the wide half, and squeezing the card's own name
          down to "Standing trans…" loses more than dropping to two lines
          does. */}
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="min-w-0 truncate text-sm font-semibold text-text">{title}</h2>
        <div className="flex shrink-0 items-center gap-2">
          {aside}
          {to ? (
            <Link
              to={to}
              data-touch-target
              className="inline-flex items-center justify-end rounded-(--radius-control) text-xs font-medium text-text-muted transition-colors hover:text-accent-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
            >
              {toLabel} <span aria-hidden="true">→</span>
            </Link>
          ) : null}
        </div>
      </header>
      {children}
    </section>
  );
}

/**
 * Which cycle is on screen, what is running, how to step between them, and the
 * three facts that answer "are we okay this cycle?": what falls due soon, what
 * is next, and whether the plan balances. The dates come from the engine's
 * `resolveCycle` via the API and every figure is the API's — this only formats
 * them (phases/10-dashboard.md "Cycle banner").
 *
 * @param {{
 *   data: DashboardData,
 *   result: import("@budget/engine").AllocationResult | null,
 *   onMove: (on: string) => void,
 *   isToday: boolean,
 *   onToday: () => void,
 * }} props
 */
function CycleBanner({ data, result, onMove, isToday, onToday }) {
  const { locale } = useSettings();
  const { cycle, variant, bills } = data;
  const hasDiagnostic = variant.diagnostics.length > 0;

  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-(--radius-card) p-4 shadow-(--shadow-card) md:p-5",
        hasDiagnostic ? "bg-warning-soft" : "bg-surface",
      )}
    >
      {/* The stepper stays beside the dates at every width. Stacked under
          them on a phone it took a 44px row of its own, left-aligned under
          a heading it has nothing to do with visually. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold text-text">
            {cycle ? (
              <span>{formatIsoDateRange(cycle.cycleStart, addDaysIso(cycle.cycleEnd, -1), locale)}</span>
            ) : (
              <span className="text-text-muted">No pay cycle yet</span>
            )}
            {variant.name ? (
              <Badge variant="secondary">{variant.name}</Badge>
            ) : (
              <Badge variant="outline">no variant in effect</Badge>
            )}
            {data.allocation?.hasDraft ? (
              <Link to="/allocation" data-touch-target className="inline-flex items-center">
                <Badge variant="attention">
                  unapplied draft
                </Badge>
              </Link>
            ) : null}
          </p>
          <p className="mt-0.5 text-xs text-text-muted">
            {cycle ? (
              <>
                {cycle.daysRemaining === 0
                  ? "Last day of this cycle"
                  : `${cycle.daysRemaining} day${cycle.daysRemaining === 1 ? "" : "s"} to go`}
                {" · "}
                {CADENCE_LABELS[cycle.payCadence].toLowerCase()} pay
              </>
            ) : (
              <>Set a primary pay schedule and the whole screen lines up to your paydays.</>
            )}
          </p>
        </div>

        <div className="-mt-1 -mr-2 flex shrink-0 items-center">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous cycle"
            disabled={!cycle}
            onClick={() => cycle && onMove(cycle.previousOn)}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            size="sm"
            variant={isToday ? "ghost" : "secondary"}
            onClick={onToday}
            disabled={isToday}
            className="max-sm:px-2"
          >
            Today
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next cycle"
            disabled={!cycle}
            onClick={() => cycle && onMove(cycle.nextOn)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>

      {cycle ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-4 sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-xs text-text-muted">Bills due, next {bills.dueSoonDays} days</dt>
            <dd className="mt-0.5 text-lg font-semibold text-text tabular-nums">
              <Money value={bills.dueNext14DaysCents} />
            </dd>
          </div>
          {result ? (
            <div className="min-w-0">
              <dt className="text-xs text-text-muted">Unallocated</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums">
                {isBalanced(result) ? (
                  <span className="inline-flex items-center gap-1.5 text-text">
                    <CheckCircle2Icon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
                    Balanced
                  </span>
                ) : (
                  <Link to="/allocation" className="inline-flex items-center gap-1.5 text-warning-strong">
                    <AlertTriangleIcon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="underline underline-offset-2">
                      <Money value={result.unallocatedPerMonthCents} signed />
                      <span className="ml-1 text-xs font-medium text-text-muted">/month</span>
                    </span>
                  </Link>
                )}
              </dd>
            </div>
          ) : null}
          <div className="col-span-2 min-w-0 sm:col-span-1">
            <dt className="text-xs text-text-muted">Next bill</dt>
            <dd className="mt-0.5 flex min-w-0 items-baseline gap-2 text-sm font-medium text-text">
              {bills.nextDue ? (
                <>
                  <span className="truncate">{bills.nextDue.billName}</span>
                  <span className="shrink-0 text-xs font-normal text-text-muted">
                    {relativeDayLabel(daysBetween(data.on, bills.nextDue.dueDate))}
                  </span>
                </>
              ) : (
                <span className="text-text-muted">Nothing coming up</span>
              )}
            </dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

/**
 * One sentence each, and a link to where it is fixed. Three at a time, the
 * rest behind a toggle (phases/10-dashboard.md "Warnings strip").
 *
 * @param {{ warnings: DashboardData["warnings"] }} props
 */
function WarningsStrip({ warnings }) {
  const [expanded, setExpanded] = useState(false);
  if (warnings.length === 0) return null;

  const visible = expanded ? warnings : warnings.slice(0, MAX_VISIBLE_WARNINGS);
  const hidden = warnings.length - visible.length;

  return (
    <div className="flex flex-col gap-2 rounded-(--radius-card) bg-warning-soft p-4">
      {visible.map((warning) => (
        <p key={warning.code + warning.message} className="flex items-start gap-2 text-sm text-text">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning-strong" aria-hidden="true" />
          <span className="min-w-0">
            {warning.message}{" "}
            <Link to={warning.href} className="font-medium whitespace-nowrap underline underline-offset-2">
              Fix it <span aria-hidden="true">→</span>
            </Link>
          </span>
        </p>
      ))}
      {hidden > 0 || expanded ? (
        <button
          type="button"
          data-touch-target
          onClick={() => setExpanded(!expanded)}
          className="flex items-center self-start rounded-(--radius-control) text-xs font-medium text-text-muted underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          {expanded ? "Show fewer" : `and ${hidden} more`}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The visual anchor: income for the cycle, then where it goes. Every figure
 * and every percentage is the engine's, grouped by the API — nothing here
 * divides anything (phases/10-dashboard.md "Hero").
 *
 * @param {{ data: DashboardData }} props
 */
function HeroCard({ data }) {
  const { allocation, cycle, variant } = data;
  const perPeriod = cycle ? CADENCE_PERIOD_NOUNS[cycle.payCadence][0] : "month";
  const incomePerPayCents = allocation?.grossPerPayCents ?? variant.totalPerPayCents;
  const incomePerMonthCents = allocation?.grossPerMonthCents ?? variant.totalPerMonthCents;
  const planVariantMismatch =
    allocation !== null && variant.id !== null && allocation.incomeVariantId !== variant.id;

  return (
    <Card title="Income this cycle" to="/income">
      {incomePerPayCents === null && incomePerMonthCents === null ? (
        // Day one, or a date the schedule doesn't cover. A giant em-dash where
        // the headline figure goes reads as a rendering fault rather than as
        // "nothing to show", so say it in words instead.
        <p className="text-sm text-text-muted">
          No income variant is in effect on this date, so there is nothing to divide yet.{" "}
          <Link to="/income" className="font-medium underline underline-offset-2">
            Set up income
          </Link>
          .
        </p>
      ) : (
        <div>
          <p className="text-3xl font-bold tracking-tight text-text tabular-nums sm:text-4xl">
            {/* Tweened: stepping between pay cycles is the dashboard's
                one recalculation, and watching the headline travel is how
                the operator sees that the cycle actually moved. */}
            <Money value={incomePerPayCents ?? /** @type {Cents} */ (incomePerMonthCents)} tween />
            <span className="ml-2 text-base font-medium text-text-muted">
              per {incomePerPayCents !== null ? perPeriod : "month"}
            </span>
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {allocation ? (
              <>
                Divided by the{" "}
                <Link to="/allocation" className="font-medium underline underline-offset-2">
                  {allocation.planName}
                </Link>{" "}
                plan, v{allocation.version}
                {incomePerMonthCents !== null ? (
                  <>
                    {" · "}
                    <Money value={incomePerMonthCents} />
                    /month
                  </>
                ) : null}
              </>
            ) : (
              <>No allocation plan is active, so nothing is divided yet.</>
            )}
          </p>
        </div>
      )}

      {planVariantMismatch ? (
        <p className="rounded-(--radius-control) bg-warning-soft px-3 py-2 text-xs text-text">
          The schedule resolves to <strong>{variant.name}</strong> on this date, but the active plan divides a
          different variant. The figures below are the plan&apos;s own.
        </p>
      ) : null}

      {allocation ? (
        // Plain columns, not tiles: a card inside a card is two surfaces
        // competing for one idea.
        //
        // Below `sm` each group is a single line — name left, figure right —
        // over its bar. Stacked label-figure-bar-caption, three groups cost a
        // phone 330px for what is one glance.
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-2 sm:gap-y-5 sm:pt-5 lg:grid-cols-3">
          {allocation.breakdown.map((group) => {
            const hint = BREAKDOWN_HINTS[group.key] ?? null;
            return (
              <div
                key={group.key}
                className="grid grid-cols-[minmax(0,1fr)_auto] content-start items-baseline gap-x-3 sm:grid-cols-1"
              >
                <dt className="min-w-0 text-sm font-medium text-text-muted">{group.label}</dt>
                <dd className="text-lg font-semibold tracking-tight text-text tabular-nums sm:mt-1 sm:text-2xl">
                  <Money value={group.perPayCents ?? group.perMonthCents} tween />
                </dd>
                <dd className="col-span-2 sm:col-span-1">
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-border sm:mt-2">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(0, Math.min(100, group.pctOfGross ?? 0))}%`,
                        backgroundColor: "var(--chart-total)",
                      }}
                    />
                  </div>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-text-muted">
                    <span>{group.pctOfGross !== null ? `${group.pctOfGross.toFixed(1)}% of income` : "—"}</span>
                    {/* The goal, where the household set one, said the way
                        it asked for it: what you're doing, against what you
                        meant to. Where there is no goal the group keeps the
                        hint it always had. */}
                    {group.fidelity !== null ? (
                      <FidelityBadge fidelity={group.fidelity} goalPct={group.goalPct} />
                    ) : hint !== null ? (
                      <span>· {hint}</span>
                    ) : (
                      <span>
                        · {group.lineCount} {group.lineCount === 1 ? "line" : "lines"}
                      </span>
                    )}
                  </p>
                </dd>
              </div>
            );
          })}
        </dl>
      ) : incomePerPayCents !== null || incomePerMonthCents !== null ? (
        <p className="text-sm text-text-muted">
          Build an allocation to see how this income splits across bills, spending and everything else.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * The standing bank orders, exact to the cent. Not a todo list: these are
 * orders already set up at the bank, and the app's only job is to say what the
 * amounts should be (phases/README.md "The one rule").
 *
 * @param {{ data: DashboardData, accounts: DashAccount[] }} props
 */
function TransfersCard({ data, accounts }) {
  const { allocation, cycle } = data;
  const nameOf = (/** @type {string} */ id) => accounts.find((a) => a.id === id)?.name ?? "Unknown account";
  const cadenceLabel = cycle ? CADENCE_LABELS[cycle.payCadence].toLowerCase() : "month";

  /** @param {Cents} cents */
  async function copyAmount(cents) {
    try {
      await navigator.clipboard.writeText((cents / 100).toFixed(2));
      toast.success("Amount copied.");
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  }

  if (!allocation) {
    return (
      <Card title="Standing transfers" to="/allocation">
        <p className="text-sm text-text-muted">
          No plan is active yet, so there are no transfer amounts to set up.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Standing transfers"
     
      to="/allocation"
    >
      <ul className="flex flex-col divide-y divide-border">
        {allocation.transfers.map((transfer) => (
          <li key={transfer.accountId}>
            <button
              type="button"
              onClick={() => copyAmount(transfer.perPayCents)}
              aria-label={`Copy the ${nameOf(transfer.accountId)} amount, ${(transfer.perPayCents / 100).toFixed(2)}`}
              title={`Copy ${(transfer.perPayCents / 100).toFixed(2)}`}
              className="-mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-(--radius-control) px-2 py-1.5 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)"
            >
              <span className="min-w-0">
                <span
                  className={cn("block truncate text-sm font-medium", transfer.isNoOp ? "text-text-muted" : "text-text")}
                >
                  {nameOf(transfer.accountId)}
                </span>
                {transfer.isNoOp ? <span className="block text-xs text-text-subtle">no move required</span> : null}
              </span>
              <span
                className={cn(
                  "shrink-0 text-right text-sm font-semibold tabular-nums",
                  transfer.isNoOp ? "text-text-muted" : "text-text",
                )}
              >
                <Money value={transfer.perPayCents} tween />
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-auto text-xs text-text-subtle">
        Per {cadenceLabel}. Tap a row to copy its amount.
      </p>
    </Card>
  );
}

/**
 * What lands in the next fortnight, and the five bills after that. Relative
 * days are measured from the date on screen, not from the wall clock, so a
 * shared `?on=` link says the same thing to whoever opens it.
 *
 * @param {{ data: DashboardData }} props
 */
function UpcomingCard({ data }) {
  const { locale } = useSettings();
  const { bills } = data;

  return (
    <Card
      title="Upcoming bills"
     
      to="/costs/fixed"
    >
      {bills.upcoming.length === 0 ? (
        <p className="text-sm text-text-muted">
          {bills.billCount === 0
            ? "No bills recorded yet — add them and they show up here as they fall due."
            : "Nothing falls due in the next three months."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {bills.upcoming.map((instance) => (
            <li key={`${instance.billId}:${instance.dueDate}`} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text">{instance.billName}</p>
                <p className="text-xs text-text-muted">
                  {relativeDayLabel(daysBetween(data.on, instance.dueDate))}
                  <span className="text-text-subtle"> · {formatIsoDate(instance.dueDate, locale)}</span>
                </p>
              </div>
              <span className="shrink-0 text-sm font-semibold text-text tabular-nums">
                <Money value={instance.amountCents} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* Per month, deliberately, while everything else on this card and the
          one above it is per pay. The bills row in Standing transfers is this
          same contribution — a `from_fixed_costs` line IS
          `fixedTotalPerMonthCents` — but the plan converts it to per-pay with
          nominal cadence arithmetic (× 12/26) while this figure divides the
          window total by the paydays actually in the window. Over 1461 days
          that is 104.35 nominal fortnights against 105 real paydays, so the
          two per-pay figures land about $13 apart for a reason no reader can
          see from the screen. The monthly figures agree to the cent, so per
          month is the one cadence in which this card can match both
          /costs/fixed, which owns the number, and /allocation, which spends
          it (`[P10-12]`).
      */}
      {bills.billCount > 0 ? (
        <p className="text-xs text-text-subtle">
          Fixed Costs sets aside <Money value={bills.contributionPerMonthCents} className="font-medium text-text" /> a
          month across every bill.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Household total over twelve months, plus the one write this screen allows.
 * The chart never interpolates between snapshots: each step is a balance that
 * was actually recorded (phases/09-goals-projections.md "API").
 *
 * @param {{ data: DashboardData, onUpdateBalance: () => void }} props
 */
function NetWorthCard({ data, onUpdateBalance }) {
  const { currency, locale } = useSettings();
  const moneyTick = useMoneyTick();
  const motion = useChartMotion();
  const { netWorth } = data;
  const isStale = netWorth.staleDays !== null && netWorth.staleDays > netWorth.staleAfterDays;

  // A real time axis: `t` is the point's own date in milliseconds, so the
  // gap between two balances recorded a day apart is a day wide and one
  // recorded a year apart is a year wide.
  const rows = useMemo(
    () =>
      netWorth.series.map((point) => ({
        t: isoToMs(point.date),
        label: formatIsoDate(point.date, locale),
        netWorth: point.totalCents / 100,
      })),
    [netWorth.series, locale],
  );
  const timeAxis = useTimeAxis(rows[0]?.t ?? 0, rows[rows.length - 1]?.t ?? 0);

  return (
    <Card
      title="Net worth"
     
      to="/accounts"
      aside={
        <Button size="sm" variant="ghost" onClick={onUpdateBalance}>
          <BanknoteIcon />
          Update balance
        </Button>
      }
    >
      <div>
        <p className="text-3xl font-bold tracking-tight text-text tabular-nums">
          <Money value={netWorth.totalCents} />
        </p>
        <p className={cn("mt-0.5 text-xs", isStale ? "text-warning-strong" : "text-text-muted")}>
          {netWorth.stalestAsAt ? (
            <>
              {isStale ? (
                <AlertTriangleIcon className="mr-1 inline size-3.5 align-text-bottom" aria-hidden="true" />
              ) : null}
              Oldest balance {formatIsoDate(netWorth.stalestAsAt, locale)}
              {netWorth.staleDays !== null ? ` · ${netWorth.staleDays} days old` : ""}
              {isStale ? " — worth a refresh" : ""}
            </>
          ) : (
            <>No balances recorded yet.</>
          )}
          {netWorth.accountsWithoutBalance > 0 ? (
            <>
              {" · "}
              {netWorth.accountsWithoutBalance} account{netWorth.accountsWithoutBalance === 1 ? "" : "s"} counted as
              zero
            </>
          ) : null}
        </p>
      </div>
      {/* A canvas is opaque to a screen reader, so the label carries the
          shape of the line and the table carries every figure on it. A
          chart is never the only way a number is available
          (phases/11-polish-mobile-import.md, workstream B). */}
      <Chart
        height={200}
        ariaLabel={`Net worth over time, ${netWorth.series.length} recorded points, currently ${formatMoney(netWorth.totalCents, { currency, locale })}.`}
        dataTable={{
          caption: "Net worth at each recorded date",
          columns: ["Date", "Net worth"],
          rows: netWorth.series.map((point) => [
            formatIsoDate(point.date, locale),
            formatMoney(point.totalCents, { currency, locale }),
          ]),
        }}
        empty={netWorth.series.length < 2}
        emptyTitle="Not enough history yet"
        emptyDescription="Record a balance on two different dates and the line starts to draw itself."
        config={{ netWorth: { label: "Net worth", color: TOTAL } }}
      >
        <AreaChart data={rows} margin={{ top: 16, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" {...AXIS} {...TIME_AXIS} {...timeAxis} minTickGap={32} />
          <YAxis {...AXIS} width={56} tickFormatter={moneyTick} />
          <ChartTooltip content={<MoneyTooltip />} />
          {/* `stepAfter`, not a smooth curve: a balance holds the figure it
              was last recorded at until the next reading, and interpolating
              between two readings draws a number nobody recorded. */}
          <Area
            dataKey="netWorth"
            type="stepAfter"
            stroke="var(--color-netWorth)"
            fill="var(--color-netWorth)"
            fillOpacity={0.15}
            strokeWidth={2}
            dot={false}
            {...motion}
          />
        </AreaChart>
      </Chart>
    </Card>
  );
}

/**
 * How long the household could last, and when the next month of cover lands.
 * Durations are periods of the pay cadence and approximate months — never
 * weeks (phases/09-goals-projections.md "/goals").
 *
 * @param {{ mojo: NonNullable<DashboardData["mojo"]> }} props
 */
function MojoCard({ mojo }) {
  const { locale } = useSettings();
  const [singular, plural] = CADENCE_PERIOD_NOUNS[mojo.payCadence];
  const periods = mojo.periodsToNextThreshold;

  return (
    <Card title={mojo.name} to="/goals">
      <div>
        <p className="text-3xl font-bold tracking-tight text-text tabular-nums">
          {mojo.monthsCovered !== null ? mojo.monthsCovered.toFixed(1) : "—"}
          <span className="ml-1.5 text-base font-medium text-text-muted">months covered</span>
        </p>
        <p className="mt-0.5 text-xs text-text-muted">
          <Money value={mojo.balanceCents} className="font-medium text-text" /> in {mojo.accountName} · essentials run{" "}
          <Money value={mojo.burnPerMonthCents} />
          /month
        </p>
      </div>
      {mojo.nextThresholdMonths !== null ? (
        <p className="rounded-(--radius-control) bg-surface-muted p-3 text-sm text-text">
          Next marker:{" "}
          <strong>
            {mojo.nextThresholdMonths} month{mojo.nextThresholdMonths === 1 ? "" : "s"}
          </strong>
          {periods !== null ? (
            <>
              {" in about "}
              {periods} {periods === 1 ? singular : plural}
              {mojo.approxMonthsToNextThreshold !== null
                ? ` (${mojo.approxMonthsToNextThreshold} month${mojo.approxMonthsToNextThreshold === 1 ? "" : "s"})`
                : ""}
              {mojo.nextThresholdEta ? `, ${formatIsoDate(mojo.nextThresholdEta, locale)}` : ""}.
            </>
          ) : (
            <>, but nothing is being contributed, so it never arrives.</>
          )}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-text">
          <CheckCircle2Icon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
          Every marker is covered.
        </p>
      )}
    </Card>
  );
}

/**
 * Days for a near miss, months once it runs to years — "20061 days sooner" is
 * a true number that tells the operator nothing. Same rule as /goals'
 * `EtaAndRequired`.
 *
 * @param {DashboardData["goals"][number]} goal
 */
function aheadBehindLabel(goal) {
  const days = goal.aheadBehindDays;
  if (goal.reached || days === null || days <= 0) return null;
  if (days < 60) return `${days} days`;
  return `about ${Math.round(days / 30.44)} months`;
}

/**
 * @param {{ goals: DashboardData["goals"] }} props
 */
function GoalsCard({ goals }) {
  const { locale } = useSettings();

  return (
    <Card title="Goals" to="/goals">
      {goals.length === 0 ? (
        <p className="text-sm text-text-muted">
          No goals yet. Pick a savings account and say what it&apos;s for — you&apos;ll get an ETA at your current
          contribution.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-2">
          {goals.map((goal) => (
            <li key={goal.id} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-text">
                  <span className="truncate">{goal.name}</span>
                  {goal.isFunded ? null : <Badge variant="attention">unfunded</Badge>}
                </span>
                <span
                  className={cn("text-xs font-medium tabular-nums", goal.reached ? "text-text" : "text-text-muted")}
                >
                  {goal.progressPct.toFixed(0)}%
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
                <div
                  className="h-full rounded-full bg-(--chart-total)"
                  style={{ width: `${Math.max(0, Math.min(100, goal.progressPct))}%` }}
                />
              </div>
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-subtle">
                <span>
                  <Money value={goal.currentBalanceCents} /> of <Money value={goal.targetCents} />
                </span>
                {goal.reached ? (
                  <span className="inline-flex items-center gap-1 text-text">
                    <CheckCircle2Icon className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
                    reached
                  </span>
                ) : goal.etaDate ? (
                  <span>ETA {formatIsoDate(goal.etaDate, locale)}</span>
                ) : (
                  <span>no ETA at this contribution</span>
                )}
                {/* What the account's own growth is buying, against a
                    no-growth projection of the same contribution. Only shown
                    when it's worth a day — an "0 days sooner" pill on a
                    transaction account is noise. Wording matches /goals so
                    the two screens don't describe the same figure two ways. */}
                {aheadBehindLabel(goal) ? (
                  <span className="text-text-muted">{aheadBehindLabel(goal)} sooner with growth</span>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * The prize pool against the non-essential target, and how variable spending
 * is actually tracking against its budget.
 *
 * @param {{ data: DashboardData }} props
 */
function GoodLifeCard({ data }) {
  const { allocation, variable, cycle } = data;
  const cadenceLabel = cycle ? CADENCE_LABELS[cycle.payCadence].toLowerCase() : "month";

  return (
    <Card title="The good life" to="/costs/variable">
      <p className="text-sm text-text">
        {allocation ? (
          <GoodLifeFidelity
            cents={allocation.goodLifeFidelityCents}
            targetPerMonthCents={variable.nonEssentialPerMonthCents}
          />
        ) : (
          <>
            Your non-essential target is <Money value={variable.nonEssentialPerMonthCents} /> a month. An active
            allocation is what says whether you are hitting it.
          </>
        )}
      </p>
      <dl className="flex flex-col gap-2 text-xs">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="min-w-0 text-text-muted">Essentials, per {cadenceLabel}</dt>
          <dd className="font-medium text-text tabular-nums">
            {variable.essentialPerPayCents !== null ? (
              <Money value={variable.essentialPerPayCents} />
            ) : (
              <Money value={variable.essentialPerMonthCents} />
            )}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="min-w-0 text-text-muted">Actually spending, per month</dt>
          <dd className="flex shrink-0 items-center justify-end gap-2 text-right">
            {variable.trailingAveragePerMonthCents !== null ? (
              <>
                <span className="font-medium text-text tabular-nums">
                  <Money value={variable.trailingAveragePerMonthCents} />
                </span>
                {variable.varianceCents !== null ? (
                  <Delta value={variable.varianceCents} kind="cents" variance />
                ) : null}
              </>
            ) : (
              <span className="text-text-subtle">
                {variable.cyclesRecorded === 0 ? "no cycles recorded yet" : "not enough history"}
              </span>
            )}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

/**
 * Day one. "No data" would be a poor first impression on the screen the
 * operator sees before anything else exists, so this says what to do next and
 * ticks each step off as it lands (phases/10-dashboard.md "Empty state on day
 * one").
 *
 * @param {{ setup: DashboardData["setup"] }} props
 */
function SetupPath({ setup }) {
  const steps = [
    { done: setup.people, to: "/admin/people", label: "Add the people in your household" },
    { done: setup.paySchedule, to: "/income", label: "Set a primary pay schedule" },
    { done: setup.accounts, to: "/accounts", label: "Add your accounts, and mark where income lands" },
    { done: setup.bills, to: "/costs/fixed", label: "Add your bills" },
    { done: setup.allocation, to: "/allocation", label: "Build an allocation and apply it" },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <Card title="Getting set up" aside={<span className="text-xs text-text-subtle">{doneCount} of {steps.length}</span>}>
      <ol className="flex flex-col gap-1">
        {steps.map((step, index) => (
          <li key={step.to}>
            <Link
              to={step.to}
              className="group flex items-center gap-3 rounded-(--radius-control) px-2 py-2 transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)"
            >
              {step.done ? (
                <CheckCircle2Icon className="size-5 shrink-0 text-text-muted" aria-hidden="true" />
              ) : (
                <span
                  className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-muted text-[0.625rem] font-semibold text-text-muted"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
              )}
              <span className={cn("min-w-0 flex-1 text-sm", step.done ? "text-text-subtle line-through" : "text-text")}>
                {step.label}
              </span>
              {step.done ? null : (
                <ArrowRightIcon className="size-4 shrink-0 text-text-subtle transition-colors group-hover:text-accent-brand" aria-hidden="true" />
              )}
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * Card-shaped placeholders in the real grid positions, so nothing moves when
 * the data lands (phases/10-dashboard.md "Skeletons, not spinners").
 */
function DashboardSkeleton() {
  return (
    <>
      <Skeleton className="h-36 rounded-(--radius-card)" />
      <div className={CYCLE_GRID}>
        <Skeleton className="h-64 rounded-(--radius-card) lg:col-span-4" />
        <Skeleton className="h-64 rounded-(--radius-card) lg:col-span-2 lg:row-span-2" />
        <Skeleton className="h-80 rounded-(--radius-card) lg:col-span-4" />
      </div>
    </>
  );
}

/**
 * Where are we right now, without opening anything else. Read-only except for
 * one balance update: every other figure is a link into the screen that owns
 * it, and nothing on this page computes a financial figure of its own
 * (phases/10-dashboard.md).
 *
 * The card order in the DOM is the MOBILE order — most-checked first — and
 * `lg:order-*` rearranges the first grid for desktop (income beside the
 * standing orders, the flow beside what is due), so the phone gets the
 * priority order for free rather than through a second markup tree. The second
 * grid is already in reading order on both.
 */
export function DashboardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // `strict: false` rather than a route id: the route tree is code-based with
  // no `Register` augmentation (phases/README.md "no .d.ts files"), so a route
  // id is not a resolvable type and "/" is not a match id at runtime. The same
  // call shape /income and /allocation use for their own search params.
  const search = useSearch({ strict: false });
  const today = useMemo(todayIso, []);
  const on = search.on ?? today;

  const [balanceFor, setBalanceFor] = useState(/** @type {{ accountId: string | null } | null} */ (null));

  const dashboardQuery = useQuery({
    queryKey: ["dashboard", on],
    queryFn: async () => {
      const res = await api.dashboard.$get({ query: { on } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {DashboardData} */ (await res.json());
    },
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
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["account-balances"] });
      queryClient.invalidateQueries({ queryKey: ["net-worth"] });
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      queryClient.invalidateQueries({ queryKey: ["projections"] });
      toast.success("Balance updated.");
    },
  });

  /** @param {string} next */
  const moveTo = (next) => navigate({ to: "/", search: next === today ? {} : { on: next } });

  const data = dashboardQuery.data ?? null;
  const cycle = data?.cycle ?? null;

  useEffect(
    () =>
      registerCommands([
        {
          id: "dashboard:update-balance",
          group: "Actions",
          label: "Update balance",
          icon: BanknoteIcon,
          run: () => setBalanceFor({ accountId: null }),
        },
        {
          id: "dashboard:previous-cycle",
          group: "Actions",
          label: "Previous pay cycle",
          keywords: "back earlier dashboard",
          icon: ChevronLeftIcon,
          run: () => cycle && moveTo(cycle.previousOn),
        },
        {
          id: "dashboard:next-cycle",
          group: "Actions",
          label: "Next pay cycle",
          keywords: "forward later dashboard",
          icon: ChevronRightIcon,
          run: () => cycle && moveTo(cycle.nextOn),
        },
        {
          id: "dashboard:today",
          group: "Actions",
          label: "Back to today",
          icon: CalendarDaysIcon,
          run: () => moveTo(today),
        },
      ]),
    // `moveTo` is recreated every render; the cycle bounds are what actually
    // change what these commands do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cycle?.previousOn, cycle?.nextOn, today],
  );

  // The engine's `AllocationResult` shape, rebuilt from the payload so the
  // shared /allocation components (the unallocated indicator, the flow
  // diagram) take exactly what they take there.
  const result = useMemo(
    () =>
      data?.allocation
        ? {
            lines: data.allocation.resolvedLines,
            stages: data.allocation.stages,
            transfers: data.allocation.transfers,
            unallocatedPerMonthCents: data.allocation.unallocatedPerMonthCents,
            goodLifeFidelityCents: data.allocation.goodLifeFidelityCents,
          }
        : null,
    [data],
  );

  return (
    <>
      <PageHeader title="Overview" />

      {dashboardQuery.isLoading ? (
        <div className="flex flex-col gap-4 md:gap-6">
          <DashboardSkeleton />
        </div>
      ) : dashboardQuery.isError ? (
        <Notice kind="error" className="p-5">
          {dashboardQuery.error.message}
        </Notice>
      ) : data ? (
        <div className="flex flex-col gap-4 md:gap-6">
          <CycleBanner
            data={data}
            result={result}
            onMove={moveTo}
            isToday={on === today}
            onToday={() => moveTo(today)}
          />

          <WarningsStrip warnings={data.warnings} />

          {data.setup.complete ? null : <SetupPath setup={data.setup} />}

          {/* The full indicator only when there is something to say: a
              balanced plan is already one word in the banner. An unbalanced
              one is the loudest thing on the screen, so it sits above the
              grid where it can't be scrolled past. */}
          {result && cycle && !isBalanced(result) ? (
            <UnallocatedIndicator
              result={result}
              payCadence={cycle.payCadence}
              hasPrimaryPaySchedule
              footer={
                <Link
                  to="/allocation"
                  data-touch-target
                  className="mt-1 inline-flex items-center self-start rounded-(--radius-control) text-xs font-medium text-text-muted underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
                >
                  Open allocation <span aria-hidden="true">→</span>
                </Link>
              }
            />
          ) : null}

          {/* data-stagger fades and lifts each card ~30ms after the last,
              so the dashboard assembles instead of appearing as one slab.
              See app.css; the delays live there rather than here because
              this grid's children are conditional and hand-numbered inline
              delays would go stale.

              DOM order is the phone's order. On desktop the cards are placed
              into two columns — income over the flow, the transfers over
              what's due — with the middle row flexible, so each column's
              cards end level with the other's instead of the short card
              leaving a hole under itself. */}
          <div data-stagger className={CYCLE_GRID}>
            <div className="flex flex-col lg:col-span-4 lg:col-start-1 lg:row-start-1">
              <HeroCard data={data} />
            </div>

            <div className="flex flex-col lg:col-span-2 lg:col-start-5 lg:row-span-2 lg:row-start-1">
              <TransfersCard data={data} accounts={data.accounts} />
            </div>

            <div className="flex flex-col lg:col-span-2 lg:col-start-5 lg:row-start-3">
              <UpcomingCard data={data} />
            </div>

            {result && data.allocation ? (
              <div className="flex flex-col lg:col-span-4 lg:col-start-1 lg:row-span-2 lg:row-start-2">
                <Card title="Where the money goes" to="/allocation">
                  {/* `lines` is gone with the sankey: slices are keyed by
                      destination, which the result's own transfers carry. */}
                  {/* This card's height is set by the rail beside it (transfers
                      over upcoming bills), which runs taller than a 300px pie.
                      A larger canvas fills most of that, and centring takes
                      up the rest as margin rather than a blank strip under
                      the chart. */}
                  <div className="flex flex-1 flex-col justify-center">
                    <AllocationFlow result={result} accounts={data.accounts} heading={null} height={400} />
                  </div>
                </Card>
              </div>
            ) : null}
          </div>

          {/* The slower-moving half: where the household is heading rather
              than what the cycle needs. Net worth leads with the two short
              cards stacked beside it, and goals take the full width under
              them. */}
          <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-6">
            <div
              className={cn(
                "flex flex-col lg:col-span-4 lg:col-start-1 lg:row-start-1",
                data.mojo && "lg:row-span-2",
              )}
            >
              <NetWorthCard data={data} onUpdateBalance={() => setBalanceFor({ accountId: null })} />
            </div>

            {data.mojo ? (
              <div className="flex flex-col lg:col-span-2 lg:col-start-5 lg:row-start-1">
                <MojoCard mojo={data.mojo} />
              </div>
            ) : null}

            <div className={cn("flex flex-col lg:col-span-6", data.mojo ? "lg:row-start-3" : "lg:row-start-2")}>
              <GoalsCard goals={data.goals} />
            </div>

            <div
              className={cn(
                "flex flex-col lg:col-span-2 lg:col-start-5",
                data.mojo ? "lg:row-start-2" : "lg:row-start-1",
              )}
            >
              <GoodLifeCard data={data} />
            </div>
          </div>
        </div>
      ) : null}

      <QuickBalanceSheet
        open={balanceFor !== null}
        onOpenChange={(open) => !open && setBalanceFor(null)}
        accounts={data?.accounts ?? []}
        accountId={balanceFor?.accountId ?? null}
        submitting={updateBalance.isPending}
        onSubmit={async (accountId, values) => {
          await updateBalance.mutateAsync({ accountId, ...values });
        }}
      />
    </>
  );
}
