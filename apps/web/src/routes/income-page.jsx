import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { toCents } from "@budget/engine";
import {
  AlertTriangleIcon,
  CalendarRangeIcon,
  CopyIcon,
  GitCompareIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  WalletIcon,
} from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { Delta } from "@/components/delta.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { Money } from "@/components/money.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { CADENCES, CADENCE_LABELS } from "@/lib/constants.js";
import { formatIsoDate, todayIso } from "@/lib/dates.js";
import { cn } from "@/lib/utils.js";

/** @import { Cadence, Cents } from "@budget/engine" */
/** @typedef {{ id: string, name: string }} Person */
/** @typedef {{ perPay: Cents | null, perMonth: Cents, perYear: Cents }} CadenceTotals */
/** @typedef {{ id: string, variantId: string, personId: string, label: string | null, amountCents: Cents, cadence: Cadence, notes: string | null, sortOrder: number }} IncomeLine */
/** @typedef {{ id: string, name: string, notes: string | null, sortOrder: number, lines: IncomeLine[], totals: { perPersonCents: Record<string, CadenceTotals>, totalCents: CadenceTotals } }} IncomeVariant */
/** @typedef {{ id: string, variantId: string, startsOn: string, endsOn: string | null, notes: string | null }} ScheduleEntry */
/** @typedef {{ kind: "overlap", variantIds: string[], from: string, to: string } | { kind: "gap", from: string, to: string }} VariantDiagnostic */
/** @typedef {{ variantId: string | null, variant: IncomeVariant | null, diagnostics: VariantDiagnostic[] }} ResolveResult */
/** @typedef {{ name: string, notes: string | null }} VariantFormData */
/** @typedef {{ personId: string, label: string | null, amountCents: Cents, cadence: Cadence, notes: string | null }} IncomeLineFormData */
/** @typedef {{ variantId: string, startsOn: string, endsOn: string | null, notes: string | null }} ScheduleFormData */

// The five chart line tokens double as a stable variant palette — the same
// colours the rest of the app already uses for series, so a variant reads as
// "the same thing" wherever it shows up.
const VARIANT_COLOR_VARS = [
  "var(--chart-line-1)",
  "var(--chart-line-2)",
  "var(--chart-line-3)",
  "var(--chart-line-4)",
  "var(--chart-line-5)",
];

/** @param {string[]} orderedVariantIds @param {string} variantId */
function colorForVariant(orderedVariantIds, variantId) {
  const idx = Math.max(orderedVariantIds.indexOf(variantId), 0);
  return VARIANT_COLOR_VARS[idx % VARIANT_COLOR_VARS.length];
}

/** @param {Person[]} people @param {string} personId */
function personName(people, personId) {
  return people.find((p) => p.id === personId)?.name ?? "Unknown person";
}

/** @param {IncomeVariant[]} variants @param {string} variantId */
function variantName(variants, variantId) {
  return variants.find((v) => v.id === variantId)?.name ?? "Unknown variant";
}

// UI-only calendar arithmetic for the schedule timeline's display window —
// not a business calculation, so plain `Date` math is fine here the same way
// lib/dates.js already uses it (packages/engine never calls `new Date()`
// itself; every engine caller passes `today` in).
/** @param {string} iso @param {number} months */
function addMonthsIso(iso, months) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(/** @type {number} */ (y), /** @type {number} */ (m) - 1 + months, /** @type {number} */ (d));
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** @param {string} iso */
function isoToMs(iso) {
  return new Date(`${iso}T00:00:00`).getTime();
}

/**
 * Pairwise interval overlap on real (unclamped) date ranges — an open
 * `endsOn` is treated as +Infinity. Used to flag which schedule entries
 * collide, independent of whichever window the timeline happens to display.
 *
 * @param {ScheduleEntry[]} entries
 */
function computeOverlappingIds(entries) {
  /** @type {Set<string>} */
  const overlapping = new Set();
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = /** @type {ScheduleEntry} */ (entries[i]);
      const b = /** @type {ScheduleEntry} */ (entries[j]);
      const aStart = isoToMs(a.startsOn);
      const aEnd = a.endsOn ? isoToMs(a.endsOn) : Number.POSITIVE_INFINITY;
      const bStart = isoToMs(b.startsOn);
      const bEnd = b.endsOn ? isoToMs(b.endsOn) : Number.POSITIVE_INFINITY;
      if (aStart < bEnd && bStart < aEnd) {
        overlapping.add(a.id);
        overlapping.add(b.id);
      }
    }
  }
  return overlapping;
}

/**
 * Stretches of `[windowStartMs, windowEndMs)` no entry covers — standard
 * merge-intervals-then-complement, clipped to the display window.
 *
 * @param {ScheduleEntry[]} entries
 * @param {number} windowStartMs
 * @param {number} windowEndMs
 */
