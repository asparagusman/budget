import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectPaydays } from "@budget/engine";
import { CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon, ListIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.jsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.jsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  AXIS,
  Chart,
  ChartTooltip,
  MoneyTooltip,
  useChartMotion,
  useMoneyTick,
} from "@/components/chart.jsx";
import { BillsAgenda, DAY_LONG, isPlaceholder, localDate } from "@/components/bills-agenda.jsx";
import { Money } from "@/components/money.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { QueryError } from "@/components/query-error.jsx";
import { registerCommands } from "@/lib/commands.js";
import { MONTH_LABELS } from "@/lib/constants.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";
import { todayIso } from "@/lib/dates.js";
import { LG, useMediaQuery } from "@/lib/use-media-query.js";
import { cn } from "@/lib/utils.js";
import { billsQueryOptions, calendarInstancesQueryOptions, paySchedulesQueryOptions } from "@/lib/queries.js";

/** @import { Cents } from "@budget/engine" */
/** @typedef {{ billId: string, dueDate: string, expectedCents: Cents, actualCents: Cents | null, isOverride: boolean, isOrphan: boolean }} MergedInstance */
/** @typedef {{ id: string, name: string, dueDateConfirmed: boolean }} BillRef */

const WEEKDAY_LABELS = /** @type {const} */ (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

/** @param {number} year @param {number} month 0-11 */
function monthGridDays(year, month) {
  const first = new Date(year, month, 1);
  // Monday-first grid: JS getDay() is 0 (Sun) - 6 (Sat); shift so Monday = 0.
  const leadingBlanks = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  /** @type {(string | null)[]} */
  const cells = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/**
 * @param {{ date: string, total: Cents, isPayday: boolean, bills: MergedInstance[], billsById: Map<string, BillRef> }} props
 */
function DayChips({ date, total, isPayday, bills, billsById }) {
  const shown = bills.slice(0, 2);
  const extra = bills.length - shown.length;
  return (
    <div className="flex min-h-20 flex-col gap-1 rounded-md p-1.5 text-left">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text">{Number(date.slice(8, 10))}</span>
        {isPayday ? <span className="size-1.5 rounded-full bg-positive" title="Payday" /> : null}
      </div>
      <div className="flex flex-col gap-0.5">
        {shown.map((b) => {
          const placeholder = isPlaceholder(b, billsById);
          return (
            <span
              key={b.billId}
              className={cn(
                "truncate rounded bg-negative-soft px-1 py-0.5 text-[0.65rem] text-negative",
                // No room for a badge in a 7-column cell: an amber dashed
                // edge marks the guess, and the day's sheet spells it out.
                placeholder && "outline-1 -outline-offset-1 outline-dashed outline-warning-strong",
              )}
            >
              {billsById.get(b.billId)?.name ?? "Bill"}
              {placeholder ? <span className="sr-only"> (placeholder date)</span> : null}
            </span>
          );
        })}
        {extra > 0 ? <span className="text-[0.65rem] text-text-subtle">+{extra} more</span> : null}
      </div>
      {total > 0 ? (
        <span className="mt-auto text-[0.65rem] font-medium text-text-muted">
          <Money value={total} compact />
        </span>
      ) : null}
    </div>
  );
}

/**
 * @param {{ date: string | null, onOpenChange: (open: boolean) => void, instances: MergedInstance[], isPayday: boolean, billsById: Map<string, BillRef> }} props
 */
function DayDetailSheet({ date, onOpenChange, instances, isPayday, billsById }) {
  const total = instances.reduce((sum, i) => sum + (i.actualCents ?? i.expectedCents), 0);
  return (
    <Sheet open={date !== null} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" scrollable className="max-h-[80vh]">
        <SheetHeader>
          <SheetTitle>{date ? DAY_LONG.format(localDate(date)) : null}</SheetTitle>
          <SheetDescription>
            {isPayday ? "Payday. " : ""}
            {instances.length > 0 ? `${instances.length} bill${instances.length === 1 ? "" : "s"} due, ` : "No bills due, "}
            totalling <Money value={total} />.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-2 px-4 pb-6">
          {instances.map((i) => (
            <div key={i.billId} className="flex items-center justify-between rounded-(--radius-card) bg-surface-muted p-3 text-sm">
              <span className="flex flex-wrap items-center gap-2 text-text">
                {billsById.get(i.billId)?.name ?? "Bill"}
                {isPlaceholder(i, billsById) ? <Badge variant="attention">Placeholder date</Badge> : null}
                {i.isOrphan ? <Badge variant="attention">Orphan</Badge> : null}
                {i.isOverride ? <Badge variant="secondary">Override</Badge> : null}
              </span>
              <Money value={i.actualCents ?? i.expectedCents} />
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Cash flow by real date, built on the primary pay schedule and projected
 * instances — a month grid on desktop, an agenda list by default on mobile
 * (phases/06-fixed-costs.md "/calendar": "A month grid at 375px cannot show
 * amounts legibly").
 */
export function CalendarPage() {
  const { currency, locale } = useSettings();
  const moneyTick = useMoneyTick();
  const motion = useChartMotion();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [view, setView] = useState(() => /** @type {"month" | "agenda"} */ (window.innerWidth < 768 ? "agenda" : "month"));
  const [selectedDate, setSelectedDate] = useState(/** @type {string | null} */ (null));

  const yearWindow = useMemo(() => ({ from: `${year}-01-01`, to: `${year + 1}-01-01` }), [year]);

  const paySchedulesQuery = useQuery(paySchedulesQueryOptions());

  const billsQuery = useQuery(billsQueryOptions());

  const instancesQuery = useQuery(calendarInstancesQueryOptions(year));

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
      return new Set(projectPaydays({ anchorDate: primarySchedule.anchorDate, cadence: primarySchedule.cadence }, yearWindow));
    } catch {
      return new Set();
    }
  }, [primarySchedule, yearWindow]);

  // The Agenda view fetches its own month, so it can share one component
  // with /fixed-costs; the grid, the chart and the day sheet read the year.
  const monthWindow = useMemo(
    () => ({
      from: `${year}-${String(month + 1).padStart(2, "0")}-01`,
      to: month === 11 ? `${year + 1}-01-01` : `${year}-${String(month + 2).padStart(2, "0")}-01`,
    }),
    [year, month],
  );

  useEffect(
    () =>
      registerCommands([
        {
          id: "calendar:today",
          group: "Actions",
          label: "Jump to today",
          icon: CalendarDaysIcon,
          run: () => {
            const now = new Date();
            setYear(now.getFullYear());
            setMonth(now.getMonth());
          },
        },
      ]),
    [],
  );

  // Not `today.toISOString()`: that is the UTC date, which in Australia is
  // still yesterday until mid-morning.
  const todayIsoDate = todayIso();
  const isDesktop = useMediaQuery(LG);
  const monthLabel = new Date(year, month, 1).toLocaleDateString("en-AU", { month: "long", year: "numeric" });
  const cells = useMemo(() => monthGridDays(year, month), [year, month]);
  // A failed load used to fall through to "Nothing this month", which reads
  // as "no bills are due" — the one thing this screen must never say wrongly.
  const loadError = instancesQuery.error ?? billsQuery.error ?? paySchedulesQuery.error ?? null;

  /** @param {number} delta */
  function goToMonth(delta) {
    let m = month + delta;
    let y = year;
    if (m < 0) {
      m = 11;
      y -= 1;
    } else if (m > 11) {
      m = 0;
      y += 1;
    }
    setMonth(m);
    setYear(y);
  }

  // The heat map's text alternative, rolled up to months — see the comment
  // where it is passed to <Chart>.
  const monthlyOutflow = useMemo(() => {
    const totals = MONTH_LABELS.map((label) => ({ label, totalCents: 0 }));
    for (const [date, list] of instancesByDate) {
      if (!date.startsWith(String(year))) continue;
      const index = Number(date.slice(5, 7)) - 1;
      const bucket = totals[index];
      if (!bucket) continue;
      bucket.totalCents += list.reduce((sum, i) => sum + (i.actualCents ?? i.expectedCents), 0);
    }
    return totals;
  }, [instancesByDate, year]);

  // Memoised so clicking a day or switching Month/Agenda doesn't hand the
  // chart a new array — Recharts restarts its animation on one
  // (perf-inp-plan.md, P1.5).
  const outflowRows = useMemo(
    () =>
      monthlyOutflow.map((row) => ({
        label: row.label.slice(0, 3),
        outflow: row.totalCents / 100,
      })),
    [monthlyOutflow],
  );

  const heaviestMonth = monthlyOutflow.reduce(
    (max, row) => (row.totalCents > max.totalCents ? row : max),
    { label: "no month", totalCents: 0 },
  );

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Paydays and bills due, by real date."
        actions={
          <Tabs value={view} onValueChange={(v) => setView(/** @type {"month" | "agenda"} */ (v))}>
            <TabsList>
              <TabsTrigger value="month">
                <CalendarDaysIcon className="size-4" /> Month
              </TabsTrigger>
              <TabsTrigger value="agenda">
                <ListIcon className="size-4" /> Agenda
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {/* One card: the month stepper is the header of the thing it steps,
          rather than a strip floating between the page header and the grid. */}
      <section
        aria-labelledby="calendar-month"
        className="overflow-hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card)"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-2 sm:px-3">
          <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => goToMonth(-1)}>
            <ChevronLeftIcon />
          </Button>
          <h2 id="calendar-month" className="text-sm font-semibold text-text">
            {monthLabel}
          </h2>
          <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => goToMonth(1)}>
            <ChevronRightIcon />
          </Button>
        </div>

        {loadError ? (
          <div className="p-2 sm:p-4">
            <QueryError
              error={loadError}
              what="this month's bills and paydays"
              onRetry={() => Promise.all([instancesQuery.refetch(), billsQuery.refetch(), paySchedulesQuery.refetch()])}
            />
          </div>
        ) : view === "month" ? (
          <div className="p-2 sm:p-4">
            <div className="grid grid-cols-7 gap-1 text-center text-xs text-text-muted">
              {WEEKDAY_LABELS.map((w) => (
                <div key={w} className="py-1">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {cells.map((date, i) =>
                date === null ? (
                  <div key={i} />
                ) : (
                  <button
                    key={date}
                    type="button"
                    onClick={() => setSelectedDate(date)}
                    className={cn(
                      "rounded-md border border-transparent transition-colors hover:border-border hover:bg-surface-muted",
                      date === todayIsoDate && "border-(--accent)",
                    )}
                  >
                    <DayChips
                      date={date}
                      total={(instancesByDate.get(date) ?? []).reduce((s, i) => s + (i.actualCents ?? i.expectedCents), 0)}
                      isPayday={paydaySet.has(date)}
                      bills={instancesByDate.get(date) ?? []}
                      billsById={billsById}
                    />
                  </button>
                ),
              )}
            </div>
          </div>
        ) : (
          <BillsAgenda
            window={monthWindow}
            emptyTitle="Nothing this month"
            emptyDescription="No paydays or bills fall in this month."
            onSelectDay={setSelectedDate}
          />
        )}
      </section>

      {/* Hidden while the bills failed to load: twelve empty bars would say
          "nothing goes out this year", which the error above says it can't
          know. */}
      {instancesQuery.error ? null : (
        <section className="rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5">
          <h2 className="mb-3 text-sm font-semibold text-text">Outflow by month — {year}</h2>
          {/* This was a day-by-day calendar heat map. Two problems with that
              shape: 366 cells of mostly zero say very little about a household
              whose bills land on a dozen dates, and the panel's own data table
              was already by MONTH — the comment there said outright that the
              month totals are "the figure the heatmap is actually
              communicating". So the figure it was communicating is now what it
              draws. */}
          <Chart
            height={200}
            loading={instancesQuery.isLoading}
            ariaLabel={`Bill outflow by month across ${year}. The heaviest month is ${heaviestMonth.label} at ${formatMoney(heaviestMonth.totalCents, { currency, locale })}.`}
            dataTable={() => ({
              caption: `Bill outflow by month, ${year}`,
              columns: ["Month", "Outflow"],
              rows: monthlyOutflow.map((row) => [row.label, formatMoney(row.totalCents, { currency, locale })]),
            })}
            config={{ outflow: { label: "Outflow", color: "var(--negative)" } }}
          >
            <BarChart data={outflowRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} />
              {/* Every month labelled, so a phone gets initials: twelve "Sep"s
                  at 375px ran into each other as "JanFebMar". */}
              <XAxis
                dataKey="label"
                {...AXIS}
                interval={0}
                tickFormatter={isDesktop ? undefined : (label) => String(label).slice(0, 1)}
              />
              <YAxis {...AXIS} width={56} tickFormatter={moneyTick} />
              <ChartTooltip content={<MoneyTooltip />} />
              <Bar dataKey="outflow" fill="var(--color-outflow)" radius={[4, 4, 0, 0]} {...motion} />
            </BarChart>
          </Chart>
        </section>
      )}

      <DayDetailSheet
        date={selectedDate}
        onOpenChange={(open) => !open && setSelectedDate(null)}
        instances={selectedDate ? (instancesByDate.get(selectedDate) ?? []) : []}
        isPayday={selectedDate !== null && paydaySet.has(selectedDate)}
        billsById={billsById}
      />
    </>
  );
}
