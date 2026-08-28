import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { addDaysIso, mustAt, projectPaydays } from "@budget/engine";
import { CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon, ListIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.jsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.jsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Chart } from "@/components/chart.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { Money } from "@/components/money.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { MONTH_LABELS } from "@/lib/constants.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";
import { cn } from "@/lib/utils.js";

/** @import { Cents } from "@budget/engine" */
/** @typedef {{ billId: string, dueDate: string, expectedCents: Cents, actualCents: Cents | null, isOverride: boolean, isOrphan: boolean }} MergedInstance */
/** @typedef {{ id: string, name: string }} BillRef */

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

/** @param {string} rgb */
function parseRgbChannels(rgb) {
  const match = rgb.match(/rgba?\(([^)]+)\)/);
  const [r, g, b] = (match?.[1] ?? "0,0,0").split(",").map((n) => parseFloat(n));
  return [r ?? 0, g ?? 0, b ?? 0];
}

/** @param {string} from @param {string} to @param {number} t */
function mixRgb(from, to, t) {
  const a = parseRgbChannels(from);
  const b = parseRgbChannels(to);
  const [r, g, bch] = a.map((channel, i) => Math.round(channel + ((b[i] ?? channel) - channel) * t));
  return `rgb(${r}, ${g}, ${bch})`;
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
        {shown.map((b) => (
          <span key={b.billId} className="truncate rounded bg-negative-soft px-1 py-0.5 text-[0.65rem] text-negative">
            {billsById.get(b.billId)?.name ?? "Bill"}
          </span>
        ))}
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
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{date}</SheetTitle>
          <SheetDescription>
            {isPayday ? "Payday. " : ""}
            {instances.length > 0 ? `${instances.length} bill${instances.length === 1 ? "" : "s"} due, ` : "No bills due, "}
            totalling <Money value={total} />.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-2 px-4 pb-6">
          {instances.map((i) => (
            <div key={i.billId} className="flex items-center justify-between rounded-(--radius-card) bg-surface-muted p-3 text-sm">
              <span className="flex items-center gap-2 text-text">
                {billsById.get(i.billId)?.name ?? "Bill"}
                {i.isOrphan ? <Badge variant="destructive">Orphan</Badge> : null}
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
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [view, setView] = useState(() => /** @type {"month" | "agenda"} */ (window.innerWidth < 768 ? "agenda" : "month"));
  const [selectedDate, setSelectedDate] = useState(/** @type {string | null} */ (null));

  const yearWindow = useMemo(() => ({ from: `${year}-01-01`, to: `${year + 1}-01-01` }), [year]);

  const paySchedulesQuery = useQuery({
    queryKey: ["pay-schedules"],
    queryFn: async () => {
      const res = await api["pay-schedules"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).paySchedules;
    },
  });

  const billsQuery = useQuery({
    queryKey: ["bills"],
    queryFn: async () => {
      const res = await api.bills.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {BillRef[]} */ ((await res.json()).bills);
    },
  });

  const instancesQuery = useQuery({
    queryKey: ["bill-instances", "calendar", year],
    queryFn: async () => {
      const res = await api["bill-instances"].$get({ query: yearWindow });
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
      return new Set(projectPaydays({ anchorDate: primarySchedule.anchorDate, cadence: primarySchedule.cadence }, yearWindow));
    } catch {
      return new Set();
    }
  }, [primarySchedule, yearWindow]);

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

  const monthLabel = new Date(year, month, 1).toLocaleDateString("en-AU", { month: "long", year: "numeric" });
  const cells = useMemo(() => monthGridDays(year, month), [year, month]);
  const monthDatesWithEvents = cells.filter((d) => d !== null && (instancesByDate.has(d) || paydaySet.has(d)));

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

  const heatmapMax = Math.max(1, ...Array.from(instancesByDate.values()).map((list) => list.reduce((s, i) => s + (i.actualCents ?? i.expectedCents), 0)));

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

      <div className="flex items-center justify-between">
        <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => goToMonth(-1)}>
          <ChevronLeftIcon />
        </Button>
        <h2 className="text-sm font-semibold text-text">{monthLabel}</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => goToMonth(1)}>
          <ChevronRightIcon />
        </Button>
      </div>

      {view === "month" ? (
        <div className="rounded-(--radius-card) bg-surface p-2 shadow-(--shadow-card) sm:p-4">
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
                    date === today.toISOString().slice(0, 10) && "border-(--accent)",
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
      ) : monthDatesWithEvents.length === 0 ? (
        <EmptyState icon={CalendarDaysIcon} title="Nothing this month" description="No paydays or bills fall in this month." />
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
          {monthDatesWithEvents.map((date) => {
            const dayInstances = instancesByDate.get(/** @type {string} */ (date)) ?? [];
            const total = dayInstances.reduce((s, i) => s + (i.actualCents ?? i.expectedCents), 0);
            return (
              <button key={date} type="button" onClick={() => setSelectedDate(date)} className="flex items-center justify-between gap-3 p-4 text-left hover:bg-surface-muted">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium text-text">
                    {date}
                    {paydaySet.has(/** @type {string} */ (date)) ? <Badge variant="secondary">Payday</Badge> : null}
                  </p>
                  <p className="truncate text-xs text-text-muted">
                    {dayInstances.map((i) => billsById.get(i.billId)?.name ?? "Bill").join(", ") || "No bills"}
                  </p>
                </div>
                {total > 0 ? <Money value={total} className="shrink-0 font-medium text-text" /> : null}
              </button>
            );
          })}
        </div>
      )}

      <div className="rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
        <p className="mb-3 text-sm font-medium text-text-muted">Outflow intensity — {year}</p>
        {/* By month, not by day: 366 rows of mostly zero is not an
            alternative to anything. The month totals are the figure the
            heatmap is actually communicating. */}
        <Chart
          height={200}
          loading={instancesQuery.isLoading}
          ariaLabel={`Heat map of bill outflow across ${year}. The busiest day is ${formatMoney(heatmapMax, { currency, locale })}.`}
          dataTable={{
            caption: `Bill outflow by month, ${year}`,
            columns: ["Month", "Outflow"],
            rows: monthlyOutflow.map((row) => [row.label, formatMoney(row.totalCents, { currency, locale })]),
          }}
          option={(tokens) => ({
            calendar: {
              range: String(year),
              cellSize: ["auto", 14],
              itemStyle: { borderWidth: 3, borderColor: tokens.surface },
              splitLine: { lineStyle: { color: tokens.grid } },
              yearLabel: { show: false },
              dayLabel: { color: tokens.axisLabel },
              monthLabel: { color: tokens.axisLabel },
            },
            visualMap: { show: false, min: 0, max: heatmapMax, dimension: 1 },
            series: [
              {
                type: "heatmap",
                coordinateSystem: "calendar",
                data: Array.from({ length: 366 }, (_, i) => {
                  const date = addDaysIso(`${year}-01-01`, i);
                  if (!date.startsWith(String(year))) return null;
                  const total = (instancesByDate.get(date) ?? []).reduce((s, inst) => s + (inst.actualCents ?? inst.expectedCents), 0);
                  return {
                    value: [date, total / 100],
                    itemStyle: { color: mixRgb(tokens.accentSoft, mustAt(tokens.series, 3, "chart series colour"), Math.min(total / heatmapMax, 1)) },
                  };
                }).filter((d) => d !== null),
              },
            ],
          })}
        />
      </div>

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
