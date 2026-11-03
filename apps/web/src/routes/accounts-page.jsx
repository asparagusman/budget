import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BanknoteIcon, CheckCircle2Icon, ClockIcon, LandmarkIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.jsx";
import { Switch } from "@/components/ui/switch.jsx";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  AXIS,
  Chart,
  ChartTooltip,
  MoneyTooltip,
  PROJECTED,
  TOTAL,
  useChartMotion,
  useMoneyTick,
} from "@/components/chart.jsx";
import { QuickBalanceSheet } from "@/components/quick-balance-sheet.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { ListSkeleton, StatsSkeleton } from "@/components/loading.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { ReorderControls } from "@/components/reorder-controls.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { PercentInput } from "@/components/money-input.jsx";
import { Money } from "@/components/money.jsx";
import { InlineError } from "@/components/notice.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { QueryError } from "@/components/query-error.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { Stat, StatGroup } from "@/components/stat-tile.jsx";
import { api } from "@/lib/api.js";
import { accountsQueryOptions, goalsQueryOptions } from "@/lib/queries.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { moveWithinGroup } from "@/lib/reorder.js";
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPES, CADENCE_PERIOD_NOUNS } from "@/lib/constants.js";
import { daysSinceIso, formatIsoDate, todayIso } from "@/lib/dates.js";
import { colorFor, entityColors } from "@/lib/entity-colors.js";
import { formatMoney } from "@/lib/format-money.js";
import { roundTo } from "@/lib/numeric-text.js";
import { useSettings } from "@/lib/settings.jsx";
import { ScrollArea } from "@/components/scroll-area.jsx";

/** @import { Cents } from "@budget/engine" */
/** @typedef {{ amountCents: Cents, asAt: string }} LatestBalance */
/** @typedef {{ id: string, name: string, type: (typeof ACCOUNT_TYPES)[number], institution: string | null, isIncomeLanding: boolean, annualGrowthRate: number | null, sortOrder: number, latestBalance: LatestBalance | null }} Account */
/** @typedef {{ name: string, type: (typeof ACCOUNT_TYPES)[number], institution: string | null, isIncomeLanding: boolean, annualGrowthRate: number | null }} AccountFormData */

// An account with a balance older than this is flagged rather than trusted
// (phases/04-accounts-people.md "/accounts" header stat tile).
const STALE_DAYS = 30;

/**
 * Add/edit form. `external` accounts hide the growth-rate field entirely —
 * the API rejects a non-null rate for them anyway, but hiding it here means
 * the operator never has to learn that rule from an error message.
 *
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   account: Account | null,
 *   submitting: boolean,
 *   onSubmit: (data: AccountFormData) => Promise<void>,
 * }} props
 */
