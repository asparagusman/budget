import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDaysIso } from "@budget/engine";
import { BanknoteIcon, InfoIcon, TrendingUpIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.jsx";
import { Area, AreaChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  AXIS,
  Chart,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  MoneyTooltip,
  PROJECTED,
  TIME_AXIS,
  TOTAL,
  isoToMs,
  useChartMotion,
  useMoneyTick,
  useTimeAxis,
} from "@/components/chart.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { PanelSkeleton } from "@/components/loading.jsx";
import { Money } from "@/components/money.jsx";
import { NoticeList } from "@/components/notice.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { PageSection } from "@/components/page-section.jsx";
import { QueryError } from "@/components/query-error.jsx";
import { QuickBalanceSheet } from "@/components/quick-balance-sheet.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { formatIsoDate } from "@/lib/dates.js";
import { colorFor, entityColors } from "@/lib/entity-colors.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";
import { useTodayIso } from "@/lib/use-today.js";
import { ScrollArea } from "@/components/scroll-area.jsx";

/** @import { Cents } from "@budget/engine" */

/** @typedef {{ id: string, name: string, type: "transaction" | "savings" | "investment" | "external", latestBalance: { amountCents: Cents, asAt: string } | null }} Account */
/**
 * @typedef {{
 *   id: string, name: string, type: string,
 *   annualGrowthRate: number, monthlyRate: number,
 *   currentBalanceCents: Cents, currentBalanceAsAt: string | null,
 *   contributionPerMonthCents: Cents,
 *   byHorizon: Record<string, Cents>,
 *   series: { month: number, projectedCents: Cents }[],
 * }} ProjectedAccount
 */
/**
 * @typedef {{
 *   on: string, months: number, horizons: number[],
 *   allocationPlan: { id: string, name: string } | null,
 *   accounts: ProjectedAccount[],
 *   totalSeries: { month: number, projectedCents: Cents }[],
 *   warnings: { code: string, message: string }[],
 * }} Projections
 */
/**
 * @typedef {{
 *   window: { from: string, to: string },
 *   knownFrom: string | null,
 *   accounts: { id: string, name: string, type: string, archivedOn: string | null, points: { date: string, balanceCents: Cents, asAt: string | null }[] }[],
 *   totalPoints: { date: string, totalCents: Cents }[],
 * }} NetWorth
 */

const HORIZON_OPTIONS = /** @type {const} */ (["12", "24", "36", "60"]);
const NET_WORTH_LOOKBACK_DAYS = 730;

/**
 * The growth rate, edited as a real annual percentage. The spreadsheet stored
 * 0.0041 monthly and formatted it as `0%`, so the assumption behind every
 * projected figure was invisible for months
 * (phases/09-goals-projections.md "/projections").
 *
 * @param {{ account: ProjectedAccount, saving: boolean, onSave: (annualGrowthRate: number) => void }} props
 */
function GrowthRateInput({ account, saving, onSave }) {
  const asPercent = (account.annualGrowthRate * 100).toFixed(4).replace(/\.?0+$/, "");
  const [text, setText] = useState(asPercent);

  // Re-sync when the server's value changes (another session, or our own save
  // landing) — but never while this field is the one being typed in.
  useEffect(() => {
    setText(asPercent);
  }, [asPercent]);

  function commit() {
    const parsed = Number(text.trim() === "" ? "0" : text);
    if (Number.isNaN(parsed) || parsed < 0) {
      setText(asPercent);
      return;
    }
    // Six decimal places is what the column holds, and snapping here avoids
    // sending 0.05032500000000001 for a typed 5.0325.
    const next = Number((parsed / 100).toFixed(6));
    if (next === account.annualGrowthRate) return;
    onSave(next);
  }

  return (
    <InputGroup className="h-9 w-28">
      <InputGroupInput
        aria-label={`${account.name} annual growth rate`}
        type="number"
        step="0.01"
        min="0"
        inputMode="decimal"
        disabled={saving}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") setText(asPercent);
        }}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupText className="text-xs">%</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  );
}

