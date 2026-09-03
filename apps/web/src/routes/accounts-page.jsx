import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BanknoteIcon, LandmarkIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.jsx";
import { Switch } from "@/components/ui/switch.jsx";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  AXIS,
  Chart,
  ChartTooltip,
  MoneyTooltip,
  SERIES,
  useChartMotion,
  useMoneyTick,
} from "@/components/chart.jsx";
import { QuickBalanceSheet } from "@/components/quick-balance-sheet.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { ListSkeleton } from "@/components/loading.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { ReorderControls } from "@/components/reorder-controls.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { Money } from "@/components/money.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { StatTile } from "@/components/stat-tile.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { moveWithinGroup } from "@/lib/reorder.js";
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPES, CADENCE_PERIOD_NOUNS } from "@/lib/constants.js";
import { daysSinceIso, formatIsoDate } from "@/lib/dates.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";

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
  const [growthRatePct, setGrowthRatePct] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setName(account?.name ?? "");
    setType(account?.type ?? "transaction");
    setInstitution(account?.institution ?? "");
    setIsIncomeLanding(account?.isIncomeLanding ?? false);
    setGrowthRatePct(account?.annualGrowthRate != null ? String(account.annualGrowthRate * 100) : "");
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
      annualGrowthRate: type === "external" || growthRatePct.trim() === "" ? null : Number(growthRatePct) / 100,
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
                if (value === "external") setGrowthRatePct("");
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
              <InputGroup>
                <InputGroupInput
                  id="account-growth"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={growthRatePct}
                  onChange={(e) => setGrowthRatePct(e.target.value)}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>% p.a.</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </FieldRow>
          ) : null}
          <FieldRow
            label="Income-landing account"
            htmlFor="account-income-landing"
            hint="The one account salary lands in and fixed bills are debited from. Only one may be set."
          >
            <Switch id="account-income-landing" checked={isIncomeLanding} onCheckedChange={setIsIncomeLanding} />
          </FieldRow>
          {error ? <p className="text-sm text-negative">{error}</p> : null}
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
  const goalsQuery = useQuery({
    queryKey: ["goals"],
    queryFn: async () => {
      const res = await api.goals.$get({ query: {} });
      if (!res.ok) throw new Error(await readApiError(res));
      return await res.json();
    },
  });

  const own = (goalsQuery.data?.goals ?? []).filter((g) => g.goal.accountId === accountId);
  const payCadence = goalsQuery.data?.summary.payCadence ?? "monthly";

  if (goalsQuery.isLoading) return null;

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
                  {g.isFunded ? null : <Badge variant="outline">not currently funded</Badge>}
                </span>
              }
              secondary={
                <>
                  <Money value={g.currentBalanceCents} /> of <Money value={g.targetCents} /> ·{" "}
                  {g.progressPct.toFixed(1)}%
                  {g.isFunded ? (
                    <>
                      {" · "}
                      <Money value={g.contributionPerPayCents} /> per {CADENCE_PERIOD_NOUNS[payCadence][0]}
                    </>
                  ) : null}
                </>
              }
              trailing={
                g.reached ? (
                  <span className="text-positive">Reached</span>
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
 * @param {{ accountId: string, accountType: string }} props
 */
function AccountProjectionPanel({ accountId, accountType }) {
  const { currency, locale } = useSettings();
  const moneyTick = useMoneyTick();
  const motion = useChartMotion();
  const projectionsQuery = useQuery({
    queryKey: ["projections", "60"],
    queryFn: async () => {
      const res = await api.projections.$get({ query: { months: "60" } });
      if (!res.ok) throw new Error(await readApiError(res));
      return await res.json();
    },
    enabled: accountType === "savings" || accountType === "investment",
  });

  if (accountType !== "savings" && accountType !== "investment") {
    return (
      <p className="text-sm text-text-muted">
        {accountType === "external"
          ? "External accounts aren't projected — they hold no balance."
          : "Transaction accounts aren't projected: what lands here is spent, not accumulated."}
      </p>
    );
  }

  const projected = (projectionsQuery.data?.accounts ?? []).find((a) => a.id === accountId) ?? null;

  // One row per point, with the x-axis label precomputed as a STRING. The
  // tooltip's title is the category value it is given, so a numeric x leaves
  // it with nothing to show; a string label is both the axis tick and the
  // tooltip heading, with no formatter at either end.
  const projectionRows = (projected?.series ?? []).map((point) => ({
    label: point.month === 0 ? "now" : `${point.month}mo`,
    projected: point.projectedCents / 100,
  }));

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
          table view is the only non-visual way to read them. */}
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
            ? {
                caption: "Projected balance by month",
                columns: ["Months from now", "Projected balance"],
                rows: projected.series.map((point) => [
                  point.month === 0 ? "now" : `${point.month}`,
                  formatMoney(point.projectedCents, { currency, locale }),
                ]),
              }
            : null
        }
        config={{ projected: { label: "Projected", color: SERIES[1] } }}
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
            fillOpacity={0.15}
            strokeWidth={2}
            dot={false}
            {...motion}
          />
        </AreaChart>
      </Chart>
    </div>
  );
}

