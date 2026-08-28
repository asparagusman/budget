import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDaysIso } from "@budget/engine";
import { AlertTriangleIcon, BanknoteIcon, InfoIcon, TrendingUpIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.jsx";
import { Chart } from "@/components/chart.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { Money } from "@/components/money.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { QuickBalanceSheet } from "@/components/quick-balance-sheet.jsx";
import { StatTile } from "@/components/stat-tile.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { formatIsoDate, todayIso } from "@/lib/dates.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";

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
 *   accounts: { id: string, name: string, type: string, points: { date: string, balanceCents: Cents, asAt: string | null }[] }[],
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
    <div className="overflow-x-auto rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-muted">
            <th className="px-4 py-3 font-medium">Account</th>
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
              <td className="px-4 py-3 whitespace-nowrap">
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
            <td className="px-4 py-3 font-medium whitespace-nowrap text-text-muted">
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
    </div>
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
      <FieldRow label="Show value at" htmlFor="projection-horizon" className="w-44">
        <Select value={String(horizon)} onValueChange={(v) => onHorizonChange(Number(v))}>
          <SelectTrigger id="projection-horizon" className="w-full">
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
      </FieldRow>

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

  // Before the first recorded balance every total is a zero that means
  // "unknown"; drawing it would put a cliff in the chart that never happened.
  const points = netWorth.knownFrom
    ? netWorth.totalPoints.filter((p) => p.date >= /** @type {string} */ (netWorth.knownFrom))
    : [];
  const latest = points[points.length - 1] ?? null;
  const oldestAsAt = netWorth.accounts
    .flatMap((a) => (a.points[a.points.length - 1]?.asAt ? [/** @type {string} */ (a.points[a.points.length - 1]?.asAt)] : []))
    .sort()[0];

  const option = useMemo(
    () =>
      /** @param {import("@/components/chart.jsx").ChartTokens} tokens */
      (tokens) => ({
        grid: { top: 16, left: 8, right: 12, bottom: 8, containLabel: true },
        xAxis: {
          type: "category",
          data: points.map((p) => p.date),
          axisLabel: {
            color: tokens.axisLabel,
            /** @param {string} value */
            formatter: (value) => formatIsoDate(value, locale),
          },
        },
        yAxis: { type: "value" },
        tooltip: {
          trigger: "axis",
          /** @param {{ axisValue: string, value: number }[]} params */
          formatter: (params) => {
            const first = params[0];
            if (!first) return "";
            return `${formatIsoDate(first.axisValue, locale)}<br/>${formatMoney(Math.round(first.value * 100), {
              currency,
              locale,
            })}`;
          },
        },
        series: [
          {
            type: "line",
            name: "Net worth",
            data: points.map((p) => p.totalCents / 100),
            // A step, never a slope: between two snapshots the balance is the
            // older one carried forward, and a diagonal would draw a hundred
            // days of movement nobody recorded.
            step: "end",
            showSymbol: points.length < 40,
            lineStyle: { width: 2, color: tokens.series[0] },
            itemStyle: { color: tokens.series[0] },
            areaStyle: { color: tokens.accentSoft, opacity: 0.5 },
          },
        ],
      }),
    [points, currency, locale],
  );

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold text-text">Net worth</h2>
        <Button size="sm" variant="outline" onClick={onUpdateBalance}>
          <BanknoteIcon />
          Update balance
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <StatTile
          label="Now"
          value={
            latest ? (
              <span className="text-2xl sm:text-3xl">
                <Money value={latest.totalCents} />
              </span>
            ) : (
              <span className="text-text-subtle">—</span>
            )
          }
          sparkline={
            <p className="text-xs text-text-muted">
              Excludes external accounts — money sent out isn&apos;t net worth.
            </p>
          }
        />
        <StatTile
          label="Oldest balance"
          value={
            oldestAsAt ? (
              <span className="text-2xl sm:text-3xl">{formatIsoDate(oldestAsAt, locale)}</span>
            ) : (
              <span className="text-text-subtle">—</span>
            )
          }
          sparkline={<p className="text-xs text-text-muted">Balances are carried forward, never interpolated.</p>}
        />
      </div>

      <div className="rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
        <Chart
          option={option}
          loading={loading}
          empty={points.length < 2}
          height={220}
          ariaLabel={`Net worth over ${points.length} recorded dates${latest ? `, currently ${formatMoney(latest.totalCents, { currency, locale })}` : ""}.`}
          dataTable={{
            caption: "Net worth at each recorded date",
            columns: ["Date", "Net worth"],
            rows: points.map((point) => [
              formatIsoDate(point.date, locale),
              formatMoney(point.totalCents, { currency, locale }),
            ]),
          }}
          emptyTitle="Not enough history yet"
          emptyDescription="Record a balance on two different dates to see net worth move."
        />
      </div>
    </section>
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
  const today = useMemo(todayIso, []);
  const [months, setMonths] = useState(/** @type {(typeof HORIZON_OPTIONS)[number]} */ ("60"));
  const [mobileHorizon, setMobileHorizon] = useState(12);
  const [savingId, setSavingId] = useState(/** @type {string | null} */ (null));
  const [balanceOpen, setBalanceOpen] = useState(false);

  const projectionsQuery = useQuery({
    queryKey: ["projections", months],
    queryFn: async () => {
      const res = await api.projections.$get({ query: { months } });
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

  const chartOption = useMemo(
    () =>
      /** @param {import("@/components/chart.jsx").ChartTokens} tokens */
      (tokens) => ({
        legend: { top: 0, type: "scroll", textStyle: { color: tokens.axisLabel }, pageIconColor: tokens.axisLabel },
        grid: { top: 48, left: 8, right: 12, bottom: 8, containLabel: true },
        xAxis: {
          type: "category",
          data: (projections?.totalSeries ?? []).map((p) => p.month),
          axisLabel: {
            color: tokens.axisLabel,
            /** @param {string} value */
            formatter: (value) => (value === "0" ? "now" : `${value}mo`),
          },
        },
        yAxis: { type: "value" },
        tooltip: {
          trigger: "axis",
          /** @param {{ seriesName: string, value: number, axisValue: string }[]} params */
          formatter: (params) => {
            const head = params[0];
            const when = head?.axisValue === "0" ? "Now" : `In ${head?.axisValue} months`;
            return [
              when,
              ...params.map((p) => `${p.seriesName}: ${formatMoney(Math.round(p.value * 100), { currency, locale })}`),
            ].join("<br/>");
          },
        },
        series: [
          ...(projections?.accounts ?? []).map((account, i) => ({
            type: "line",
            name: account.name,
            data: account.series.map((p) => p.projectedCents / 100),
            smooth: true,
            showSymbol: false,
            lineStyle: { width: 2, color: tokens.series[i % tokens.series.length] },
            itemStyle: { color: tokens.series[i % tokens.series.length] },
          })),
          {
            type: "line",
            name: "Household total",
            data: (projections?.totalSeries ?? []).map((p) => p.projectedCents / 100),
            smooth: true,
            showSymbol: false,
            lineStyle: { width: 3, type: "dashed", color: tokens.text },
            itemStyle: { color: tokens.text },
          },
        ],
      }),
    [projections, currency, locale],
  );

  return (
    <>
      <PageHeader
        title="Projections"
        description="Where each account lands at your current contributions and one flat growth rate. A projection, not a promise — nothing here writes anything."
        actions={
          <FieldRow label="Horizon" htmlFor="projection-months" className="w-36">
            <Select
              value={months}
              onValueChange={(v) => setMonths(/** @type {(typeof HORIZON_OPTIONS)[number]} */ (v))}
            >
              <SelectTrigger id="projection-months" className="w-full">
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
          </FieldRow>
        }
      />

      {netWorth ? (
        <NetWorthPanel
          netWorth={netWorth}
          loading={netWorthQuery.isLoading}
          onUpdateBalance={() => setBalanceOpen(true)}
        />
      ) : null}

      {projections?.warnings.length ? (
        <div className="flex flex-col gap-2 rounded-(--radius-card) bg-warning-soft p-4">
          {projections.warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-2 text-sm text-text">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {w.message}
            </p>
          ))}
        </div>
      ) : null}

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-text">Projected balances</h2>
          <p className="flex items-center gap-1.5 text-xs text-text-muted">
            <Tooltip>
              <TooltipTrigger asChild>
                <InfoIcon className="size-3.5 text-text-subtle" aria-label="Which accounts are projected?" />
              </TooltipTrigger>
              <TooltipContent>
                Savings and investment accounts only. A transaction account&apos;s allocation is spent, not
                accumulated, so compounding it would project money you&apos;ve already used.
              </TooltipContent>
            </Tooltip>
            {projections?.allocationPlan
              ? `Contributions from the ${projections.allocationPlan.name} allocation`
              : "No active allocation — contributions read as zero"}
          </p>
        </div>

        {projectionsQuery.isLoading ? null : !projections || projections.accounts.length === 0 ? (
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
                horizon={mobileHorizon}
                onHorizonChange={setMobileHorizon}
                savingId={savingId}
                onSaveRate={(accountId, annualGrowthRate) => saveRate.mutate({ accountId, annualGrowthRate })}
              />
            </div>

            {/* The desktop table above IS the per-account breakdown, but
                it is `hidden` below md and the mobile cards show one horizon
                at a time — so the chart still needs a table of its own for
                the combined total. */}
            <div className="rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
              <Chart
                option={chartOption}
                height={320}
                ariaLabel={`Projected balance per account and in total, over ${projections?.totalSeries.length ?? 0} monthly steps.`}
                dataTable={{
                  caption: "Projected total across all accounts, by month",
                  columns: ["Months from now", "Projected total"],
                  rows: (projections?.totalSeries ?? []).map((point) => [
                    point.month === 0 ? "now" : `${point.month}`,
                    formatMoney(point.projectedCents, { currency, locale }),
                  ]),
                }}
              />
            </div>

            <p className="text-xs text-text-subtle">
              Growth rates are annual and compounded monthly by the engine — enter 5.03, not 0.0041. One flat rate per
              account: no scenarios, no market modelling.
            </p>
          </>
        )}
      </section>

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