/**
 * @param {{ projections: Projections, savingId: string | null, onSaveRate: (accountId: string, rate: number) => void }} props
 */
function ProjectionsTable({ projections, savingId, onSaveRate }) {
  return (
    <ScrollArea axis="x" className="rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-muted">
            <th className="sticky left-0 z-10 bg-surface px-4 py-3 font-medium">Account</th>
            <th className="px-3 py-3 text-right font-medium">Balance</th>
            <th className="px-3 py-3 text-right font-medium">Contribution</th>
            <th className="px-3 py-3 font-medium whitespace-nowrap">Growth (p.a.)</th>
            {projections.horizons.map((h) => (
              <th key={h} className="px-3 py-3 text-right font-medium whitespace-nowrap">
                {h} mo
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {projections.accounts.map((account) => (
            <tr key={account.id}>
              <td className="sticky left-0 z-10 bg-surface px-4 py-3 whitespace-nowrap">
                <p className="font-medium text-text">{account.name}</p>
                <p className="text-xs text-text-subtle">
                  {account.currentBalanceAsAt
                    ? `as at ${formatIsoDate(account.currentBalanceAsAt, "en-AU")}`
                    : "no balance recorded"}
                </p>
              </td>
              <td className="px-3 py-3 text-right whitespace-nowrap text-text">
                <Money value={account.currentBalanceCents} />
              </td>
              <td className="px-3 py-3 text-right whitespace-nowrap text-text-muted">
                <Money value={account.contributionPerMonthCents} />
                <span className="text-text-subtle">/month</span>
              </td>
              <td className="px-3 py-3">
                <GrowthRateInput
                  account={account}
                  saving={savingId === account.id}
                  onSave={(rate) => onSaveRate(account.id, rate)}
                />
              </td>
              {projections.horizons.map((h) => (
                <td key={h} className="px-3 py-3 text-right whitespace-nowrap text-text">
                  <Money value={account.byHorizon[String(h)] ?? 0} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border text-xs">
            <td className="sticky left-0 z-10 bg-surface px-4 py-3 font-medium whitespace-nowrap text-text-muted">
              Household total
              <span className="block text-xs font-normal text-text-subtle">savings &amp; investment only</span>
            </td>
            <td className="px-3 py-3 text-right font-semibold whitespace-nowrap text-text">
              <Money value={projections.totalSeries[0]?.projectedCents ?? 0} />
            </td>
            <td />
            <td />
            {projections.horizons.map((h) => (
              <td key={h} className="px-3 py-3 text-right font-semibold whitespace-nowrap text-text">
                <Money value={projections.totalSeries[h]?.projectedCents ?? 0} />
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </ScrollArea>
  );
}

/**
 * Mobile: one card per account with a horizon selector, rather than a table
 * that has to scroll sideways to reach the number the operator came for.
 *
 * @param {{ projections: Projections, horizon: number, onHorizonChange: (months: number) => void, savingId: string | null, onSaveRate: (accountId: string, rate: number) => void }} props
 */
function ProjectionCards({ projections, horizon, onHorizonChange, savingId, onSaveRate }) {
  return (
    <div className="flex flex-col gap-3">
      {/* Inline, the same shape as the section's Horizon control above it,
          so the two read as a pair of settings rather than a form. */}
      <div className="flex items-center gap-2">
        <label htmlFor="projection-horizon" className="text-sm text-text-muted">
          Show value at
        </label>
        <Select value={String(horizon)} onValueChange={(v) => onHorizonChange(Number(v))}>
          <SelectTrigger id="projection-horizon" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {projections.horizons.map((h) => (
              <SelectItem key={h} value={String(h)}>
                {h} months
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col divide-y divide-border rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
        {projections.accounts.map((account) => (
          <div key={account.id} className="flex flex-col gap-2 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-text">{account.name}</p>
                <p className="text-xs text-text-muted">
                  <Money value={account.currentBalanceCents} /> now ·{" "}
                  <Money value={account.contributionPerMonthCents} />
                  /month
                </p>
              </div>
              <p className="shrink-0 text-right">
                <span className="font-semibold text-text">
                  <Money value={account.byHorizon[String(horizon)] ?? 0} />
                </span>
                <span className="block text-xs text-text-subtle">in {horizon} months</span>
              </p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-text-subtle">Assumed growth</span>
              <GrowthRateInput
                account={account}
                saving={savingId === account.id}
                onSave={(rate) => onSaveRate(account.id, rate)}
              />
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 p-4">
          <span className="text-sm font-medium text-text-muted">
            Household total
            <span className="block text-xs font-normal text-text-subtle">savings &amp; investment only</span>
          </span>
          <span className="font-semibold text-text">
            <Money value={projections.totalSeries[horizon]?.projectedCents ?? 0} />
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Balance history across everything the household owns. Never interpolated:
 * each point is the last balance recorded at or before it, so a flat stretch
 * means "nobody updated it", not "nothing changed"
 * (phases/09-goals-projections.md "API").
 *
 * @param {{ netWorth: NetWorth, loading: boolean, onUpdateBalance: () => void }} props
 */
function NetWorthPanel({ netWorth, loading, onUpdateBalance }) {
  const { currency, locale } = useSettings();
  const moneyTick = useMoneyTick();
  const motion = useChartMotion();

  // Before the first recorded balance every total is a zero that means
  // "unknown"; drawing it would put a cliff in the chart that never happened.
  // Memoised: filtered fresh every render, it was a new array each time,
  // which defeated the `rows` memo below and restarted the chart's entrance
  // animation on every render of the page (perf-inp-plan.md, P1.5).
  const points = useMemo(() => {
    const knownFrom = netWorth.knownFrom;
    return knownFrom ? netWorth.totalPoints.filter((p) => p.date >= knownFrom) : [];
  }, [netWorth.totalPoints, netWorth.knownFrom]);
  const latest = points[points.length - 1] ?? null;
  // The stalest balance among the accounts still held. An account archived
  // inside the window reads `asAt: null` from its archive date on (the API
  // ends it there), so its last recorded balance can't make today's figure
  // look out of date.
  const oldestAsAt = netWorth.accounts
    .flatMap((a) => {
      const asAt = a.archivedOn === null ? a.points[a.points.length - 1]?.asAt : null;
      return asAt ? [asAt] : [];
    })
    .sort()[0];

  // A real time axis rather than one tick per recorded date: these dates are
  // whenever somebody happened to record a balance, so counting them evenly
  // draws a month-long gap the same width as a day-long one.
  const rows = useMemo(
    () =>
      points.map((point) => ({
        t: isoToMs(point.date),
        label: formatIsoDate(point.date, locale),
        netWorth: point.totalCents / 100,
      })),
    [points, locale],
  );
  const timeAxis = useTimeAxis(rows[0]?.t ?? 0, rows[rows.length - 1]?.t ?? 0);

  return (
    <PageSection
      title="Net worth"
      actions={
        <Button size="sm" variant="outline" onClick={onUpdateBalance}>
          <BanknoteIcon />
          Update balance
        </Button>
      }
    >
      {/* One surface: the two figures are the chart's own headline, not
          separate objects beside it. */}
      <div className="flex flex-col gap-4 rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1">
          <div className="row-span-3 grid min-w-0 grid-rows-subgrid gap-y-1">
            <dt className="text-xs font-medium tracking-wide text-text-subtle uppercase">Now</dt>
            <dd className="self-end text-2xl font-bold tracking-tight text-text tabular-nums sm:text-3xl">
              {latest ? <Money value={latest.totalCents} /> : <span className="text-text-subtle">—</span>}
            </dd>
            <dd className="text-xs text-pretty text-text-muted">
              Excludes external accounts — money sent out isn&apos;t net worth.
            </dd>
          </div>
          <div className="row-span-3 grid min-w-0 grid-rows-subgrid gap-y-1">
            <dt className="text-xs font-medium tracking-wide text-text-subtle uppercase">Oldest balance</dt>
            <dd className="self-end text-xl font-semibold tracking-tight text-text sm:text-2xl">
              {oldestAsAt ? formatIsoDate(oldestAsAt, locale) : <span className="text-text-subtle">—</span>}
            </dd>
            <dd className="text-xs text-pretty text-text-muted">Balances are carried forward, never interpolated.</dd>
          </div>
        </dl>

        <Chart
          loading={loading}
          empty={points.length < 2}
          height={220}
          ariaLabel={`Net worth over ${points.length} recorded dates${latest ? `, currently ${formatMoney(latest.totalCents, { currency, locale })}` : ""}.`}
          dataTable={() => ({
            caption: "Net worth at each recorded date",
            columns: ["Date", "Net worth"],
            rows: points.map((point) => [
              formatIsoDate(point.date, locale),
              formatMoney(point.totalCents, { currency, locale }),
            ]),
          })}
          emptyTitle="Not enough history yet"
          emptyDescription="Record a balance on two different dates to see net worth move."
          config={{ netWorth: { label: "Net worth", color: TOTAL } }}
        >
          <AreaChart data={rows} margin={{ top: 16, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="t" {...AXIS} {...TIME_AXIS} {...timeAxis} minTickGap={32} />
            <YAxis {...AXIS} width={56} tickFormatter={moneyTick} />
            <ChartTooltip content={<MoneyTooltip />} />
            {/* A step, never a slope: between two snapshots the balance is
                the older one carried forward, and a diagonal would draw a
                hundred days of movement nobody recorded. */}
            <Area
              dataKey="netWorth"
              type="stepAfter"
              stroke="var(--color-netWorth)"
              fill="var(--color-netWorth)"
              fillOpacity={0.15}
              strokeWidth={2}
              dot={points.length < 40}
              {...motion}
            />
          </AreaChart>
        </Chart>
      </div>
    </PageSection>
  );
}

/**
 * The spreadsheet's Projections sheet, done properly: one flat growth rate per
 * account, visible and editable as a real annual percentage, compounded by the
 * engine. No scenarios, no Monte Carlo, no variable returns
 * (phases/09-goals-projections.md "Non-goals").
 */
export function ProjectionsPage() {
  const queryClient = useQueryClient();
  const { currency, locale } = useSettings();
  const moneyTick = useMoneyTick();
  const motion = useChartMotion();
  const today = useTodayIso();
  const [months, setMonths] = useState(/** @type {(typeof HORIZON_OPTIONS)[number]} */ ("60"));
  const [mobileHorizon, setMobileHorizon] = useState(12);
  const [savingId, setSavingId] = useState(/** @type {string | null} */ (null));
  const [balanceOpen, setBalanceOpen] = useState(false);

  const projectionsQuery = useQuery({
    queryKey: ["projections", months, today],
    queryFn: async () => {
      // The browser's today: "now" on every series is counted from it, and
      // the server's own clock can sit in another zone.
      const res = await api.projections.$get({ query: { months, on: today } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {Projections} */ (await res.json());
    },
  });

  const netWorthQuery = useQuery({
    queryKey: ["net-worth", today],
    queryFn: async () => {
      const res = await api["net-worth"].$get({
        query: { from: addDaysIso(today, -NET_WORTH_LOOKBACK_DAYS), to: today },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {NetWorth} */ (await res.json());
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

  const saveRate = useMutation({
    mutationFn: async (/** @type {{ accountId: string, annualGrowthRate: number }} */ { accountId, annualGrowthRate }) => {
      setSavingId(accountId);
      const res = await api.accounts[":id"].$patch({ param: { id: accountId }, json: { annualGrowthRate } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projections"] });
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      toast.success("Growth rate saved.");
    },
    onError: (err) => toast.error(err.message),
    onSettled: () => setSavingId(null),
  });

  const updateBalance = useMutation({
    mutationFn: async (/** @type {{ accountId: string, asAt: string, amountCents: number }} */ { accountId, ...data }) => {
      const res = await api.accounts[":id"].balances.$post({ param: { id: accountId }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["net-worth"] });
      queryClient.invalidateQueries({ queryKey: ["projections"] });
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      toast.success("Balance updated.");
    },
  });

  useEffect(
    () =>
      registerCommands([
        {
          id: "projections:update-balance",
          group: "Actions",
          label: "Update balance",
          icon: BanknoteIcon,
          run: () => setBalanceOpen(true),
        },
      ]),
    [],
  );

  const projections = projectionsQuery.data ?? null;
  const netWorth = netWorthQuery.data ?? null;
  const accounts = accountsQuery.data ?? [];

  // The phone's "Show value at", kept to a horizon this projection actually
  // has. Shortening Horizon to 12 months after choosing 24 left the cards
  // reading a 24-month figure that no longer existed — $0.00 on every
  // account. The choice itself is kept, so lengthening Horizon again brings
  // it back.
  const horizons = projections?.horizons ?? [];
  const fittingHorizons = horizons.filter((h) => h <= mobileHorizon);
  const shownHorizon = horizons.includes(mobileHorizon)
    ? mobileHorizon
    : (fittingHorizons[fittingHorizons.length - 1] ?? horizons[0] ?? mobileHorizon);
  // Every account, not just the projected ones, so each keeps the colour it
  // wears on every other chart.
  const accountColors = useMemo(
    () => entityColors((accountsQuery.data ?? []).map((account) => account.id)),
    [accountsQuery.data],
  );

  // Every series draws from one row array, so each account becomes a COLUMN
  // on the row for its month. Keyed `account0`, `account1`, … rather than by
  // name: an account may be called "Total", or share a name with another,
  // and a data key has to be unique. The display name lives in the config.
  const { chartConfig, chartRows } = useMemo(() => {
    const accountSeries = projections?.accounts ?? [];
    const totals = projections?.totalSeries ?? [];

    /** @type {import("@/components/ui/chart.jsx").ChartConfig} */
    const config = { total: { label: "Household total", color: TOTAL } };
    accountSeries.forEach((account, i) => {
      config[`account${i}`] = { label: account.name, color: colorFor(accountColors, account.id) };
    });

    const rows = totals.map((point, index) => {
      /** @type {Record<string, number | string>} */
      const row = {
        label: point.month === 0 ? "now" : `In ${point.month} months`,
        month: point.month === 0 ? "now" : `${point.month}mo`,
        total: point.projectedCents / 100,
      };
      accountSeries.forEach((account, i) => {
        const at = account.series[index];
        if (at) row[`account${i}`] = at.projectedCents / 100;
      });
      return row;
    });

    return { chartConfig: config, chartRows: rows };
  }, [projections, accountColors]);

  return (
    <>
      <PageHeader
        title="Projections"
        description="Where each account lands at your current contributions and one flat growth rate. A projection, not a promise — nothing here writes anything."
      />

      {netWorth ? (
        <NetWorthPanel
          netWorth={netWorth}
          loading={netWorthQuery.isLoading}
          onUpdateBalance={() => setBalanceOpen(true)}
        />
      ) : netWorthQuery.isError ? (
        // The panel used to just not appear, which reads as "this page has
        // no net worth section" rather than "it didn't load".
        <PageSection title="Net worth">
          <QueryError error={netWorthQuery.error} onRetry={() => netWorthQuery.refetch()} what="net worth history" />
        </PageSection>
      ) : null}

      {projections?.warnings.length ? (
        <NoticeList items={projections.warnings.map((w, i) => ({ key: String(i), content: w.message }))} />
      ) : null}

      <PageSection
        title="Projected balances"
        description={
          <span className="inline-flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <InfoIcon className="size-3.5 shrink-0 text-text-subtle" aria-label="Which accounts are projected?" />
              </TooltipTrigger>
              <TooltipContent>
                Savings and investment accounts only. A transaction account&apos;s allocation is spent, not
                accumulated, so compounding it would project money you&apos;ve already used.
              </TooltipContent>
            </Tooltip>
            {projections?.allocationPlan
              ? `Contributions from the ${projections.allocationPlan.name} allocation`
              : "No active allocation — contributions read as zero"}
          </span>
        }
        actions={
          // The horizon only changes this section — the table's columns and
          // the chart's length — so it sits here rather than in the page
          // header, above a net worth panel it does nothing to.
          <div className="flex items-center gap-2">
            <label htmlFor="projection-months" className="text-sm text-text-muted">
              Horizon
            </label>
            <Select
              value={months}
              onValueChange={(v) => setMonths(/** @type {(typeof HORIZON_OPTIONS)[number]} */ (v))}
            >
              <SelectTrigger id="projection-months" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HORIZON_OPTIONS.map((h) => (
                  <SelectItem key={h} value={h}>
                    {h} months
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      >
        {projectionsQuery.isLoading ? (
          <PanelSkeleton height={320} label="Loading projections" />
        ) : projectionsQuery.isError ? (
          // Not "Nothing to project yet", which sends the operator off to add
          // accounts that already exist.
          <QueryError error={projectionsQuery.error} onRetry={() => projectionsQuery.refetch()} what="projections" />
        ) : !projections || projections.accounts.length === 0 ? (
          <EmptyState
            icon={TrendingUpIcon}
            title="Nothing to project yet"
            description="Add a savings or investment account, record its balance, and set a growth rate to see where it lands."
          />
        ) : (
          <>
            <div className="hidden md:block">
              <ProjectionsTable
                projections={projections}
                savingId={savingId}
                onSaveRate={(accountId, annualGrowthRate) => saveRate.mutate({ accountId, annualGrowthRate })}
              />
            </div>
            <div className="md:hidden">
              <ProjectionCards
                projections={projections}
                horizon={shownHorizon}
                onHorizonChange={setMobileHorizon}
                savingId={savingId}
                onSaveRate={(accountId, annualGrowthRate) => saveRate.mutate({ accountId, annualGrowthRate })}
              />
            </div>

            {/* The desktop table above IS the per-account breakdown, but
                it is `hidden` below md and the mobile cards show one horizon
                at a time — so the chart still needs a table of its own for
                the combined total. */}
            <div className="rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5">
              <Chart
                height={320}
                ariaLabel={`Projected balance per account and in total, over ${projections?.totalSeries.length ?? 0} monthly steps.`}
                dataTable={() => ({
                  caption: "Projected total across all accounts, by month",
                  columns: ["Months from now", "Projected total"],
                  rows: (projections?.totalSeries ?? []).map((point) => [
                    point.month === 0 ? "now" : `${point.month}`,
                    formatMoney(point.projectedCents, { currency, locale }),
                  ]),
                })}
                config={chartConfig}
              >
                <LineChart data={chartRows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="month" {...AXIS} minTickGap={24} />
                  <YAxis {...AXIS} width={56} tickFormatter={moneyTick} />
                  <ChartTooltip content={<MoneyTooltip />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  {(projections?.accounts ?? []).map((account, i) => (
                    <Line
                      key={account.id}
                      dataKey={`account${i}`}
                      type="monotone"
                      stroke={`var(--color-account${i})`}
                      strokeWidth={2}
                      dot={false}
                      {...PROJECTED}
                      {...motion}
                    />
                  ))}
                  {/* The household total is the sum of the lines above it, so
                      it is drawn in ink and heavier rather than taking a
                      series colour that would read as one more account. Every
                      line here is a forecast, so every line is dashed. */}
                  <Line
                    dataKey="total"
                    type="monotone"
                    stroke="var(--color-total)"
                    strokeWidth={3}
                    dot={false}
                    {...PROJECTED}
                    {...motion}
                  />
                </LineChart>
              </Chart>
            </div>

            <p className="px-1 text-xs text-text-subtle">
              Growth rates are annual and compounded monthly by the engine — enter 5.03, not 0.0041. One flat rate per
              account: no scenarios, no market modelling.
            </p>
          </>
        )}
      </PageSection>

      <QuickBalanceSheet
        open={balanceOpen}
        onOpenChange={setBalanceOpen}
        accounts={accounts}
        accountId={null}
        submitting={updateBalance.isPending}
        onSubmit={async (accountId, data) => {
          await updateBalance.mutateAsync({ accountId, ...data });
        }}
      />
    </>
  );
}