/**
 * Balance history table plus a line chart of balance over time
 * (phases/04-accounts-people.md "/accounts" per-account detail).
 *
 * @param {{ account: Account | null, onOpenChange: (open: boolean) => void, onQuickUpdate: () => void }} props
 */
function AccountDetailSheet({ account, onOpenChange, onQuickUpdate }) {
  const { currency, locale } = useSettings();
  const moneyTick = useMoneyTick();
  const motion = useChartMotion();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const balancesQuery = useQuery({
    queryKey: ["account-balances", account?.id],
    queryFn: async () => {
      const res = await api.accounts[":id"].balances.$get({ param: { id: /** @type {string} */ (account?.id) } });
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["account-balances", account?.id] });
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const balances = balancesQuery.data ?? [];
  const ascending = [...balances].reverse();
  const balanceRows = ascending.map((b) => ({
    label: formatIsoDate(b.asAt, locale),
    balance: b.amountCents / 100,
  }));

  return (
    <Sheet open={account !== null} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{account?.name}</SheetTitle>
          <SheetDescription>
            {account ? `${ACCOUNT_TYPE_LABELS[account.type]} · goals, history and projection` : null}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">
          <Button variant="outline" className="self-start" onClick={onQuickUpdate}>
            Update balance
          </Button>

          {/* No data table here: every point on this line is already listed
              as a row in the balance <DataList> further down the sheet. */}
          <Chart
            loading={balancesQuery.isLoading}
            empty={ascending.length === 0}
            emptyTitle="No balances yet"
            emptyDescription="Add the first balance to start tracking this account over time."
            height={220}
            ariaLabel={`Balance over time for ${account?.name ?? "this account"}, ${ascending.length} recorded points. Every figure is listed in the balance history below.`}
            config={{ balance: { label: "Balance", color: SERIES[0] } }}
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

          {account ? <AccountGoalsPanel accountId={account.id} /> : null}
          {account ? <AccountProjectionPanel accountId={account.id} accountType={account.type} /> : null}

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
                      className="text-negative"
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
        </div>
      </SheetContent>
    </Sheet>
  );
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
  const [detailAccount, setDetailAccount] = useState(/** @type {Account | null} */ (null));
  const [quickUpdate, setQuickUpdate] = useState(/** @type {{ accountId: string | null } | null} */ (null));

  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: async () => {
      const res = await api.accounts.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {Account[]} */ ((await res.json()).accounts);
    },
  });

  const accounts = accountsQuery.data ?? [];

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
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
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
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("Account archived.");
    },
    onError: (err) => toast.error(err.message),
  });

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
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["account-balances", variables.accountId] });
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
        <div className="grid grid-cols-2 gap-4">
          {/* compact — a full-precision "$68,975.88" headline overflows its
              half-width card at 375px and collides with the tile next to it;
              every account's exact balance is still one row below. */}
          <StatTile label="Net worth" value={<Money value={netWorthCents} compact />} />
          <StatTile label="Stale balances" value={staleCount} />
        </div>
      ) : null}

      {accountsQuery.isLoading ? (
        <ListSkeleton rows={5} label="Loading accounts" />
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={LandmarkIcon}
          title="No accounts yet"
          description="Add the accounts salary lands in, bills come out of, and savings live in — everything else in the app hangs off these."
          action={
            <Button onClick={() => setFormOpen(true)}>
              <PlusIcon />
              Add account
            </Button>
          }
        />
      ) : (
        groups.map((group) => (
          <div key={group.type} className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-text-muted">{ACCOUNT_TYPE_LABELS[group.type]}</h2>

            <div className="hidden overflow-x-auto rounded-(--radius-card) bg-surface shadow-(--shadow-card) md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-muted">
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Institution</th>
                    <th className="px-4 py-3 font-medium">Balance</th>
                    <th className="px-4 py-3 font-medium">As at</th>
                    <th className="px-4 py-3 font-medium">Growth</th>
                    <th className="px-4 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {group.items.map((account, index) => (
                    <tr key={account.id}>
                      <td className="px-4 py-3 text-text">
                        <button
                          type="button"
                          className="text-left hover:underline"
                          onClick={() => setDetailAccount(account)}
                        >
                          {account.name}
                        </button>
                        {account.isIncomeLanding ? (
                          <Badge variant="secondary" className="ml-2">
                            Income landing
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-text-muted">{account.institution ?? "—"}</td>
                      <td className="px-4 py-3 text-text">
                        {account.latestBalance ? <Money value={account.latestBalance.amountCents} /> : "—"}
                      </td>
                      <td className="px-4 py-3 text-text-muted">
                        {account.latestBalance ? (
                          <span
                            className={
                              daysSinceIso(account.latestBalance.asAt) > STALE_DAYS ? "text-negative" : undefined
                            }
                          >
                            {formatIsoDate(account.latestBalance.asAt, locale)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3 text-text-muted">
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
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Edit account"
                            onClick={() => {
                              setEditingAccount(account);
                              setFormOpen(true);
                            }}
                          >
                            <PencilIcon />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-negative"
                            aria-label="Archive account"
                            onClick={async () => {
                              const ok = await confirm({
                                title: `Archive ${account.name}?`,
                                description:
                                  "It stops appearing in lists and allocation destinations. Its balance history is kept.",
                                confirmLabel: "Archive",
                              });
                              if (ok) archiveMutation.mutate(account.id);
                            }}
                          >
                            <Trash2Icon />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <DataList className="md:hidden">
              {group.items.map((account, index) => (
                <DataListRow
                  key={account.id}
                  primary={
                    // data-touch-target: a bespoke button, so it does not
                    // inherit the coarse-pointer minimum the shared <Button>
                    // gets (see app.css).
                    <button
                      type="button"
                      data-touch-target
                      className="flex items-center text-left"
                      onClick={() => setDetailAccount(account)}
                    >
                      {account.name}
                    </button>
                  }
                  secondary={
                    account.latestBalance
                      ? `${account.institution ?? "No institution"} · as at ${formatIsoDate(account.latestBalance.asAt, locale)}`
                      : (account.institution ?? "No balance yet")
                  }
                  trailing={
                    <div className="flex items-center gap-1">
                      <ReorderControls
                        index={index}
                        count={group.items.length}
                        label={account.name}
                        disabled={reorderMutation.isPending}
                        onMove={(direction) => moveAccount(group.items, index, direction)}
                      />
                      <Button size="sm" variant="outline" onClick={() => setQuickUpdate({ accountId: account.id })}>
                        Update
                      </Button>
                    </div>
                  }
                />
              ))}
            </DataList>
          </div>
        ))
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
        onOpenChange={(open) => !open && setDetailAccount(null)}
        onQuickUpdate={() => detailAccount && setQuickUpdate({ accountId: detailAccount.id })}
      />
    </>
  );
}