function AccountFormDialog({ open, onOpenChange, account, submitting, onSubmit }) {
  const [name, setName] = useState("");
  const [type, setType] = useState(/** @type {(typeof ACCOUNT_TYPES)[number]} */ ("transaction"));
  const [institution, setInstitution] = useState("");
  const [isIncomeLanding, setIsIncomeLanding] = useState(false);
  const [growthRatePct, setGrowthRatePct] = useState(/** @type {number | null} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setName(account?.name ?? "");
    setType(account?.type ?? "transaction");
    setInstitution(account?.institution ?? "");
    setIsIncomeLanding(account?.isIncomeLanding ?? false);
    setGrowthRatePct(account?.annualGrowthRate != null ? roundTo(account.annualGrowthRate * 100, 4) : null);
    setError(null);
  }, [open, account]);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Enter a name.");
      return;
    }
    const data = {
      name: name.trim(),
      type,
      institution: institution.trim() || null,
      isIncomeLanding,
      annualGrowthRate: type === "external" || growthRatePct === null ? null : roundTo(growthRatePct / 100, 6),
    };
    try {
      await onSubmit(data);
      onOpenChange(false);
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account ? "Edit account" : "Add account"}</DialogTitle>
          <DialogDescription>
            {account
              ? "Update this account's details."
              : "A new place money can be sent, tracked as an asset, or projected."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FieldRow label="Name" htmlFor="account-name" required>
            <Input id="account-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </FieldRow>
          <FieldRow label="Type" htmlFor="account-type">
            <Select
              value={type}
              onValueChange={(value) => {
                setType(/** @type {(typeof ACCOUNT_TYPES)[number]} */ (value));
                if (value === "external") setGrowthRatePct(null);
              }}
            >
              <SelectTrigger id="account-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCOUNT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {ACCOUNT_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Institution" htmlFor="account-institution" hint="Optional — e.g. ubank, Up, Raiz.">
            <Input
              id="account-institution"
              value={institution}
              onChange={(e) => setInstitution(e.target.value)}
            />
          </FieldRow>
          {type !== "external" ? (
            <FieldRow
              label="Growth rate"
              htmlFor="account-growth"
              hint="Annual, as a percentage. Leave blank for none — phase 09 uses this for projections."
            >
              <PercentInput id="account-growth" decimals={4} unit="% p.a." value={growthRatePct} onChange={setGrowthRatePct} />
            </FieldRow>
          ) : null}
          <FieldRow
            label="Income-landing account"
            htmlFor="account-income-landing"
            hint="The one account salary lands in and fixed bills are debited from. Only one may be set."
          >
            <Switch id="account-income-landing" checked={isIncomeLanding} onCheckedChange={setIsIncomeLanding} />
          </FieldRow>
          {error ? <InlineError>{error}</InlineError> : null}
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * An account's goals, as reported by /goals — progress and ETA, and nothing
 * that writes. Phase 09 adds this to the account detail alongside the balance
 * history that was already here (phases/09-goals-projections.md "Account
 * detail").
 *
 * @param {{ accountId: string }} props
 */
function AccountGoalsPanel({ accountId }) {
  const navigate = useNavigate();
  const { locale } = useSettings();
  const today = useMemo(todayIso, []);
  const goalsQuery = useQuery(
    // The same query /goals uses, so the two share one cache entry instead
    // of each downloading every goal's curve (perf-inp-plan.md, P2 #9).
    goalsQueryOptions(today),
  );

  const own = (goalsQuery.data?.goals ?? []).filter((g) => g.goal.accountId === accountId);
  const payCadence = goalsQuery.data?.summary.payCadence ?? "monthly";

  if (goalsQuery.isLoading) return <ListSkeleton rows={2} label="Loading this account's goals" />;
  if (goalsQuery.error) {
    return <QueryError compact error={goalsQuery.error} what="this account's goals" onRetry={() => goalsQuery.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-text">Goals</h4>
        <Button size="sm" variant="ghost" onClick={() => navigate({ to: "/goals" })}>
          Open Goals
        </Button>
      </div>
      {own.length === 0 ? (
        <p className="text-sm text-text-muted">No goal points at this account yet.</p>
      ) : (
        <DataList>
          {own.map((g) => (
            <DataListRow
              key={g.goal.id}
              primary={
                <span className="flex items-center gap-2">
                  {g.goal.name}
                  {g.isFunded ? null : <Badge variant="attention">not currently funded</Badge>}
                </span>
              }
              secondary={
                <>
                  {/* A months-of-expenses goal has no target until some
                      essential cost is recorded; its `targetCents` is a
                      placeholder 0, and "$1,200 of $0 · 0%" said nothing
                      true. */}
                  {g.targetComputable ? (
                    <>
                      <Money value={g.currentBalanceCents} /> of <Money value={g.targetCents} /> ·{" "}
                      {g.progressPct.toFixed(1)}%
                    </>
                  ) : (
                    <>
                      <Money value={g.currentBalanceCents} /> saved
                    </>
                  )}
                  {g.isFunded ? (
                    <>
                      {" · "}
                      <Money value={g.contributionPerPayCents} /> per {CADENCE_PERIOD_NOUNS[payCadence][0]}
                    </>
                  ) : null}
                </>
              }
              trailing={
                !g.targetComputable ? (
                  <Badge variant="attention">Needs costs recorded</Badge>
                ) : g.reached ? (
                  <span className="inline-flex items-center gap-1">
                    <CheckCircle2Icon className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
                    Reached
                  </span>
                ) : g.eta.date ? (
                  formatIsoDate(g.eta.date, locale)
                ) : (
                  <span className="text-text-subtle">—</span>
                )
              }
            />
          ))}
        </DataList>
      )}
    </div>
  );
}

/**
 * Where this account lands at the current contribution and growth rate. Shares
 * /projections' cached response with the Projections screen rather than asking
 * for its own — the figures must agree, and the cheapest way to guarantee that
 * is to read the same ones.
 *
 * @param {{ accountId: string, accountType: string, color: string }} props `color` is this account's entity colour.
 */
function AccountProjectionPanel({ accountId, accountType, color }) {
  const { currency, locale } = useSettings();
  const moneyTick = useMoneyTick();
  const motion = useChartMotion();
  const today = useMemo(todayIso, []);
  const projectionsQuery = useQuery({
    queryKey: ["projections", "60"],
    queryFn: async () => {
      // `on`: the browser's calendar day, not the server's (see the goals
      // panel above).
      const res = await api.projections.$get({ query: { months: "60", on: today } });
      if (!res.ok) throw new Error(await readApiError(res));
      return await res.json();
    },
    enabled: accountType === "savings" || accountType === "investment",
  });

  const projected = (projectionsQuery.data?.accounts ?? []).find((a) => a.id === accountId) ?? null;

  // One row per point, with the x-axis label precomputed as a STRING. The
  // tooltip's title is the category value it is given, so a numeric x leaves
  // it with nothing to show; a string label is both the axis tick and the
  // tooltip heading, with no formatter at either end.
  //
  // Memoised — and so above the early return — because the sheet re-renders
  // as each of its queries lands during the slide-in, and a new array
  // restarts the chart's animation each time (perf-inp-plan.md, P1.5).
  const projectionRows = useMemo(
    () =>
      (projected?.series ?? []).map((point) => ({
        label: point.month === 0 ? "now" : `${point.month}mo`,
        projected: point.projectedCents / 100,
      })),
    [projected],
  );

  if (accountType !== "savings" && accountType !== "investment") {
    return (
      <p className="text-sm text-text-muted">
        {accountType === "external"
          ? "External accounts aren't projected — they hold no balance."
          : "Transaction accounts aren't projected: what lands here is spent, not accumulated."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-text">Projection</h4>
        {projected ? (
          <p className="text-xs text-text-muted">
            {(projected.annualGrowthRate * 100).toFixed(2)}% p.a. ·{" "}
            <Money value={projected.contributionPerMonthCents} />
            /month in
          </p>
        ) : null}
      </div>
      {/* Nothing else on this panel lists the projected figures, so the
          table view is the only non-visual way to read them. A failed load
          is said as one — the empty state would claim there is nothing to
          project. */}
      {projectionsQuery.error ? (
        <QueryError
          compact
          error={projectionsQuery.error}
          what="this account's projection"
          onRetry={() => projectionsQuery.refetch()}
        />
      ) : (
        <Chart
          loading={projectionsQuery.isLoading}
          empty={!projected}
          emptyTitle="Nothing to project"
          emptyDescription="Record a balance, or fund this account from an allocation line."
          height={200}
          ariaLabel={
            projected
              ? `Projected balance over ${projected.series.length ? `${projected.series[projected.series.length - 1]?.month ?? 0} months` : "time"}, from ${formatMoney(projected.series[0]?.projectedCents ?? 0, { currency, locale })} to ${formatMoney(projected.series[projected.series.length - 1]?.projectedCents ?? 0, { currency, locale })}.`
              : "Projected balance over time."
          }
          dataTable={
            projected
              ? () => ({
                  caption: "Projected balance by month",
                  columns: ["Months from now", "Projected balance"],
                  rows: projected.series.map((point) => [
                    point.month === 0 ? "now" : `${point.month}`,
                    formatMoney(point.projectedCents, { currency, locale }),
                  ]),
                })
              : null
          }
          config={{ projected: { label: "Projected", color } }}
        >
          <AreaChart data={projectionRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" {...AXIS} minTickGap={24} />
            <YAxis {...AXIS} width={56} tickFormatter={moneyTick} />
            <ChartTooltip content={<MoneyTooltip />} />
            <Area
              dataKey="projected"
              type="monotone"
              stroke="var(--color-projected)"
              fill="var(--color-projected)"
              {...PROJECTED}
              strokeWidth={2}
              dot={false}
              {...motion}
            />
          </AreaChart>
        </Chart>
      )}
    </div>
  );
}

/**
 * Balance history table plus a line chart of balance over time
 * (phases/04-accounts-people.md "/accounts" per-account detail).
 *
 * Edit and Archive are here as well as on the desktop table's row: on a
 * phone this sheet is the only place an account is reached, and without them
 * an account could not be renamed, moved to income-landing, or archived from
 * a phone at all.
 *
 * @param {{
 *   account: Account | null,
 *   accountColors: Map<string, string>,
 *   onOpenChange: (open: boolean) => void,
 *   onQuickUpdate: () => void,
 *   onEdit: () => void,
 *   onArchive: () => void,
 *   reorder?: import("react").ReactNode,
 * }} props
 *   `accountColors` is `entityColors()` over every account on the page, so
 *   this account's charts wear the colour it has everywhere else.
 */
function AccountDetailSheet({ account, accountColors, onOpenChange, onQuickUpdate, onEdit, onArchive, reorder }) {
  const color = account ? colorFor(accountColors, account.id) : TOTAL;
  const { currency, locale } = useSettings();
  const moneyTick = useMoneyTick();
  const motion = useChartMotion();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const balancesQuery = useQuery({
    queryKey: ["account-balances", account?.id],
    queryFn: async () => {
      if (!account) throw new Error("No account is open.");
      const res = await api.accounts[":id"].balances.$get({ param: { id: account.id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).balances;
    },
    enabled: account !== null,
  });

  const deleteMutation = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api.balances[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => invalidateAccountFigures(queryClient),
    onError: (err) => toast.error(err.message),
  });

  const balances = balancesQuery.data ?? [];
  // Memoised on the query's data: three queries land during the sheet's
  // slide-in, and a fresh row array each time restarted the chart's
  // animation on every one of them (perf-inp-plan.md, P1.5).
  const ascending = useMemo(() => [...(balancesQuery.data ?? [])].reverse(), [balancesQuery.data]);
  const balanceRows = useMemo(
    () =>
      ascending.map((b) => ({
        label: formatIsoDate(b.asAt, locale),
        balance: b.amountCents / 100,
      })),
    [ascending, locale],
  );

  return (
    <Sheet open={account !== null} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" scrollable className="max-h-[85vh]">
        <SheetHeader>
          <SheetTitle>{account?.name}</SheetTitle>
          <SheetDescription>
            {account ? `${ACCOUNT_TYPE_LABELS[account.type]} · goals, history and projection` : null}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={onQuickUpdate}>
                Update balance
              </Button>
              <Button variant="ghost" onClick={onEdit}>
                <PencilIcon />
                Edit account
              </Button>
            </div>
            {/* Desktop has these in the table row; a phone's row is kept for
                the balance, so the order is set from here instead. */}
            {reorder ? (
              <div className="flex items-center gap-1 text-xs text-text-muted md:hidden">
                Order
                {reorder}
              </div>
            ) : null}
          </div>

          {balancesQuery.error ? (
            <QueryError
              compact
              error={balancesQuery.error}
              what="this account's balances"
              onRetry={() => balancesQuery.refetch()}
            />
          ) : (
            // No data table here: every point on this line is already listed
            // as a row in the balance <DataList> further down the sheet.
            <Chart
              loading={balancesQuery.isLoading}
              empty={ascending.length === 0}
              emptyTitle="No balances yet"
              emptyDescription="Add the first balance to start tracking this account over time."
              height={220}
              ariaLabel={`Balance over time for ${account?.name ?? "this account"}, ${ascending.length} recorded points. Every figure is listed in the balance history below.`}
              config={{ balance: { label: "Balance", color } }}
            >
              <AreaChart data={balanceRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" {...AXIS} minTickGap={24} />
                <YAxis {...AXIS} width={56} tickFormatter={moneyTick} />
                <ChartTooltip content={<MoneyTooltip />} />
                <Area
                  dataKey="balance"
                  type="monotone"
                  stroke="var(--color-balance)"
                  fill="var(--color-balance)"
                  fillOpacity={0.15}
                  strokeWidth={2}
                  dot={ascending.length < 30}
                  {...motion}
                />
              </AreaChart>
            </Chart>
          )}

          {account ? <AccountGoalsPanel accountId={account.id} /> : null}
          {account ? <AccountProjectionPanel accountId={account.id} accountType={account.type} color={color} /> : null}

          {balances.length > 0 ? (
            <DataList>
              {balances.map((b) => (
                <DataListRow
                  key={b.id}
                  primary={<Money value={b.amountCents} />}
                  secondary={`${formatIsoDate(b.asAt, locale)}${b.note ? ` · ${b.note}` : ""}`}
                  trailing={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-text-muted hover:text-text"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Delete this balance?",
                          description: `${formatMoney(b.amountCents, { currency, locale })} recorded ${formatIsoDate(b.asAt, locale)}. Deleting it changes every projection computed from this account's history.`,
                          confirmLabel: "Delete",
                        });
                        if (ok) deleteMutation.mutate(b.id);
                      }}
                      aria-label="Delete balance"
                    >
                      <Trash2Icon />
                    </Button>
                  }
                />
              ))}
            </DataList>
          ) : null}

          {/* Last, under a rule — the same place the bill sheet keeps its
              Archive, and grey: archiving is not money out. */}
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button variant="ghost" className="text-text-muted hover:text-text" onClick={onArchive}>
              <Trash2Icon />
              Archive account
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Everything an account's balance (or growth rate, or existence) feeds,
 * refetched after a balance is recorded or deleted or an account changes —
 * the same keys the dashboard's quick-balance sheet invalidates. The account
 * sheet's Goals and Projection panels read `goals` and `projections`, and
 * used to keep showing the figures from before the edit.
 *
 * @param {import("@tanstack/react-query").QueryClient} queryClient
 */
function invalidateAccountFigures(queryClient) {
  for (const queryKey of [["accounts"], ["account-balances"], ["goals"], ["projections"], ["net-worth"], ["dashboard"]]) {
    queryClient.invalidateQueries({ queryKey });
  }
}

/**
 * Grouped by type, transaction → savings → investment → external
 * (phases/04-accounts-people.md "/accounts"). Desktop renders a table per
 * group; mobile renders a <DataList> with a one-tap "Update" action, since
 * quick balance entry is the single most frequent write in the app.
 */
export function AccountsPage() {
  const { locale } = useSettings();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [formOpen, setFormOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState(/** @type {Account | null} */ (null));
  // The id, looked up in the live list each render: a stored copy kept the
  // sheet showing the old name after an edit made from inside it.
  const [detailAccountId, setDetailAccountId] = useState(/** @type {string | null} */ (null));
  const [quickUpdate, setQuickUpdate] = useState(/** @type {{ accountId: string | null } | null} */ (null));

  const accountsQuery = useQuery(accountsQueryOptions());

  const accounts = accountsQuery.data ?? [];
  // An archived account drops out of the list, which closes its sheet.
  const detailAccount = detailAccountId ? (accounts.find((a) => a.id === detailAccountId) ?? null) : null;
  const accountColors = useMemo(
    () => entityColors((accountsQuery.data ?? []).map((a) => a.id)),
    [accountsQuery.data],
  );

  const createMutation = useMutation({
    mutationFn: async (/** @type {AccountFormData} */ data) => {
      const res = await api.accounts.$post({ json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("Account added.");
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (/** @type {{ id: string, data: AccountFormData }} */ { id, data }) => {
      const res = await api.accounts[":id"].$patch({ param: { id }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      // A growth rate or income-landing change moves projections and goals
      // too, not only this list.
      invalidateAccountFigures(queryClient);
      toast.success("Account updated.");
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api.accounts[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateAccountFigures(queryClient);
      toast.success("Account archived.");
    },
    onError: (err) => toast.error(err.message),
  });

  /** @param {Account} account */
  async function confirmArchive(account) {
    const ok = await confirm({
      title: `Archive ${account.name}?`,
      description: "It stops appearing in lists and allocation destinations. Its balance history is kept.",
      confirmLabel: "Archive",
    });
    if (ok) archiveMutation.mutate(account.id);
  }

  /** @param {Account} account */
  function openEdit(account) {
    setEditingAccount(account);
    setFormOpen(true);
  }

  // Accounts have been ordered by `sortOrder` since phase 04 with no way to
  // set it (todo.md `[P04-12]`), so every row sat at the column default and
  // the list was in insertion order. The move is made within the group the
  // operator can see; `moveWithinGroup` turns that into the whole list's new
  // order, which is what the endpoint renumbers from.
  const reorderMutation = useMutation({
    mutationFn: async (/** @type {string[]} */ ids) => {
      const res = await api.accounts.reorder.$post({ json: { ids } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["accounts"] }),
    onError: (err) => toast.error(err.message),
  });

  /**
   * @param {Account[]} groupItems
   * @param {number} index
   * @param {-1 | 1} direction
   */
  function moveAccount(groupItems, index, direction) {
    const next = moveWithinGroup(accounts, groupItems, index, direction);
    if (next) reorderMutation.mutate(next.map((a) => a.id));
  }

  const upsertBalanceMutation = useMutation({
    mutationFn: async (/** @type {{ accountId: string, data: { asAt: string, amountCents: number } }} */ { accountId, data }) => {
      const res = await api.accounts[":id"].balances.$post({ param: { id: accountId }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateAccountFigures(queryClient);
      toast.success("Balance updated.");
    },
  });

  // Registered while this page is mounted, same pattern every feature page
  // uses (see lib/commands.js) — the setters below are stable, so this only
  // needs to run once.
  useEffect(
    () =>
      registerCommands([
        {
          id: "accounts:add",
          group: "Actions",
          label: "Add account",
          icon: PlusIcon,
          run: () => {
            setEditingAccount(null);
            setFormOpen(true);
          },
        },
        {
          id: "accounts:update-balance",
          group: "Actions",
          label: "Update balance",
          icon: BanknoteIcon,
          run: () => setQuickUpdate({ accountId: null }),
        },
      ]),
    [],
  );

  const netWorthCents = accounts
    .filter((a) => a.type !== "external" && a.latestBalance)
    .reduce((sum, a) => sum + (a.latestBalance?.amountCents ?? 0), 0);
  const staleCount = accounts.filter(
    (a) => a.latestBalance && daysSinceIso(a.latestBalance.asAt) > STALE_DAYS,
  ).length;

  const groups = ACCOUNT_TYPES.map((type) => ({ type, items: accounts.filter((a) => a.type === type) })).filter(
    (g) => g.items.length > 0,
  );

  // The open sheet's account, found afresh in the current list so its arrows
  // follow it as it moves.
  const detailGroup = detailAccount ? groups.find((g) => g.items.some((a) => a.id === detailAccount.id)) : undefined;
  const detailIndex = detailGroup && detailAccount ? detailGroup.items.findIndex((a) => a.id === detailAccount.id) : -1;
  const detailReorder =
    detailGroup && detailAccount && detailIndex >= 0 ? (
      <ReorderControls
        index={detailIndex}
        count={detailGroup.items.length}
        label={detailAccount.name}
        disabled={reorderMutation.isPending}
        onMove={(direction) => moveAccount(detailGroup.items, detailIndex, direction)}
      />
    ) : null;

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Every place money can be sent, held as an asset, or grown."
        actions={
          <Button
            onClick={() => {
              setEditingAccount(null);
              setFormOpen(true);
            }}
          >
            <PlusIcon />
            Add account
          </Button>
        }
      />

      {accounts.length > 0 ? (
        <StatGroup aria-label="Accounts summary">
          {/* compact — a full-precision "$68,975.88" headline overflows its
              half-width cell at 375px and collides with the one next to it;
              every account's exact balance is still one row below. */}
          <Stat label="Net worth" value={<Money value={netWorthCents} compact />} />
          <Stat label="Stale balances" value={staleCount} tone={staleCount > 0 ? "attention" : "default"} />
        </StatGroup>
      ) : accountsQuery.isLoading ? (
        <StatsSkeleton labels={["Net worth", "Stale balances"]} hints={false} label="Loading the accounts summary" />
      ) : null}

      {accountsQuery.isLoading ? (
        <ListSkeleton rows={5} label="Loading accounts" />
      ) : accountsQuery.error ? (
        <QueryError error={accountsQuery.error} what="your accounts" onRetry={() => accountsQuery.refetch()} />
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={LandmarkIcon}
          title="No accounts yet"
          description="Add the accounts salary lands in, bills come out of, and savings live in — everything else in the app hangs off these."
          action={
            // Clears the edit target: after archiving the last account from
            // its own form, this opened an edit of the archived record.
            <Button
              onClick={() => {
                setEditingAccount(null);
                setFormOpen(true);
              }}
            >
              <PlusIcon />
              Add account
            </Button>
          }
        />
      ) : (
        // The account types are parts of one list, so they sit closer to each
        // other than the page's own blocks do.
        <div className="flex flex-col gap-5 md:gap-6">
          {groups.map((group) => (
            <div key={group.type} className="flex flex-col gap-2">
              <h2 className="px-1 text-sm font-semibold text-text-muted">{ACCOUNT_TYPE_LABELS[group.type]}</h2>

              <ScrollArea axis="x" className="hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card) md:block">
                {/* Fixed column shares, so Balance and As at line up from one
                    account type's table to the next instead of each table
                    sizing itself to its own longest name. */}
                <table className="w-full min-w-184 table-fixed text-sm">
                  <colgroup>
                    <col style={{ width: "28%" }} />
                    <col style={{ width: "12%" }} />
                    <col style={{ width: "14%" }} />
                    <col style={{ width: "13%" }} />
                    <col style={{ width: "9%" }} />
                    <col style={{ width: "24%" }} />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-text-muted">
                      <th className="px-4 py-3 font-medium">Name</th>
                      <th className="px-4 py-3 font-medium">Institution</th>
                      <th className="px-4 py-3 text-right font-medium">Balance</th>
                      <th className="px-4 py-3 font-medium">As at</th>
                      <th className="px-4 py-3 text-right font-medium">Growth</th>
                      <th className="px-4 py-3 font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {group.items.map((account, index) => (
                      <tr key={account.id}>
                        <td className="px-4 py-3 text-text">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <button
                              type="button"
                              className="text-left hover:underline"
                              onClick={() => setDetailAccountId(account.id)}
                            >
                              {account.name}
                            </button>
                            {account.isIncomeLanding ? <Badge variant="secondary">Income landing</Badge> : null}
                          </span>
                        </td>
                        <td className="truncate px-4 py-3 text-text-muted">{account.institution ?? "—"}</td>
                        <td className="px-4 py-3 text-right text-text tabular-nums">
                          {account.latestBalance ? <Money value={account.latestBalance.amountCents} /> : "—"}
                        </td>
                        <td className="px-4 py-3 text-text-muted">
                          {account.latestBalance ? (
                            <span
                              className={
                                daysSinceIso(account.latestBalance.asAt) > STALE_DAYS ? "text-warning-strong" : undefined
                              }
                            >
                              {daysSinceIso(account.latestBalance.asAt) > STALE_DAYS ? (
                                <ClockIcon className="mr-1 inline size-3.5" aria-hidden="true" />
                              ) : null}
                              {formatIsoDate(account.latestBalance.asAt, locale)}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-3 text-right text-text-muted tabular-nums">
                          {account.annualGrowthRate != null ? `${(account.annualGrowthRate * 100).toFixed(2)}%` : "—"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-1">
                            <ReorderControls
                              index={index}
                              count={group.items.length}
                              label={account.name}
                              disabled={reorderMutation.isPending}
                              onMove={(direction) => moveAccount(group.items, index, direction)}
                            />
                            <Button size="sm" variant="outline" onClick={() => setQuickUpdate({ accountId: account.id })}>
                              Update balance
                            </Button>
                            <Button size="icon-sm" variant="ghost" aria-label="Edit account" onClick={() => openEdit(account)}>
                              <PencilIcon />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              className="text-text-muted hover:text-text"
                              aria-label="Archive account"
                              onClick={() => confirmArchive(account)}
                            >
                              <Trash2Icon />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollArea>

              {/* Phone: one tap target per account — name, where it's held
                  and how fresh the figure is on the left, the balance on the
                  right — with Update beside it, because refreshing a balance is
                  the thing a phone visit is usually for. The balance was not
                  on a phone at all before: the trailing slot went to the
                  reorder arrows, which now live in the account's sheet (an
                  order is set once, a balance every week). */}
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card) md:hidden">
                {group.items.map((account) => {
                  const stale = account.latestBalance ? daysSinceIso(account.latestBalance.asAt) > STALE_DAYS : false;
                  return (
                    <li key={account.id} className="flex items-stretch">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center justify-between gap-3 py-2.5 pr-2 pl-4 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)"
                        onClick={() => setDetailAccountId(account.id)}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-text">{account.name}</span>
                          <span className="block truncate text-xs text-text-muted">
                            {account.institution ?? "No institution"}
                            {" · "}
                            {account.latestBalance ? (
                              <span className={stale ? "text-warning-strong" : undefined}>
                                {stale ? <ClockIcon className="mr-1 inline size-3.5" aria-hidden="true" /> : null}
                                {formatIsoDate(account.latestBalance.asAt, locale)}
                              </span>
                            ) : (
                              "no balance yet"
                            )}
                          </span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold text-text tabular-nums">
                          {account.latestBalance ? <Money value={account.latestBalance.amountCents} /> : "—"}
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center pr-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-accent-brand"
                          aria-label={`Update ${account.name} balance`}
                          onClick={() => setQuickUpdate({ accountId: account.id })}
                        >
                          Update
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      <AccountFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        account={editingAccount}
        submitting={createMutation.isPending || updateMutation.isPending}
        onSubmit={async (data) => {
          if (editingAccount) {
            await updateMutation.mutateAsync({ id: editingAccount.id, data });
          } else {
            await createMutation.mutateAsync(data);
          }
        }}
      />

      <QuickBalanceSheet
        open={quickUpdate !== null}
        onOpenChange={(open) => !open && setQuickUpdate(null)}
        accounts={accounts}
        accountId={quickUpdate?.accountId ?? null}
        submitting={upsertBalanceMutation.isPending}
        onSubmit={async (accountId, data) => {
          await upsertBalanceMutation.mutateAsync({ accountId, data });
        }}
      />

      <AccountDetailSheet
        account={detailAccount}
        accountColors={accountColors}
        onOpenChange={(open) => !open && setDetailAccountId(null)}
        onQuickUpdate={() => detailAccount && setQuickUpdate({ accountId: detailAccount.id })}
        onEdit={() => detailAccount && openEdit(detailAccount)}
        onArchive={() => detailAccount && confirmArchive(detailAccount)}
        reorder={detailReorder}
      />
    </>
  );
}
