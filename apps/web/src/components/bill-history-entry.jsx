import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toCents } from "@budget/engine";
import { SaveIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { ListSkeleton } from "@/components/loading.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { Money } from "@/components/money.jsx";
import { Stat, StatGroup } from "@/components/stat-tile.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { formatIsoDate } from "@/lib/dates.js";
import { useSettings } from "@/lib/settings.jsx";

/** @import { Cents } from "@budget/engine" */
/** @typedef {{ ordinal: number, label: string, dueDate: string, actualCents: Cents | null }} HistorySlot */

const LOOKBACK_OPTIONS = /** @type {const} */ (["6", "12", "24", "custom"]);

/** @param {Cents[]} values */
function computeStats(values) {
  const mean = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stdDev = Math.round(Math.sqrt(variance));
  return { mean, min, max, stdDev };
}

/**
 * The reverse-sequential entry form — the phase's most important interaction
 * (phases/06-fixed-costs.md "/costs/fixed/:billId/history"). Pick a lookback,
 * then enter downward: "Previous bill", "2 bills ago", … Typing never
 * reorders rows or steals focus; the operator is reading off a stack of
 * statements and any jump loses their place.
 *
 * Lives here rather than in the route so the fixed-costs table can open it in
 * a dialog, one click from the bill it belongs to, instead of sending the
 * operator to a different screen and back. The route
 * (`/costs/fixed/$billId/history`) renders this same component, so a
 * bookmarked deep link still works and there is only one copy of the
 * interaction.
 *
 * This is also what makes a `rolling_average` bill mean anything: the actuals
 * entered here are what the engine averages, and the amount the bill's row
 * prints changes the moment they are saved.
 *
 * @param {{ billId: string, autoFocus?: boolean, onSaved?: () => void }} props
 */
export function BillHistoryEntry({ billId, autoFocus = false, onSaved }) {
  const { locale } = useSettings();
  const queryClient = useQueryClient();
  const inputRefs = useRef(/** @type {(HTMLInputElement | null)[]} */ ([]));

  const [lookback, setLookback] = useState(/** @type {(typeof LOOKBACK_OPTIONS)[number]} */ ("6"));
  const [customPeriods, setCustomPeriods] = useState("18");
  const [values, setValues] = useState(/** @type {string[]} */ ([]));

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await api.settings.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).settings;
    },
  });

  // Applies the operator's saved default lookback once, the first time it
  // loads — an explicit later choice (including "custom") must never be
  // overwritten by a slow settings response landing after it.
  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (appliedDefaultRef.current) return;
    const def = Number(settingsQuery.data?.historyLookbackDefault);
    if (!Number.isFinite(def)) return;
    appliedDefaultRef.current = true;
    setLookback(/** @type {(typeof LOOKBACK_OPTIONS)[number]} */ ([6, 12, 24].includes(def) ? String(def) : "custom"));
    setCustomPeriods(String(def));
  }, [settingsQuery.data]);

  const periods = lookback === "custom" ? Math.max(1, Number(customPeriods) || 1) : Number(lookback);

  const historyQuery = useQuery({
    queryKey: ["bill-history", billId, periods],
    queryFn: async () => {
      const res = await api.bills[":id"].history.$get({
        param: { id: billId },
        query: { periods: String(periods) },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {{ billId: string, slots: HistorySlot[] }} */ (await res.json());
    },
  });

  const slots = historyQuery.data?.slots ?? [];

  useEffect(() => {
    setValues(slots.map((s) => (s.actualCents !== null ? String(s.actualCents / 100) : "")));
    // Only re-syncs when the slot set itself changes (a different bill or
    // lookback) — never while the operator is mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Only entries that actually changed from what loaded — an untouched
      // blank slot has nothing to remember (phases/06-fixed-costs.md
      // "Instance storage"), and submitting one anyway would create a bare
      // row with nothing in it.
      const entries = slots
        .map((slot, i) => {
          const raw = values[i]?.trim() ?? "";
          const nextCents = raw === "" ? null : toCents(Number(raw));
          return nextCents !== slot.actualCents ? { dueDate: slot.dueDate, actualCents: nextCents } : null;
        })
        .filter((e) => e !== null);
      if (entries.length === 0) return { billInstances: [] };
      const res = await api.bills[":id"].history.$put({ param: { id: billId }, json: { entries } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["bill-history", billId] });
      queryClient.invalidateQueries({ queryKey: ["bill-detail", billId] });
      // `bills` carries the entered actuals the fixed-costs table projects
      // its rolling averages from, so it has to be refetched here or the row
      // keeps printing the pre-save figure.
      queryClient.invalidateQueries({ queryKey: ["bills"] });
      queryClient.invalidateQueries({ queryKey: ["fixed-costs-summary"] });
      queryClient.invalidateQueries({ queryKey: ["bill-instances"] });
      toast.success(result.billInstances.length > 0 ? "History saved." : "Nothing changed.");
      onSaved?.();
    },
    onError: (/** @type {Error} */ err) => toast.error(err.message),
  });

  const stats = useMemo(() => {
    const enteredCents = values.map((v) => (v.trim() === "" ? null : toCents(Number(v)))).filter((v) => v !== null);
    return enteredCents.length > 0 ? computeStats(enteredCents) : null;
  }, [values]);

  /** @param {number} index */
  function focusSlot(index) {
    inputRefs.current[index]?.focus();
    inputRefs.current[index]?.select();
  }

  /** @param {import("react").KeyboardEvent<HTMLInputElement>} e @param {number} index */
  function handleKeyDown(e, index) {
    if (e.key === "Enter") {
      e.preventDefault();
      focusSlot(index + 1);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <FieldRow label="Lookback" htmlFor={`history-lookback-${billId}`} className="w-40">
            <Select value={lookback} onValueChange={(v) => setLookback(/** @type {(typeof LOOKBACK_OPTIONS)[number]} */ (v))}>
              <SelectTrigger id={`history-lookback-${billId}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="6">6 periods</SelectItem>
                <SelectItem value="12">12 periods</SelectItem>
                <SelectItem value="24">24 periods</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          {lookback === "custom" ? (
            <FieldRow label="Periods" htmlFor={`history-custom-${billId}`} className="w-28">
              <Input
                id={`history-custom-${billId}`}
                type="number"
                min="1"
                inputMode="numeric"
                value={customPeriods}
                onChange={(e) => setCustomPeriods(e.target.value)}
              />
            </FieldRow>
          ) : null}
        </div>
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          <SaveIcon />
          {saveMutation.isPending ? "Saving…" : "Save history"}
        </Button>
      </div>

      {stats ? (
        <StatGroup aria-label="Bill history summary">
          <Stat label="Mean" value={<Money value={stats.mean} />} />
          <Stat label="Min" value={<Money value={stats.min} />} />
          <Stat label="Max" value={<Money value={stats.max} />} />
          <Stat
            label="Variance band"
            value={
              <span className="text-lg">
                <Money value={stats.mean - stats.stdDev} /> – <Money value={stats.mean + stats.stdDev} />
              </span>
            }
          />
        </StatGroup>
      ) : null}

      {historyQuery.isLoading ? (
        <ListSkeleton rows={6} label="Loading bill history" />
      ) : slots.length === 0 ? (
        <EmptyState title="No history to show" description="This bill has no derivable due dates in the chosen lookback." />
      ) : (
        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
          {slots.map((slot, i) => (
            <div key={slot.dueDate} className="flex items-center justify-between gap-4 px-4 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">{slot.label}</p>
                <p className="text-xs text-text-muted">{formatIsoDate(slot.dueDate, locale)}</p>
              </div>
              <InputGroup className="h-11 w-40 shrink-0">
                <InputGroupAddon>
                  <InputGroupText>$</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  ref={(el) => {
                    inputRefs.current[i] = el;
                  }}
                  autoFocus={autoFocus && i === 0}
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  className="text-base"
                  value={values[i] ?? ""}
                  onChange={(e) => setValues((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
                  onKeyDown={(e) => handleKeyDown(e, i)}
                />
              </InputGroup>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