function computeGaps(entries, windowStartMs, windowEndMs) {
  const clipped = entries
    .map((e) => {
      const start = Math.max(isoToMs(e.startsOn), windowStartMs);
      const end = Math.min(e.endsOn ? isoToMs(e.endsOn) : windowEndMs, windowEndMs);
      return /** @type {[number, number]} */ ([start, end]);
    })
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  /** @type {[number, number][]} */
  const gaps = [];
  let cursor = windowStartMs;
  for (const [start, end] of clipped) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < windowEndMs) gaps.push([cursor, windowEndMs]);
  return gaps;
}

/**
 * Label + dominant figure for one of the three cadence columns every totals
 * display uses — variant cards, the detail sheet, the active-variant banner.
 *
 * @param {{ label: string, value: Cents | null }} props
 */
function TotalCell({ label, value }) {
  return (
    <div>
      <p className="text-xs text-text-subtle">{label}</p>
      <p className="font-semibold text-text">{value != null ? <Money value={value} /> : "—"}</p>
    </div>
  );
}

/**
 * @param {{ totals: { perPersonCents: Record<string, CadenceTotals>, totalCents: CadenceTotals }, payCadenceLabel: string | null }} props
 */
function TotalsRow({ totals, payCadenceLabel }) {
  return (
    <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
      <TotalCell label={`Per pay${payCadenceLabel ? ` (${payCadenceLabel})` : ""}`} value={totals.totalCents.perPay} />
      <TotalCell label="Per month" value={totals.totalCents.perMonth} />
      <TotalCell label="Per year" value={totals.totalCents.perYear} />
    </div>
  );
}

/**
 * Resolves today's variant and shows its total per pay period as the
 * dominant figure — or a warning naming the conflict when the schedule
 * doesn't resolve cleanly (phases/05-income.md "Active variant banner").
 * `override` is a URL lens (not a stored fact) letting the operator view a
 * different variant's totals without changing what "today" resolves to.
 *
 * @param {{
 *   resolution: { variantId: string | null, variant: IncomeVariant | null, diagnostics: VariantDiagnostic[] } | undefined,
 *   isLoading: boolean,
 *   variants: IncomeVariant[],
 *   payCadenceLabel: string | null,
 *   override: IncomeVariant | null,
 *   onClearOverride: () => void,
 * }} props
 */
function ActiveVariantBanner({ resolution, isLoading, variants, payCadenceLabel, override, onClearOverride }) {
  if (isLoading) {
    return <div className="h-24 animate-pulse rounded-(--radius-card) bg-surface shadow-(--shadow-card)" />;
  }

  const diagnostic = resolution?.diagnostics[0] ?? null;
  const shown = override ?? resolution?.variant ?? null;

  return (
    <div className="flex flex-col gap-3 rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
      {diagnostic ? (
        <div className="flex items-start gap-2 rounded-lg bg-negative-soft p-3 text-sm text-negative">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            {diagnostic.kind === "overlap" ? (
              <>
                Overlapping variants today:{" "}
                <strong>{diagnostic.variantIds.map((id) => variantName(variants, id)).join(" and ")}</strong> both
                cover {formatIsoDate(diagnostic.from, "en-AU")} – {formatIsoDate(diagnostic.to, "en-AU")}. No variant
                is confidently active.
              </>
            ) : (
              <>
                No variant covers today ({formatIsoDate(diagnostic.from, "en-AU")} –{" "}
                {formatIsoDate(diagnostic.to, "en-AU")}). Add a schedule entry to close the gap.
              </>
            )}
          </p>
        </div>
      ) : null}

      {override ? (
        <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
          <span>
            Viewing <strong className="text-text">{override.name}</strong> — not today&apos;s resolved variant.
          </span>
          <Button size="sm" variant="ghost" onClick={onClearOverride}>
            View today
          </Button>
        </div>
      ) : null}

      {shown ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
              {override ? "Viewing" : "Active today"}
            </p>
            <p className="mt-1 text-3xl font-bold tracking-tight text-text">
              {shown.totals.totalCents.perPay != null ? (
                <Money value={shown.totals.totalCents.perPay} />
              ) : (
                <Money value={shown.totals.totalCents.perMonth} />
              )}
              <span className="ml-1.5 text-base font-medium text-text-muted">
                {shown.totals.totalCents.perPay != null ? `per pay (${payCadenceLabel})` : "per month"}
              </span>
            </p>
          </div>
          <p className="text-lg font-semibold text-text">{shown.name}</p>
        </div>
      ) : (
        <EmptyState
          icon={WalletIcon}
          title="No variant is active"
          description="Add a schedule entry covering today, or create an income variant to get started."
        />
      )}
    </div>
  );
}

/**
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   variant: IncomeVariant | null,
 *   submitting: boolean,
 *   onSubmit: (data: VariantFormData) => Promise<void>,
 * }} props
 */
