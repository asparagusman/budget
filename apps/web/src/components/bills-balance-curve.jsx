import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { toast } from "sonner";
import { Area, CartesianGrid, ComposedChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button.jsx";
import {
  AXIS,
  Chart,
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
import { FieldRow } from "@/components/field-row.jsx";
import { MoneyInput } from "@/components/money-input.jsx";
import { Money } from "@/components/money.jsx";
import { InlineError } from "@/components/notice.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { formatIsoDate } from "@/lib/dates.js";
import { formatMoney } from "@/lib/format-money.js";
import { useSettings } from "@/lib/settings.jsx";

/** @import { Cents } from "@budget/engine" */
/** @typedef {{ openingBalanceCents: Cents, source: "override" | "account" | "none", accountId: string | null, accountName: string | null, asAt: string | null }} SavedOpeningBalance */

/**
 * A real time axis, not one point per event. On a category axis every
 * payday/bill sat one slot apart whatever the gap between them, so a
 * three-day wait and a three-month wait drew the same width and the dates
 * along the bottom read as arbitrary (`[Fixed Costs 3]`). The chart's job is
 * "when does the account dip", and a chart that misstates *when* cannot do
 * it. Month gridlines give the reading back a scale.
 *
 * Timestamps are built at LOCAL midnight (`isoToMs`) rather than from a bare
 * `YYYY-MM-DD`, which parses as UTC — that shifts every point by the
 * timezone offset and can move a bill onto the wrong day.
 *
 * `event` rides along so the tooltip can say what moved the balance — a
 * separate marker series for bills put the timestamp itself into the tooltip
 * as a "t $1,803,733,200,000.00" row and repeated the balance beside it.
 *
 * @param {{ date: string, balanceCents: Cents, event: "payday" | "bill" }[]} points
 * @param {string} locale
 */
function balanceCurveRows(points, locale) {
  return points.map((point) => ({
    t: isoToMs(point.date),
    label: formatIsoDate(point.date, locale),
    balance: point.balanceCents / 100,
    event: point.event === "bill" ? "Bill due" : "Payday",
  }));
}

/**
 * Insight only, visibly separate from the contribution figure and unable to
 * alter it (phases/06-fixed-costs.md "What this phase must not do") —
 * collapsed by default, and its query only runs once expanded.
 *
 * Runs across its own twelve-month window rather than the four-year one the
 * contribution is averaged over: this chart answers "when does the account
 * dip", and four years of fortnightly events is a wall of ink no operator can
 * read a date off.
 *
 * @param {{ window: { from: string, to: string } }} props
 */
export function BillsBalanceCurve({ window }) {
  const { currency, locale } = useSettings();
  const moneyTick = useMoneyTick();
  const motion = useChartMotion();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // `null` means "whatever the server resolved" — the saved override, or the
  // bills account's own latest balance. A string is an unsaved what-if the
  // operator has typed, and `null` is the field cleared with nothing typed
  // yet — which asks the server for its own figure, never for a zero. Starting
  // at `undefined` rather than 0 is the whole point of this control: the
  // curve no longer answers from a number nobody chose.
  const [whatIfCents, setWhatIfCents] = useState(/** @type {Cents | null | undefined} */ (undefined));

  const curveQuery = useQuery({
    queryKey: ["fixed-costs-balance-curve", window.from, window.to, whatIfCents],
    queryFn: async () => {
      const res = await api["fixed-costs"]["balance-curve"].$get({
        query: {
          from: window.from,
          to: window.to,
          ...(typeof whatIfCents === "number" ? { opening: String(whatIfCents) } : {}),
        },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {{ points: { date: string, balanceCents: Cents, event: "payday" | "bill" }[], requiredOpeningBalanceCents: Cents, bufferCents: Cents, withdrawableCents: Cents, openingBalanceCents: Cents, savedOpeningBalance: SavedOpeningBalance }} */ (
        await res.json()
      );
    },
    enabled: open,
  });

  const saveOpening = useMutation({
    /** @param {number | null} billsOpeningBalanceCents */
    mutationFn: async (billsOpeningBalanceCents) => {
      const res = await api.settings.$patch({ json: { billsOpeningBalanceCents } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: (_data, billsOpeningBalanceCents) => {
      // Back to following the saved figure — the input is no longer a what-if
      // once the what-if has been saved.
      setWhatIfCents(undefined);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["fixed-costs-balance-curve"] });
      toast.success(billsOpeningBalanceCents === null ? "Following the bills account balance" : "Starting balance saved");
    },
    onError: (/** @type {Error} */ error) => toast.error(error.message),
  });

  const saved = curveQuery.data?.savedOpeningBalance ?? null;
  // The field shows the typed what-if if there is one, otherwise the saved
  // figure the server resolved — never a hardcoded zero.
  const openingCents = whatIfCents === undefined ? (saved?.openingBalanceCents ?? null) : whatIfCents;
  const isBlank = whatIfCents === null;
  const isDirty = typeof whatIfCents === "number" && saved !== null && whatIfCents !== saved.openingBalanceCents;

  // Memoised so the chart's rows keep their identity across unrelated
  // renders: Recharts restarts its entrance animation whenever its data is a
  // new array, and this panel re-renders with every keystroke in the
  // fixed-costs editor above it (perf-inp-plan.md, P1.5).
  const points = useMemo(() => curveQuery.data?.points ?? [], [curveQuery.data]);
  const lowest = points.reduce(
    /** @param {typeof points[number] | null} min */ (min, p) => (min === null || p.balanceCents < min.balanceCents ? p : min),
    null,
  );

  // How much the operator could take out today. The curve is already drawn
  // from the figure in the box, so this is "from here", and previewing it
  // just types the reduced balance in as a what-if — nothing is saved.
  const withdrawable = curveQuery.data?.withdrawableCents ?? 0;
  const shortfall = curveQuery.data ? Math.max(0, curveQuery.data.requiredOpeningBalanceCents - curveQuery.data.openingBalanceCents) : 0;
  const bufferCents = curveQuery.data?.bufferCents ?? 0;

  const curveRows = useMemo(() => balanceCurveRows(points, locale), [points, locale]);
  const timeAxis = useTimeAxis(curveRows[0]?.t ?? 0, curveRows[curveRows.length - 1]?.t ?? 0);

  return (
    <div className="rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
      <button type="button" className="flex w-full items-center justify-between gap-2 p-5 text-left" onClick={() => setOpen((o) => !o)}>
        <div>
          <h3 className="font-semibold text-text">Balance curve</h3>
          <p className="text-xs text-text-muted">Insight only — never changes the contribution above.</p>
        </div>
        {open ? <ChevronDownIcon className="size-5 text-text-muted" /> : <ChevronRightIcon className="size-5 text-text-muted" />}
      </button>
      {open ? (
        <div className="flex flex-col gap-4 border-t border-border p-5">
          <div className="flex flex-wrap items-end gap-3">
            <FieldRow label="Starting balance" htmlFor="curve-opening" className="max-w-40">
              <MoneyInput id="curve-opening" allowNegative value={openingCents} onChange={setWhatIfCents} />
            </FieldRow>
            {isDirty ? (
              <>
                <Button size="sm" onClick={() => saveOpening.mutate(whatIfCents ?? null)} disabled={saveOpening.isPending}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setWhatIfCents(undefined)}>
                  Discard
                </Button>
              </>
            ) : isBlank ? (
              <Button size="sm" variant="ghost" onClick={() => setWhatIfCents(undefined)}>
                Discard
              </Button>
            ) : saved?.source === "override" ? (
              <Button size="sm" variant="ghost" onClick={() => saveOpening.mutate(null)} disabled={saveOpening.isPending}>
                Use account balance
              </Button>
            ) : null}
          </div>
          {/* Say where this figure came from. The screen's whole job is
              answering "will the bills account survive", and it can't do that
              honestly from a number whose provenance is hidden. */}
          <p className="text-xs text-text-muted">
            {isDirty
              ? "Unsaved what-if — the curve below uses this figure, but nothing has been saved."
              : isBlank
                ? "Nothing typed, so the curve below still uses the figure it started from. Type a figure to try another."
                : saved?.source === "override"
                  ? `Saved override.${saved.accountName ? ` ${saved.accountName}'s own balance is used if you clear it.` : ""}`
                  : saved?.source === "account"
                    ? `From ${saved.accountName}${saved.asAt ? `, recorded ${formatIsoDate(saved.asAt, locale)}` : ""}. Type a figure to override it.`
                    : "No income-landing account balance recorded yet, so this starts from zero. Record one, or type a figure and save it."}
          </p>
          {curveQuery.data ? (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-(--radius-control) bg-surface-muted px-4 py-3">
              {withdrawable > 0 ? (
                <>
                  <p className="text-sm text-text-muted">
                    You could take out <Money value={withdrawable} className="text-base font-semibold text-text" /> now and the account would still
                    stay above its <Money value={bufferCents} className="font-medium text-text" /> buffer for the next twelve months.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setWhatIfCents(curveQuery.data.openingBalanceCents - withdrawable)}
                  >
                    Preview taking it out
                  </Button>
                </>
              ) : shortfall > 0 ? (
                <p className="text-sm text-text-muted">
                  Nothing to take out — this account is <Money value={shortfall} className="font-medium text-text" /> short of staying above its{" "}
                  <Money value={bufferCents} className="font-medium text-text" /> buffer.
                </p>
              ) : (
                <p className="text-sm text-text-muted">
                  No more to take out — the lowest point sits right on the <Money value={bufferCents} className="font-medium text-text" /> buffer.
                </p>
              )}
            </div>
          ) : null}
          <Chart
            loading={curveQuery.isLoading}
            empty={points.length === 0}
            emptyTitle="No projection yet"
            height={260}
            ariaLabel={
              lowest
                ? `Projected bills-account balance across ${points.length} events, dipping lowest on ${formatIsoDate(lowest.date, locale)} at ${formatMoney(lowest.balanceCents, { currency, locale })}.`
                : "Projected bills-account balance over time."
            }
            dataTable={() => ({
              caption: "Projected balance after each payday and bill",
              columns: ["Date", "Event", "Balance"],
              rows: points.map((point) => [
                formatIsoDate(point.date, locale),
                point.event === "bill" ? "Bill due" : "Payday",
                formatMoney(point.balanceCents, { currency, locale }),
              ]),
            })}
            config={{
              balance: { label: "Balance", color: TOTAL },
            }}
          >
            <ComposedChart data={curveRows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} />
              {/* Explicit month ticks rather than whatever the axis picks:
                  without them a short window labels individual days and a
                  long one labels years, so the gridlines mean something
                  different at every horizon. */}
              <XAxis dataKey="t" {...AXIS} {...TIME_AXIS} {...timeAxis} minTickGap={32} />
              {/* Floor at zero but let a negative balance show: the default domain
                  starts at 0 and would clip exactly the dips this chart
                  exists to find. */}
              <YAxis {...AXIS} width={56} tickFormatter={moneyTick} domain={[(/** @type {number} */ min) => Math.min(0, min), "auto"]} />
              <ChartTooltip
                content={
                  <MoneyTooltip
                    labelFormatter={(_value, payload) => {
                      const row = payload?.[0]?.payload;
                      return row ? `${row.label} · ${row.event}` : "";
                    }}
                  />
                }
              />
              <ReferenceLine
                y={bufferCents / 100}
                stroke="var(--negative)"
                strokeDasharray="2 4"
                ifOverflow="extendDomain"
                label={{ value: "Buffer", position: "insideTopLeft", fill: "var(--negative)", fontSize: 11 }}
              />
              <Area
                dataKey="balance"
                type="stepAfter"
                stroke="var(--color-balance)"
                fill="var(--color-balance)"
                {...PROJECTED}
                strokeWidth={2}
                dot={false}
                {...motion}
              />
            </ComposedChart>
          </Chart>
          {curveQuery.data && lowest ? (
            <p className="text-sm text-text-muted">
              At this contribution the account dips lowest on {formatIsoDate(lowest.date, locale)}, reaching{" "}
              <Money value={lowest.balanceCents} className="font-medium text-text" />. An opening balance of{" "}
              <Money value={curveQuery.data.requiredOpeningBalanceCents} className="font-medium text-text" /> keeps it above your buffer.
            </p>
          ) : null}
          {curveQuery.error ? <InlineError>{/** @type {Error} */ (curveQuery.error).message}</InlineError> : null}
        </div>
      ) : null}
    </div>
  );
}
