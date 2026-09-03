import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toCents } from "@budget/engine";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { toast } from "sonner";
import { Area, CartesianGrid, ComposedChart, Scatter, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button.jsx";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group.jsx";
import {
  AXIS,
  Chart,
  ChartTooltip,
  MoneyTooltip,
  SERIES,
  TIME_AXIS,
  isoToMs,
  useChartMotion,
  useMoneyTick,
  useTimeAxis,
} from "@/components/chart.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { Money } from "@/components/money.jsx";
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
 * `bill` is the balance again, present only on the days a bill actually
 * falls, so the marker series carries its own x rather than being padded
 * with nulls to share the line's index.
 *
 * @param {{ date: string, balanceCents: Cents, event: "payday" | "bill" }[]} points
 * @param {string} locale
 */
function balanceCurveRows(points, locale) {
  return points.map((point) => ({
    t: isoToMs(point.date),
    label: formatIsoDate(point.date, locale),
    balance: point.balanceCents / 100,
    bill: point.event === "bill" ? point.balanceCents / 100 : null,
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
  // operator has typed. Starting at `null` rather than "0" is the whole point
  // of this control: the curve no longer answers from a number nobody chose.
  const [whatIfDollars, setWhatIfDollars] = useState(/** @type {string | null} */ (null));

  const curveQuery = useQuery({
    queryKey: ["fixed-costs-balance-curve", window.from, window.to, whatIfDollars],
    queryFn: async () => {
      const res = await api["fixed-costs"]["balance-curve"].$get({
        query: {
          from: window.from,
          to: window.to,
          ...(whatIfDollars === null ? {} : { opening: String(toCents(Number(whatIfDollars) || 0)) }),
        },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {{ points: { date: string, balanceCents: Cents, event: "payday" | "bill" }[], requiredOpeningBalanceCents: Cents, openingBalanceCents: Cents, savedOpeningBalance: SavedOpeningBalance }} */ (
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
      setWhatIfDollars(null);
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["fixed-costs-balance-curve"] });
      toast.success(billsOpeningBalanceCents === null ? "Following the bills account balance" : "Starting balance saved");
    },
    onError: (/** @type {Error} */ error) => toast.error(error.message),
  });

  const saved = curveQuery.data?.savedOpeningBalance ?? null;
  // The field shows the typed what-if if there is one, otherwise the saved
  // figure the server resolved — never a hardcoded zero.
  const openingDollars = whatIfDollars ?? (saved ? (saved.openingBalanceCents / 100).toFixed(2) : "");
  const openingCents = toCents(Number(openingDollars) || 0);
  const isDirty = whatIfDollars !== null && saved !== null && openingCents !== saved.openingBalanceCents;

  const points = curveQuery.data?.points ?? [];
  const lowest = points.reduce(
    /** @param {typeof points[number] | null} min */ (min, p) => (min === null || p.balanceCents < min.balanceCents ? p : min),
    null,
  );

  const curveRows = balanceCurveRows(points, locale);
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
              <InputGroup>
                <InputGroupAddon>
                  <InputGroupText>$</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id="curve-opening"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={openingDollars}
                  onChange={(e) => setWhatIfDollars(e.target.value)}
                />
              </InputGroup>
            </FieldRow>
            {isDirty ? (
              <>
                <Button size="sm" onClick={() => saveOpening.mutate(openingCents)} disabled={saveOpening.isPending}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setWhatIfDollars(null)}>
                  Discard
                </Button>
              </>
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
              : saved?.source === "override"
                ? `Saved override.${saved.accountName ? ` ${saved.accountName}'s own balance is used if you clear it.` : ""}`
                : saved?.source === "account"
                  ? `From ${saved.accountName}${saved.asAt ? `, recorded ${formatIsoDate(saved.asAt, locale)}` : ""}. Type a figure to override it.`
                  : "No income-landing account balance recorded yet, so this starts from zero. Record one, or type a figure and save it."}
          </p>
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
            dataTable={{
              caption: "Projected balance after each payday and bill",
              columns: ["Date", "Event", "Balance"],
              rows: points.map((point) => [
                formatIsoDate(point.date, locale),
                point.event === "bill" ? "Bill due" : "Payday",
                formatMoney(point.balanceCents, { currency, locale }),
              ]),
            }}
            config={{
              balance: { label: "Balance", color: SERIES[0] },
              bill: { label: "Bill due", color: SERIES[3] },
            }}
          >
            <ComposedChart data={curveRows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} />
              {/* Explicit month ticks rather than whatever the axis picks:
                  without them a short window labels individual days and a
                  long one labels years, so the gridlines mean something
                  different at every horizon. */}
              <XAxis dataKey="t" {...AXIS} {...TIME_AXIS} {...timeAxis} minTickGap={32} />
              <YAxis {...AXIS} width={56} tickFormatter={moneyTick} />
              <ChartTooltip content={<MoneyTooltip />} />
              <Area
                dataKey="balance"
                type="monotone"
                stroke="var(--color-balance)"
                fill="var(--color-balance)"
                fillOpacity={0.15}
                strokeWidth={2}
                dot={false}
                {...motion}
              />
              <Scatter dataKey="bill" fill="var(--color-bill)" shape="circle" {...motion} />
            </ComposedChart>
          </Chart>
          {curveQuery.data && lowest ? (
            <p className="text-sm text-text-muted">
              At this contribution the account dips lowest on {formatIsoDate(lowest.date, locale)}, reaching{" "}
              <Money value={lowest.balanceCents} className="font-medium text-text" />. An opening balance of{" "}
              <Money value={curveQuery.data.requiredOpeningBalanceCents} className="font-medium text-text" /> keeps it above your buffer.
            </p>
          ) : null}
          {curveQuery.error ? <p className="text-sm text-negative">{/** @type {Error} */ (curveQuery.error).message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