function VariantFormDialog({ open, onOpenChange, variant, submitting, onSubmit }) {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setName(variant?.name ?? "");
    setNotes(variant?.notes ?? "");
    setError(null);
  }, [open, variant]);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Enter a name.");
      return;
    }
    try {
      await onSubmit({ name: name.trim(), notes: notes.trim() || null });
      onOpenChange(false);
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{variant ? "Edit income variant" : "Add income variant"}</DialogTitle>
          <DialogDescription>
            A named income scenario — "Usual", "PL Gov (High)" — with its own set of lines.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FieldRow label="Name" htmlFor="variant-name" required>
            <Input id="variant-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </FieldRow>
          <FieldRow label="Notes" htmlFor="variant-notes" hint="Optional — context worth keeping, e.g. scheme details.">
            <Textarea id="variant-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
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
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   line: IncomeLine | null,
 *   people: Person[],
 *   submitting: boolean,
 *   onSubmit: (data: IncomeLineFormData) => Promise<void>,
 * }} props
 */
function IncomeLineFormDialog({ open, onOpenChange, line, people, submitting, onSubmit }) {
  const [personId, setPersonId] = useState("");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState(/** @type {Cadence} */ ("fortnightly"));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setPersonId(line?.personId ?? people[0]?.id ?? "");
    setLabel(line?.label ?? "");
    setAmount(line ? String(line.amountCents / 100) : "");
    setCadence(line?.cadence ?? "fortnightly");
    setNotes(line?.notes ?? "");
    setError(null);
  }, [open, line, people]);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!personId) {
      setError("Choose a person.");
      return;
    }
    if (amount.trim() === "") {
      setError("Enter an amount.");
      return;
    }
    try {
      await onSubmit({
        personId,
        label: label.trim() || null,
        amountCents: toCents(Number(amount)),
        cadence,
        notes: notes.trim() || null,
      });
      onOpenChange(false);
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{line ? "Edit income line" : "Add income line"}</DialogTitle>
          <DialogDescription>One person's income within this variant.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FieldRow label="Person" htmlFor="line-person">
            <Select value={personId} onValueChange={setPersonId}>
              <SelectTrigger id="line-person" className="w-full">
                <SelectValue placeholder="Choose a person" />
              </SelectTrigger>
              <SelectContent>
                {people.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Label" htmlFor="line-label" hint='Optional — e.g. "Salary", "Gov PPL".'>
            <Input id="line-label" value={label} onChange={(e) => setLabel(e.target.value)} />
          </FieldRow>
          <FieldRow label="Amount" htmlFor="line-amount" required hint="After tax.">
            <InputGroup>
              <InputGroupAddon>
                <InputGroupText>$</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                id="line-amount"
                type="number"
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </InputGroup>
          </FieldRow>
          <FieldRow label="Cadence" htmlFor="line-cadence">
            <Select value={cadence} onValueChange={(value) => setCadence(/** @type {Cadence} */ (value))}>
              <SelectTrigger id="line-cadence" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CADENCES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CADENCE_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Notes" htmlFor="line-notes" hint="Optional.">
            <Textarea id="line-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
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
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   entry: ScheduleEntry | null,
 *   variants: IncomeVariant[],
 *   submitting: boolean,
 *   onSubmit: (data: ScheduleFormData) => Promise<void>,
 *   onDelete: (() => void) | null,
 * }} props
 */
