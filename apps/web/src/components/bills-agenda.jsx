import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { addDaysIso, projectPaydays } from "@budget/engine";
import { CalendarDaysIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { ListSkeleton } from "@/components/loading.jsx";
import { Money } from "@/components/money.jsx";
import { QueryError } from "@/components/query-error.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { formatIsoDate, getDateFormat, todayIso } from "@/lib/dates.js";
import { useSettings } from "@/lib/settings.jsx";
import { cn } from "@/lib/utils.js";
import { accountsQueryOptions, billsQueryOptions, paySchedulesQueryOptions } from "@/lib/queries.js";

/** @import { Cents } from "@budget/engine" */
/** @import { MergedInstance, BillRef } from "@/routes/calendar-page.jsx" */

/**
 * Whether this instance's date is derived from a due date nobody has
 * confirmed — an imported bill's placeholder anchor. The calendar is the
 * screen people read dates off, so it is the one that most needs to say a
 * date is a guess.
 *
 * @param {MergedInstance} instance
 * @param {Map<string, BillRef>} billsById
 */
export function isPlaceholder(instance, billsById) {
  return billsById.get(instance.billId)?.dueDateConfirmed === false;
}

/**
 * An ISO date's parts as a local Date, so formatting never shifts it a day the
 * way `new Date("2026-10-01")` (UTC midnight) does west of Greenwich.
 *
 * @param {string} iso
 */
export function localDate(iso) {
  return new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

const WEEKDAY_SHORT = getDateFormat("en-AU", { weekday: "short" });
export const DAY_LONG = getDateFormat("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/**
 * The days in `window` with a payday or a bill on them, each with the
 * expected balance of the income-landing account once that day is done.
 * Shared by /calendar's Agenda view (one month) and /fixed-costs (the next
 * few weeks), so the two never disagree about a day.
 *
 * The balance runs forward from that account's latest recorded balance — it
 * is the account income lands in and bills come out of. It is the Fixed
 * Costs balance curve over a different window, so the curve and this list
 * predict the same figure for the same day. The snapshot is passed as
 * `opening` on purpose: the curve's saved override is a what-if with no
 * date, and this list needs a balance it can date.
 *
 * @param {{
 *   window: { from: string, to: string },
 *   emptyTitle: string,
 *   emptyDescription: string,
 *   onSelectDay?: (date: string) => void,
 * }} props
 */
export function BillsAgenda({ window, emptyTitle, emptyDescription, onSelectDay }) {
  const { locale } = useSettings();
  const paySchedulesQuery = useQuery(paySchedulesQueryOptions());
  const billsQuery = useQuery(billsQueryOptions());
  const accountsQuery = useQuery(accountsQueryOptions());
  // Under the "bill-instances" key so every save that invalidates the
  // calendar's instances invalidates these too.
  const instancesQuery = useQuery({
    queryKey: ["bill-instances", "agenda", window.from, window.to],
    queryFn: async () => {
      const res = await api["bill-instances"].$get({ query: window });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {MergedInstance[]} */ ((await res.json()).instances);
    },
  });

  const billsById = useMemo(() => new Map((billsQuery.data ?? []).map((b) => [b.id, b])), [billsQuery.data]);
  const instancesByDate = useMemo(() => {
    /** @type {Map<string, MergedInstance[]>} */
    const map = new Map();
    for (const i of instancesQuery.data ?? []) {
      const list = map.get(i.dueDate) ?? [];
      list.push(i);
      map.set(i.dueDate, list);
    }
    return map;
  }, [instancesQuery.data]);

  const primarySchedule = (paySchedulesQuery.data ?? []).find((s) => s.isPrimary) ?? null;
  const paydaySet = useMemo(() => {
    if (!primarySchedule) return new Set();
    try {
      return new Set(projectPaydays({ anchorDate: primarySchedule.anchorDate, cadence: primarySchedule.cadence }, window));
    } catch {
      return new Set();
    }
  }, [primarySchedule, window]);

  const days = useMemo(() => [...new Set([...instancesByDate.keys(), ...paydaySet])].sort(), [instancesByDate, paydaySet]);

  const landingAccount = (accountsQuery.data ?? []).find((a) => a.isIncomeLanding) ?? null;
  const landingBalance = landingAccount?.latestBalance ?? null;
  // Events on the snapshot's own day are taken as already in it.
  const balanceFrom = landingBalance ? addDaysIso(landingBalance.asAt, 1) : null;
  // Under the curve's own key, so every edit that invalidates the curve
  // invalidates this too.
  const balanceQuery = useQuery({
    queryKey: ["fixed-costs-balance-curve", "agenda", balanceFrom, window.to, landingBalance?.amountCents],
    queryFn: async () => {
      const res = await api["fixed-costs"]["balance-curve"].$get({
        query: {
          from: /** @type {string} */ (balanceFrom),
          to: window.to,
          opening: String(landingBalance?.amountCents ?? 0),
        },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {{ points: { date: string, balanceCents: Cents }[], bufferCents: Cents, contributionPerPayCents: Cents }} */ (
        await res.json()
      );
    },
    enabled: primarySchedule !== null && balanceFrom !== null && balanceFrom < window.to,
  });
  // A day's closing balance: its last point, since one day can carry a
  // payday and several bills.
  const balanceByDate = useMemo(() => {
    /** @type {Map<string, Cents>} */
    const map = new Map();
    for (const p of balanceQuery.data?.points ?? []) map.set(p.date, p.balanceCents);
    return map;
  }, [balanceQuery.data]);
  const bufferCents = balanceQuery.data?.bufferCents ?? 0;

  const todayIsoDate = todayIso();
  // A failed load used to fall through to "Nothing this month", which reads
  // as "no bills are due" — the one thing this list must never say wrongly.
  const loadError = instancesQuery.error ?? billsQuery.error ?? paySchedulesQuery.error ?? null;
  const loading = instancesQuery.isLoading || billsQuery.isLoading || paySchedulesQuery.isLoading;

  if (loadError) {
    return (
      <div className="p-2 sm:p-4">
        <QueryError
          error={loadError}
          what="these bills and paydays"
          onRetry={() => Promise.all([instancesQuery.refetch(), billsQuery.refetch(), paySchedulesQuery.refetch()])}
        />
      </div>
    );
  }
  if (loading) return <ListSkeleton rows={5} label="Loading bills and paydays" className="p-4" />;
  if (days.length === 0) {
    return (
      <EmptyState icon={CalendarDaysIcon} title={emptyTitle} description={emptyDescription} className="rounded-none shadow-none" />
    );
  }

  return (
    <>
      <p className="border-b border-border px-4 py-2 text-xs text-text-muted">
        {accountsQuery.isLoading ? (
          " "
        ) : !landingAccount ? (
          <>
            Mark the account income lands in on{" "}
            <Link to="/accounts" className="font-medium underline underline-offset-2">
              Accounts
            </Link>{" "}
            to see the expected balance after each day.
          </>
        ) : !landingBalance ? (
          <>
            <Link to="/accounts" className="font-medium underline underline-offset-2">
              Record a balance
            </Link>{" "}
            for {landingAccount.name} to see the expected balance after each day.
          </>
        ) : balanceQuery.error ? (
          "Couldn't work out the expected balance for these days."
        ) : (
          <>
            Expected balance in {landingAccount.name}, from <Money value={landingBalance.amountCents} /> recorded{" "}
            {formatIsoDate(landingBalance.asAt, locale)}.
            {balanceQuery.data ? (
              <>
                {" "}
                Each payday adds the <Money value={balanceQuery.data.contributionPerPayCents} /> bills transfer;
                everyday spending isn&rsquo;t counted.
              </>
            ) : null}
          </>
        )}
      </p>
      {/* An agenda reads down a date column: weekday over day number on the
          left, what lands that day in the middle, the day's outflow and the
          balance it leaves on the right. It used to lead every row with
          "2026-10-01". */}
      <ol className="flex flex-col divide-y divide-border">
        {days.map((day) => {
          const dayInstances = instancesByDate.get(day) ?? [];
          const total = dayInstances.reduce((s, i) => s + (i.actualCents ?? i.expectedCents), 0);
          const isToday = day === todayIsoDate;
          const hasPlaceholder = dayInstances.some((i) => isPlaceholder(i, billsById));
          const balance = balanceByDate.get(day);
          const content = (
            <>
              <span
                className={cn("flex w-9 shrink-0 flex-col items-center leading-tight", isToday ? "text-accent-brand" : "text-text")}
              >
                <span className="text-[0.6875rem] font-medium tracking-wide text-text-subtle uppercase">
                  {WEEKDAY_SHORT.format(localDate(day))}
                </span>
                <span className="text-lg font-semibold tabular-nums">{Number(day.slice(8, 10))}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm text-text">
                    {dayInstances.map((i) => billsById.get(i.billId)?.name ?? "Bill").join(", ") || (
                      <span className="text-text-muted">No bills</span>
                    )}
                  </span>
                  {paydaySet.has(day) ? (
                    <Badge variant="secondary">
                      <span className="size-1.5 rounded-full bg-positive" aria-hidden="true" />
                      Payday
                    </Badge>
                  ) : null}
                  {hasPlaceholder ? <Badge variant="attention">Placeholder date</Badge> : null}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-0.5 leading-tight">
                {total > 0 ? <Money value={total} className="text-sm font-semibold text-negative tabular-nums" /> : null}
                {balance !== undefined ? (
                  // Under the buffer is amber, under zero is red: the account
                  // dipping is what this column is here to show.
                  <span
                    className={cn(
                      "text-xs tabular-nums",
                      balance < 0 ? "text-negative" : balance < bufferCents ? "text-warning-strong" : "text-text-muted",
                    )}
                  >
                    <span className="text-text-subtle">Balance </span>
                    <Money value={balance} />
                  </span>
                ) : null}
              </span>
            </>
          );
          return (
            <li key={day}>
              {onSelectDay ? (
                <button
                  type="button"
                  onClick={() => onSelectDay(day)}
                  aria-label={DAY_LONG.format(localDate(day))}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)"
                >
                  {content}
                </button>
              ) : (
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <span className="sr-only">{DAY_LONG.format(localDate(day))}</span>
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