function ScheduleEntryFormDialog({ open, onOpenChange, entry, variants, submitting, onSubmit, onDelete }) {
  const [variantId, setVariantId] = useState("");
  const [startsOn, setStartsOn] = useState(todayIso());
  const [openEnded, setOpenEnded] = useState(true);
  const [endsOn, setEndsOn] = useState(todayIso());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setVariantId(entry?.variantId ?? variants[0]?.id ?? "");
    setStartsOn(entry?.startsOn ?? todayIso());
    setOpenEnded(entry ? entry.endsOn === null : true);
    setEndsOn(entry?.endsOn ?? todayIso());
    setNotes(entry?.notes ?? "");
    setError(null);
  }, [open, entry, variants]);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!variantId) {
      setError("Choose a variant.");
      return;
    }
    if (!openEnded && endsOn <= startsOn) {
      setError("End date must be after the start date.");
      return;
    }
    // Always includes `variantId`, even when editing — the PATCH schema
    // (zod/variant-schedule.js) has no such field, so Zod's default "strip
    // unknown keys" behaviour drops it there; uniform shape here means one
    // `ScheduleFormData` type instead of a create/update union.
    const data = { variantId, startsOn, endsOn: openEnded ? null : endsOn, notes: notes.trim() || null };
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
          <DialogTitle>{entry ? "Edit schedule entry" : "Add schedule entry"}</DialogTitle>
          <DialogDescription>Tells the app which variant is active over this date range.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {!entry ? (
            <FieldRow label="Variant" htmlFor="entry-variant">
              <Select value={variantId} onValueChange={setVariantId}>
                <SelectTrigger id="entry-variant" className="w-full">
                  <SelectValue placeholder="Choose a variant" />
                </SelectTrigger>
                <SelectContent>
                  {variants.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          ) : (
            <p className="text-sm text-text-muted">{variantName(variants, entry.variantId)}</p>
          )}
          <FieldRow label="Starts on" htmlFor="entry-starts">
            <Input id="entry-starts" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </FieldRow>
          <FieldRow
            label="Open-ended"
            htmlFor="entry-open-ended"
            hint='"This variant, from here on." Turn off to set an end date.'
          >
            <Switch id="entry-open-ended" checked={openEnded} onCheckedChange={setOpenEnded} />
          </FieldRow>
          {!openEnded ? (
            <FieldRow label="Ends on" htmlFor="entry-ends">
              <Input id="entry-ends" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
            </FieldRow>
          ) : null}
          <FieldRow label="Notes" htmlFor="entry-notes" hint="Optional.">
            <Textarea id="entry-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </FieldRow>
          {error ? <p className="text-sm text-negative">{error}</p> : null}
          <DialogFooter className={onDelete ? "sm:justify-between!" : undefined}>
            {onDelete ? (
              <Button type="button" variant="ghost" className="text-negative" onClick={onDelete}>
                Delete
              </Button>
            ) : null}
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
 * One band per scheduled entry, coloured by variant. Overlaps ring red;
 * uncovered stretches sit behind everything as a tinted band — the operator
 * should see a bad schedule, not read about it (phases/05-income.md
 * "Schedule timeline").
 *
 * @param {{ entries: ScheduleEntry[], variants: IncomeVariant[], onEditEntry: (entry: ScheduleEntry) => void }} props
 */
function ScheduleTimelineDesktop({ entries, variants, onEditEntry }) {
  const { windowFrom, windowTo } = useMemo(() => {
    const today = todayIso();
    return { windowFrom: addMonthsIso(today, -3), windowTo: addMonthsIso(today, 18) };
  }, []);
  const windowStartMs = isoToMs(windowFrom);
  const windowEndMs = isoToMs(windowTo);
  const span = windowEndMs - windowStartMs;

  /** @param {number} ms */
  const pct = (ms) => (Math.min(Math.max(ms, windowStartMs), windowEndMs) - windowStartMs) / span * 100;

  const overlapping = useMemo(() => computeOverlappingIds(entries), [entries]);
  const gaps = useMemo(() => computeGaps(entries, windowStartMs, windowEndMs), [entries, windowStartMs, windowEndMs]);
  const orderedVariantIds = variants.map((v) => v.id);
  const sorted = [...entries].sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  const todayPct = pct(isoToMs(todayIso()));

  return (
    <div className="rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
      <div className="mb-3 flex items-center justify-between text-xs text-text-muted">
        <span>{formatIsoDate(windowFrom, "en-AU")}</span>
        <span>{formatIsoDate(windowTo, "en-AU")}</span>
      </div>
      <div className="relative min-h-12">
        {gaps.map(([gStart, gEnd], i) => (
          <div
            key={i}
            className="absolute inset-y-0 rounded-md bg-negative-soft"
            style={{ left: `${pct(gStart)}%`, width: `${Math.max(pct(gEnd) - pct(gStart), 0.4)}%` }}
          />
        ))}
        <div className="absolute inset-y-0 z-20 w-px bg-(--accent)" style={{ left: `${todayPct}%` }} />
        <div className="relative z-10 flex flex-col gap-2 py-1">
          {sorted.map((entry) => {
            const left = pct(isoToMs(entry.startsOn));
            const right = pct(entry.endsOn ? isoToMs(entry.endsOn) : windowEndMs);
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => onEditEntry(entry)}
                className={cn(
                  "h-8 rounded-md border-l-4 text-left text-xs font-medium text-text transition-opacity hover:opacity-80",
                  overlapping.has(entry.id) && "ring-2 ring-negative ring-offset-1 ring-offset-surface",
                )}
                style={{
                  marginLeft: `${left}%`,
                  width: `${Math.max(right - left, 1.5)}%`,
                  // A tinted fill + coloured left border reads clearly in
                  // both themes without a hardcoded text colour fighting an
                  // arbitrary background lightness the way solid-fill +
                  // white text would (some chart-line tokens are light).
                  borderLeftColor: colorForVariant(orderedVariantIds, entry.variantId),
                  backgroundColor: `color-mix(in oklch, ${colorForVariant(orderedVariantIds, entry.variantId)} 16%, transparent)`,
                }}
                title={`${variantName(variants, entry.variantId)} · ${formatIsoDate(entry.startsOn, "en-AU")} – ${entry.endsOn ? formatIsoDate(entry.endsOn, "en-AU") : "open-ended"}`}
              >
                <span className="block truncate px-2 py-1.5">{variantName(variants, entry.variantId)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Mobile answer to the Gantt above: the same information as a vertical list
 * ordered by date, overlaps and gaps flagged inline rather than drawn
 * (phases/05-income.md "Schedule timeline" — "Do not put a horizontally-
 * scrolling Gantt chart on a phone").
 *
 * @param {{ entries: ScheduleEntry[], variants: IncomeVariant[], onEditEntry: (entry: ScheduleEntry) => void }} props
 */
function ScheduleTimelineMobile({ entries, variants, onEditEntry }) {
  const overlapping = useMemo(() => computeOverlappingIds(entries), [entries]);
  const sorted = [...entries].sort((a, b) => a.startsOn.localeCompare(b.startsOn));

  return (
    <DataList>
      {sorted.map((entry, i) => {
        const prev = sorted[i - 1];
        const hasGapBefore = prev && prev.endsOn && entry.startsOn > prev.endsOn;
        return (
          <div key={entry.id}>
            {hasGapBefore ? (
              <div className="flex items-center gap-2 bg-negative-soft px-4 py-2 text-xs text-negative">
                <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden="true" />
                Gap: no variant from {formatIsoDate(/** @type {string} */ (prev?.endsOn), "en-AU")} to{" "}
                {formatIsoDate(entry.startsOn, "en-AU")}
              </div>
            ) : null}
            <DataListRow
              onClick={() => onEditEntry(entry)}
              primary={
                <span className="flex items-center gap-2">
                  {variantName(variants, entry.variantId)}
                  {overlapping.has(entry.id) ? <Badge variant="destructive">Overlaps</Badge> : null}
                </span>
              }
              secondary={`${formatIsoDate(entry.startsOn, "en-AU")} – ${entry.endsOn ? formatIsoDate(entry.endsOn, "en-AU") : "open-ended"}`}
            />
          </div>
        );
      })}
    </DataList>
  );
}

/**
 * Pick two variants, see the per-pay and per-month difference — informational
 * only, no button writes anything (phases/05-income.md "Variant comparison").
 *
 * @param {{ variants: IncomeVariant[], people: Person[], payCadenceLabel: string | null }} props
 */
function ComparisonPanel({ variants, people, payCadenceLabel }) {
  const [aId, setAId] = useState(variants[0]?.id ?? "");
  const [bId, setBId] = useState(variants[1]?.id ?? variants[0]?.id ?? "");

  const a = variants.find((v) => v.id === aId) ?? null;
  const b = variants.find((v) => v.id === bId) ?? null;

  const personIds = Array.from(
    new Set([...(a ? Object.keys(a.totals.perPersonCents) : []), ...(b ? Object.keys(b.totals.perPersonCents) : [])]),
  );

  return (
    <div className="flex flex-col gap-4 rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Variant A" htmlFor="compare-a">
          <Select value={aId} onValueChange={setAId}>
            <SelectTrigger id="compare-a" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {variants.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label="Variant B" htmlFor="compare-b">
          <Select value={bId} onValueChange={setBId}>
            <SelectTrigger id="compare-b" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {variants.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>
      </div>

      {a && b ? (
        <div className="flex flex-col gap-2">
          {personIds.map((personId) => {
            const aTotals = a.totals.perPersonCents[personId];
            const bTotals = b.totals.perPersonCents[personId];
            const diff = (aTotals?.perPay ?? aTotals?.perMonth ?? 0) - (bTotals?.perPay ?? bTotals?.perMonth ?? 0);
            return (
              <div key={personId} className="flex items-center justify-between text-sm">
                <span className="text-text">{personName(people, personId)}</span>
                <Delta value={diff} kind="cents" />
              </div>
            );
          })}
          <div className="flex items-center justify-between border-t border-border pt-2 text-sm font-semibold">
            <span className="text-text">
              Total {a.totals.totalCents.perPay != null ? `per pay (${payCadenceLabel})` : "per month"}
            </span>
            <Delta
              value={
                (a.totals.totalCents.perPay ?? a.totals.totalCents.perMonth) -
                (b.totals.totalCents.perPay ?? b.totals.totalCents.perMonth)
              }
              kind="cents"
            />
          </div>
        </div>
      ) : (
        <p className="text-sm text-text-muted">Choose two variants to compare.</p>
      )}
    </div>
  );
}

/**
 * Full card: lines, totals, duplicate/edit/archive — the active variant gets
 * a tinted ring (phases/05-income.md "Variants").
 *
 * @param {{
 *   variant: IncomeVariant,
 *   isActive: boolean,
 *   people: Person[],
 *   payCadenceLabel: string | null,
 *   onEdit: () => void,
 *   onDuplicate: () => void,
 *   onArchive: () => void,
 *   onAddLine: () => void,
 *   onEditLine: (line: IncomeLine) => void,
 *   onDeleteLine: (id: string) => void,
 * }} props
 */
function VariantCard({ variant, isActive, people, payCadenceLabel, onEdit, onDuplicate, onArchive, onAddLine, onEditLine, onDeleteLine }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)",
        isActive && "ring-2 ring-(--accent)",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-text">{variant.name}</h3>
            {isActive ? <Badge variant="secondary">Active today</Badge> : null}
          </div>
          {variant.notes ? <p className="mt-1 text-xs text-text-muted">{variant.notes}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Duplicate variant" onClick={onDuplicate}>
            <CopyIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Edit variant" onClick={onEdit}>
            <PencilIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" className="text-negative" aria-label="Archive variant" onClick={onArchive}>
            <Trash2Icon />
          </Button>
        </div>
      </div>

      <div className="flex flex-col divide-y divide-border text-sm">
        {variant.lines.map((line) => (
          <div key={line.id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
            <div className="truncate text-text">
              {personName(people, line.personId)}
              {line.label ? <span className="text-text-muted"> · {line.label}</span> : null}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-text-subtle">{CADENCE_LABELS[line.cadence]}</span>
              <div className="flex shrink-0 items-center gap-1">
                <Money value={line.amountCents} className="font-medium text-text" />
                <Button size="icon-xs" variant="ghost" aria-label="Edit line" onClick={() => onEditLine(line)}>
                  <PencilIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-negative"
                  aria-label="Delete line"
                  onClick={() => onDeleteLine(line.id)}
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <Button size="sm" variant="outline" className="self-start" onClick={onAddLine}>
        <PlusIcon />
        Add line
      </Button>

      <TotalsRow totals={variant.totals} payCadenceLabel={payCadenceLabel} />
    </div>
  );
}

/**
 * Mobile: variant summaries in a list, tapping opens this sheet with the
 * full card content (phases/05-income.md "Variants").
 *
 * @param {{
 *   variant: IncomeVariant | null,
 *   isActive: boolean,
 *   people: Person[],
 *   payCadenceLabel: string | null,
 *   onOpenChange: (open: boolean) => void,
 *   onEdit: () => void,
 *   onDuplicate: () => void,
 *   onArchive: () => void,
 *   onAddLine: () => void,
 *   onEditLine: (line: IncomeLine) => void,
 *   onDeleteLine: (id: string) => void,
 * }} props
 */
function VariantDetailSheet(props) {
  const { variant, onOpenChange } = props;
  return (
    <Sheet open={variant !== null} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{variant?.name}</SheetTitle>
          <SheetDescription>{variant?.notes ?? "Lines and totals for this variant."}</SheetDescription>
        </SheetHeader>
        {variant ? (
          <div className="px-4 pb-6">
            <VariantCard {...props} variant={variant} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Named income scenarios, the calendar that resolves which one is active,
 * and a comparison tool — no allocation, no tax math, no leave-entitlement
 * tracking (phases/05-income.md "Non-goals").
 */
export function IncomePage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const queryClient = useQueryClient();

  const [variantFormOpen, setVariantFormOpen] = useState(false);
  const [editingVariant, setEditingVariant] = useState(/** @type {IncomeVariant | null} */ (null));
  const [detailVariant, setDetailVariant] = useState(/** @type {IncomeVariant | null} */ (null));
  const [lineForm, setLineForm] = useState(
    /** @type {{ variantId: string, line: IncomeLine | null } | null} */ (null),
  );
  const [scheduleForm, setScheduleForm] = useState(
    /** @type {{ entry: ScheduleEntry | null } | null} */ (null),
  );

  const variantsQuery = useQuery({
    queryKey: ["income-variants"],
    queryFn: async () => {
      const res = await api["income-variants"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {{ variants: IncomeVariant[], hasPrimaryPaySchedule: boolean }} */ (await res.json());
    },
  });

  const peopleQuery = useQuery({
    queryKey: ["people"],
    queryFn: async () => {
      const res = await api.people.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {Person[]} */ ((await res.json()).people);
    },
  });

  const scheduleQuery = useQuery({
    queryKey: ["variant-schedule"],
    queryFn: async () => {
      const res = await api["variant-schedule"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {ScheduleEntry[]} */ ((await res.json()).variantSchedule);
    },
  });

  const resolveQuery = useQuery({
    queryKey: ["income-resolve", todayIso()],
    queryFn: async () => {
      const res = await api.income.resolve.$get({ query: { on: todayIso() } });
      if (!res.ok) throw new Error(await readApiError(res));
      // Cast at the RPC boundary (phases/README.md "API"): Hono's `c.json()`
      // widens the engine's `VariantDiagnostic` discriminated union's `kind`
      // to plain `string` when it infers the route's response type.
      return /** @type {ResolveResult} */ (await res.json());
    },
  });

  const payScheduleQuery = useQuery({
    queryKey: ["pay-schedules"],
    queryFn: async () => {
      const res = await api["pay-schedules"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).paySchedules;
    },
  });

  const variants = variantsQuery.data?.variants ?? [];
  const people = peopleQuery.data ?? [];
  const schedule = scheduleQuery.data ?? [];
  const primarySchedule = (payScheduleQuery.data ?? []).find((s) => s.isPrimary) ?? null;
  const payCadenceLabel = primarySchedule ? CADENCE_LABELS[primarySchedule.cadence] : null;
  const overrideVariant = search.variant ? (variants.find((v) => v.id === search.variant) ?? null) : null;

  function invalidateIncome() {
    queryClient.invalidateQueries({ queryKey: ["income-variants"] });
    queryClient.invalidateQueries({ queryKey: ["income-resolve"] });
  }

  const createVariant = useMutation({
    mutationFn: async (/** @type {VariantFormData} */ data) => {
      const res = await api["income-variants"].$post({ json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateIncome();
      toast.success("Income variant added.");
    },
  });

  const updateVariant = useMutation({
    mutationFn: async (/** @type {{ id: string, data: VariantFormData }} */ { id, data }) => {
      const res = await api["income-variants"][":id"].$patch({ param: { id }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateIncome();
      toast.success("Income variant updated.");
    },
  });

  const duplicateVariant = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["income-variants"][":id"].duplicate.$post({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateIncome();
      toast.success("Variant duplicated.");
    },
    onError: (err) => toast.error(err.message),
  });

  const archiveVariant = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["income-variants"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateIncome();
      toast.success("Income variant archived.");
    },
    onError: (err) => toast.error(err.message),
  });

  const createLine = useMutation({
    mutationFn: async (/** @type {IncomeLineFormData & { variantId: string }} */ data) => {
      const res = await api["income-lines"].$post({ json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidateIncome,
  });

  const updateLine = useMutation({
    mutationFn: async (/** @type {{ id: string, data: IncomeLineFormData }} */ { id, data }) => {
      const res = await api["income-lines"][":id"].$patch({ param: { id }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidateIncome,
  });

  const deleteLine = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["income-lines"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidateIncome,
    onError: (err) => toast.error(err.message),
  });

  function invalidateSchedule() {
    queryClient.invalidateQueries({ queryKey: ["variant-schedule"] });
    queryClient.invalidateQueries({ queryKey: ["income-resolve"] });
  }

  const createSchedule = useMutation({
    mutationFn: async (/** @type {ScheduleFormData} */ data) => {
      const res = await api["variant-schedule"].$post({ json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidateSchedule,
  });

  const updateSchedule = useMutation({
    mutationFn: async (/** @type {{ id: string, data: ScheduleFormData }} */ { id, data }) => {
      const res = await api["variant-schedule"][":id"].$patch({ param: { id }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidateSchedule,
  });

  const deleteSchedule = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["variant-schedule"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidateSchedule,
    onError: (err) => toast.error(err.message),
  });

  useEffect(
    () =>
      registerCommands([
        {
          id: "income:add-variant",
          group: "Actions",
          label: "Add income variant",
          icon: PlusIcon,
          run: () => {
            setEditingVariant(null);
            setVariantFormOpen(true);
          },
        },
        {
          id: "income:edit-schedule",
          group: "Actions",
          label: "Edit schedule",
          icon: CalendarRangeIcon,
          run: () => setScheduleForm({ entry: null }),
        },
        {
          id: "income:compare-variants",
          group: "Actions",
          label: "Compare variants",
          icon: GitCompareIcon,
          run: () => document.getElementById("income-comparison")?.scrollIntoView({ behavior: "smooth" }),
        },
      ]),
    [],
  );

  const isLoading = variantsQuery.isLoading || peopleQuery.isLoading;

  return (
    <>
      <PageHeader
        title="Income"
        description="Named income scenarios and the calendar that says which one is active."
        actions={
          <Button
            onClick={() => {
              setEditingVariant(null);
              setVariantFormOpen(true);
            }}
          >
            <PlusIcon />
            Add variant
          </Button>
        }
      />

      <ActiveVariantBanner
        resolution={resolveQuery.data}
        isLoading={resolveQuery.isLoading}
        variants={variants}
        payCadenceLabel={payCadenceLabel}
        override={overrideVariant}
        onClearOverride={() =>
          navigate({
            to: "/income",
            search: (/** @type {{ variant?: string }} */ prev) => ({ ...prev, variant: undefined }),
          })
        }
      />

      {!payCadenceLabel && !payScheduleQuery.isLoading ? (
        <div className="rounded-(--radius-card) bg-surface-muted p-3 text-sm text-text-muted">
          No primary pay schedule is set, so per-pay figures aren&apos;t available yet — only per-month and per-year.{" "}
          <Button variant="link" className="h-auto p-0" onClick={() => navigate({ to: "/settings/pay-schedules" })}>
            Set one in Settings
          </Button>
          .
        </div>
      ) : null}

      {isLoading ? null : variants.length === 0 ? (
        <EmptyState
          icon={WalletIcon}
          title="No income variants yet"
          description="Add each income scenario the household goes through — Usual, and any parental-leave phases — starting with Usual."
          action={
            <Button onClick={() => setVariantFormOpen(true)}>
              <PlusIcon />
              Add income variant
            </Button>
          }
        />
      ) : (
        <>
          <div className="hidden gap-4 md:grid md:grid-cols-2 xl:grid-cols-3">
            {variants.map((variant) => (
              <VariantCard
                key={variant.id}
                variant={variant}
                isActive={resolveQuery.data?.variantId === variant.id}
                people={people}
                payCadenceLabel={payCadenceLabel}
                onEdit={() => {
                  setEditingVariant(variant);
                  setVariantFormOpen(true);
                }}
                onDuplicate={() => duplicateVariant.mutate(variant.id)}
                onArchive={() => archiveVariant.mutate(variant.id)}
                onAddLine={() => setLineForm({ variantId: variant.id, line: null })}
                onEditLine={(line) => setLineForm({ variantId: variant.id, line })}
                onDeleteLine={(id) => deleteLine.mutate(id)}
              />
            ))}
          </div>

          <DataList className="md:hidden">
            {variants.map((variant) => (
              <DataListRow
                key={variant.id}
                onClick={() => setDetailVariant(variant)}
                primary={
                  <span className="flex items-center gap-2">
                    {variant.name}
                    {resolveQuery.data?.variantId === variant.id ? <Badge variant="secondary">Active</Badge> : null}
                  </span>
                }
                secondary={`${variant.lines.length} line${variant.lines.length === 1 ? "" : "s"}`}
                trailing={
                  variant.totals.totalCents.perPay != null ? (
                    <Money value={variant.totals.totalCents.perPay} />
                  ) : (
                    <Money value={variant.totals.totalCents.perMonth} />
                  )
                }
              />
            ))}
          </DataList>
        </>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text">Schedule</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setScheduleForm({ entry: null })}
          disabled={variants.length === 0}
        >
          <PlusIcon />
          Add entry
        </Button>
      </div>

      {scheduleQuery.isLoading ? null : schedule.length === 0 ? (
        <EmptyState
          icon={CalendarRangeIcon}
          title="No schedule yet"
          description="Add an entry so the app knows which variant is active on any given date. Until then, every date is a gap."
        />
      ) : (
        <>
          <div className="hidden md:block">
            <ScheduleTimelineDesktop
              entries={schedule}
              variants={variants}
              onEditEntry={(entry) => setScheduleForm({ entry })}
            />
          </div>
          <div className="md:hidden">
            <ScheduleTimelineMobile
              entries={schedule}
              variants={variants}
              onEditEntry={(entry) => setScheduleForm({ entry })}
            />
          </div>
        </>
      )}

      {variants.length >= 2 ? (
        <div id="income-comparison" className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-text">Compare variants</h2>
          <ComparisonPanel variants={variants} people={people} payCadenceLabel={payCadenceLabel} />
        </div>
      ) : null}

      <VariantFormDialog
        open={variantFormOpen}
        onOpenChange={setVariantFormOpen}
        variant={editingVariant}
        submitting={createVariant.isPending || updateVariant.isPending}
        onSubmit={async (data) => {
          if (editingVariant) {
            await updateVariant.mutateAsync({ id: editingVariant.id, data });
          } else {
            await createVariant.mutateAsync(data);
          }
        }}
      />

      <IncomeLineFormDialog
        open={lineForm !== null}
        onOpenChange={(open) => !open && setLineForm(null)}
        line={lineForm?.line ?? null}
        people={people}
        submitting={createLine.isPending || updateLine.isPending}
        onSubmit={async (data) => {
          if (lineForm?.line) {
            await updateLine.mutateAsync({ id: lineForm.line.id, data });
          } else if (lineForm) {
            await createLine.mutateAsync({ variantId: lineForm.variantId, ...data });
          }
        }}
      />

      <ScheduleEntryFormDialog
        open={scheduleForm !== null}
        onOpenChange={(open) => !open && setScheduleForm(null)}
        entry={scheduleForm?.entry ?? null}
        variants={variants}
        submitting={createSchedule.isPending || updateSchedule.isPending}
        onSubmit={async (data) => {
          if (scheduleForm?.entry) {
            await updateSchedule.mutateAsync({ id: scheduleForm.entry.id, data });
          } else {
            await createSchedule.mutateAsync(data);
          }
        }}
        onDelete={
          scheduleForm?.entry
            ? () => {
                if (scheduleForm.entry) deleteSchedule.mutate(scheduleForm.entry.id);
                setScheduleForm(null);
              }
            : null
        }
      />

      <VariantDetailSheet
        variant={detailVariant}
        isActive={detailVariant !== null && resolveQuery.data?.variantId === detailVariant.id}
        people={people}
        payCadenceLabel={payCadenceLabel}
        onOpenChange={(open) => !open && setDetailVariant(null)}
        onEdit={() => {
          setEditingVariant(detailVariant);
          setDetailVariant(null);
          setVariantFormOpen(true);
        }}
        onDuplicate={() => detailVariant && duplicateVariant.mutate(detailVariant.id)}
        onArchive={() => {
          if (detailVariant) archiveVariant.mutate(detailVariant.id);
          setDetailVariant(null);
        }}
        onAddLine={() => detailVariant && setLineForm({ variantId: detailVariant.id, line: null })}
        onEditLine={(line) => detailVariant && setLineForm({ variantId: detailVariant.id, line })}
        onDeleteLine={(id) => deleteLine.mutate(id)}
      />
    </>
  );
}
